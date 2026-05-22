/**
 * End-to-end sqlite-wasm roundtrip. Exercises:
 *
 *  - The `@sqlite.org/sqlite-wasm` ESM build (node entrypoint).
 *  - `openInMemoryDatabase` → `applyMigrations` against the Rust-owned
 *    schema reached through `@opfs/core-wasm`.
 *  - `NoteRepositorySql.upsert / list / get / archive` against real
 *    rows, with id round-trips through the Crockford codec.
 *
 * No mocks. If this passes the storage layer is wired through to a
 * working SQLite handle in the same shape the OPFS-SAH writer worker
 * uses in production.
 */

import { beforeAll, describe, expect, it } from "vitest";

import { type Database, openInMemoryDatabase } from "./database.js";
import { generateRowId } from "./id.js";
import { applyMigrations } from "./migrations.js";
import { NoteRepositorySql } from "./note-repository.js";
import type { EncryptedNoteRow } from "./row.js";
import { getSchemaVersion } from "./schema.js";
import { ensureWasm } from "./wasm.js";

beforeAll(ensureWasm);

const ZERO_NONCE = new Uint8Array(12);
const make = (n: number): Uint8Array =>
	Uint8Array.from({ length: n }, (_, i) => (i * 7 + 1) & 0xff);

function row(overrides: Partial<EncryptedNoteRow> = {}): EncryptedNoteRow {
	const id = overrides.id ?? generateRowId();
	return {
		id,
		updatedDay: 20_000,
		archived: false,
		titleNonce: ZERO_NONCE,
		titleCiphertext: make(48),
		bodyNonce: ZERO_NONCE,
		bodyCiphertext: make(96),
		...overrides,
	};
}

async function freshDb(): Promise<Database> {
	return openInMemoryDatabase();
}

describe("sqlite-wasm + migrations bootstrap", () => {
	it("creates the schema and stamps the current version", async () => {
		const db = await freshDb();
		try {
			const tables = db.query(
				"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
			);
			expect(tables.map((r) => r[0])).toEqual(["notes", "schema_meta"]);
			const version = db.query(
				"SELECT value FROM schema_meta WHERE key='version'",
			)[0]?.[0];
			expect(Number(version)).toBe(getSchemaVersion());
		} finally {
			db.close();
		}
	});

	it("is idempotent — running migrations twice keeps a single row", async () => {
		const db = await freshDb();
		try {
			applyMigrations(db);
			applyMigrations(db);
			const versions = db.query(
				"SELECT value FROM schema_meta WHERE key='version'",
			);
			expect(versions).toHaveLength(1);
		} finally {
			db.close();
		}
	});

	it("refuses to migrate a DB with a malformed schema_meta.version", async () => {
		// `Number.parseInt("1corrupt")` happily returns `1`; the runner
		// must reject the value outright instead of silently coercing
		// it. Codex flagged the prior tolerant parse on PR #43.
		const db = await freshDb();
		try {
			db.exec(
				"INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				["1corrupt"],
			);
			expect(() => applyMigrations(db)).toThrow(/corrupt schema_meta/);
		} finally {
			db.close();
		}
	});

	it("refuses to migrate against an unknown future version", async () => {
		// `schema_meta.version` set to a version this binary doesn't
		// know about must surface as an error (so a downgraded build
		// won't silently corrupt a newer DB). The wasm-side
		// `pendingMigrations` returns `UnknownSchemaVersion` for that.
		const db = await freshDb();
		try {
			db.exec(
				"INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				[String(getSchemaVersion() + 1)],
			);
			expect(() => applyMigrations(db)).toThrow();
		} finally {
			db.close();
		}
	});
});

describe("NoteRepositorySql against real SQLite", () => {
	it("upsert + get round-trips ciphertext bytes verbatim", async () => {
		const db = await freshDb();
		try {
			const repo = new NoteRepositorySql(db);
			const input = row({
				titleCiphertext: make(64),
				bodyCiphertext: make(128),
			});
			repo.upsert(input);
			const fetched = repo.get(input.id);
			expect(fetched).not.toBeNull();
			expect(fetched?.id).toBe(input.id);
			expect(fetched?.titleCiphertext).toEqual(input.titleCiphertext);
			expect(fetched?.bodyCiphertext).toEqual(input.bodyCiphertext);
			expect(fetched?.titleNonce).toEqual(input.titleNonce);
			expect(fetched?.archived).toBe(false);
		} finally {
			db.close();
		}
	});

	it("get returns null for an unknown id", async () => {
		const db = await freshDb();
		try {
			const repo = new NoteRepositorySql(db);
			expect(repo.get(generateRowId())).toBeNull();
		} finally {
			db.close();
		}
	});

	it("list orders by (updated_day DESC, id DESC) and respects archive flag", async () => {
		const db = await freshDb();
		try {
			const repo = new NoteRepositorySql(db);
			const today = row({ updatedDay: 20_010 });
			const yesterday = row({ updatedDay: 20_009 });
			const archived = row({ updatedDay: 20_011 });
			repo.upsert(today);
			repo.upsert(yesterday);
			repo.upsert(archived);
			repo.archive(archived.id);

			const visible = repo.list({
				limit: 50,
				cursor: null,
				includeArchived: false,
			});
			expect(visible.rows.map((r) => r.id)).toEqual([today.id, yesterday.id]);
			expect(visible.nextCursor).toBeNull();

			const all = repo.list({
				limit: 50,
				cursor: null,
				includeArchived: true,
			});
			expect(all.rows.map((r) => r.id)).toEqual([
				archived.id,
				today.id,
				yesterday.id,
			]);
		} finally {
			db.close();
		}
	});

	it("list paginates with a deterministic (day:id) cursor", async () => {
		const db = await freshDb();
		try {
			const repo = new NoteRepositorySql(db);
			// Three rows on the same day so the secondary id-sort drives
			// the order. Use unsorted insertion to confirm the cursor
			// doesn't rely on insertion timing.
			const a = row({ updatedDay: 20_020 });
			const b = row({ updatedDay: 20_020 });
			const c = row({ updatedDay: 20_020 });
			for (const r of [c, a, b]) repo.upsert(r);

			const page1 = repo.list({
				limit: 2,
				cursor: null,
				includeArchived: false,
			});
			expect(page1.rows).toHaveLength(2);
			expect(page1.nextCursor).not.toBeNull();
			const expectedTail = page1.rows[1];
			if (!expectedTail) throw new Error("missing tail");
			expect(page1.nextCursor).toBe(
				`${expectedTail.updatedDay}:${expectedTail.id}`,
			);

			const page2 = repo.list({
				limit: 2,
				cursor: page1.nextCursor,
				includeArchived: false,
			});
			expect(page2.rows).toHaveLength(1);
			expect(page2.nextCursor).toBeNull();

			const seen = new Set([
				...page1.rows.map((r) => r.id),
				...page2.rows.map((r) => r.id),
			]);
			expect(seen).toEqual(new Set([a.id, b.id, c.id]));
		} finally {
			db.close();
		}
	});

	it("archive flips the row to archived without losing ciphertext", async () => {
		const db = await freshDb();
		try {
			const repo = new NoteRepositorySql(db);
			const r = row();
			repo.upsert(r);
			repo.archive(r.id);
			const after = repo.get(r.id);
			expect(after?.archived).toBe(true);
			expect(after?.titleCiphertext).toEqual(r.titleCiphertext);
		} finally {
			db.close();
		}
	});

	it("delete removes the row entirely (irreversible)", async () => {
		const db = await freshDb();
		try {
			const repo = new NoteRepositorySql(db);
			const r = row();
			repo.upsert(r);
			expect(repo.get(r.id)).not.toBeNull();
			repo.delete(r.id);
			expect(repo.get(r.id)).toBeNull();
			// Sibling rows survive — the bind is per-id, not a wildcard.
			const sibling = row();
			repo.upsert(sibling);
			repo.delete(r.id);
			expect(repo.get(sibling.id)).not.toBeNull();
		} finally {
			db.close();
		}
	});

	it("delete on an unknown id is a silent no-op", async () => {
		// Two tabs racing the same delete must not crash the second one;
		// SQLite's DELETE returns 0 affected rows without raising.
		const db = await freshDb();
		try {
			const repo = new NoteRepositorySql(db);
			expect(() => repo.delete(generateRowId())).not.toThrow();
		} finally {
			db.close();
		}
	});
});
