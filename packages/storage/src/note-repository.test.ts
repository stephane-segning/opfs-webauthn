import { beforeAll, describe, expect, it } from "vitest";

import type { Database } from "./database.js";
import { encodeRowId, generateRowId } from "./id.js";
import { NoteRepositorySql } from "./note-repository.js";
import type { EncryptedNoteRow, NoteRowInput } from "./row.js";
import { ensureWasm } from "./wasm.js";

// `encodeRowId` / `generateRowId` are wasm-backed; init once per file.
beforeAll(ensureWasm);

type Capture = { sql: string; bind: readonly unknown[] };

/**
 * In-memory `Database` stub. Records every `exec` for assertion and
 * lets each test pre-seed `query` results.
 */
class FakeDatabase implements Database {
	readonly execs: Capture[] = [];
	// `unknown[][]` keeps the seed values lax for fixture builders;
	// the `Database.query` signature is `SqlValue[][]`, so we cast at
	// the return boundary instead of widening that interface.
	queryResults: unknown[][] = [];
	lastQuery: Capture | null = null;

	exec(sql: string, bind: readonly unknown[] = []): void {
		this.execs.push({ sql, bind });
	}

	query(sql: string, bind: readonly unknown[] = []): never[][] {
		this.lastQuery = { sql, bind };
		return this.queryResults as never[][];
	}

	close(): void {}
}

function row(overrides: Partial<NoteRowInput> = {}): NoteRowInput {
	return {
		id: generateRowId(),
		updatedDay: 20_000,
		archived: false,
		titleNonce: new Uint8Array(12).fill(1),
		titleCiphertext: new Uint8Array(32).fill(2),
		bodyNonce: new Uint8Array(12).fill(3),
		bodyCiphertext: new Uint8Array(64).fill(4),
		...overrides,
	};
}

function rawRow(input: EncryptedNoteRow): unknown[] {
	// What the SQLite layer would return in row-array mode: id is the
	// raw byte form, archived is the int form.
	return [
		// 16 bytes mirroring the encoded id; the value isn't asserted
		// directly here — `decodeRow` re-encodes via `encodeRowId`.
		new Uint8Array(16).fill(0xab),
		input.updatedDay,
		input.archived ? 1 : 0,
		input.titleNonce,
		input.titleCiphertext,
		input.bodyNonce,
		input.bodyCiphertext,
	];
}

describe("NoteRepositorySql.upsert", () => {
	it("binds row values in column order", () => {
		const fake = new FakeDatabase();
		const repo = new NoteRepositorySql(fake);
		const input = row();
		const out = repo.upsert(input);

		expect(out).toBe(input);
		expect(fake.execs).toHaveLength(1);
		const captured = fake.execs[0];
		if (!captured) throw new Error("missing exec");
		expect(captured.sql).toContain("INSERT INTO notes");
		const [
			idBytes,
			updatedDay,
			archived,
			titleNonce,
			titleCiphertext,
			bodyNonce,
			bodyCiphertext,
		] = captured.bind;
		expect(idBytes).toBeInstanceOf(Uint8Array);
		expect(updatedDay).toBe(input.updatedDay);
		expect(archived).toBe(input.archived ? 1 : 0);
		expect(titleNonce).toEqual(input.titleNonce);
		expect(titleCiphertext).toEqual(input.titleCiphertext);
		expect(bodyNonce).toEqual(input.bodyNonce);
		expect(bodyCiphertext).toEqual(input.bodyCiphertext);
	});

	it("encodes the boolean archive flag as 0/1", () => {
		const fake = new FakeDatabase();
		const repo = new NoteRepositorySql(fake);
		repo.upsert(row({ archived: true }));
		const captured = fake.execs[0];
		if (!captured) throw new Error("missing exec");
		expect(captured.bind[2]).toBe(1);
	});
});

describe("NoteRepositorySql.archive", () => {
	it("binds the decoded id and runs the archive UPDATE", () => {
		const fake = new FakeDatabase();
		const repo = new NoteRepositorySql(fake);
		const id = generateRowId();
		repo.archive(id);
		const captured = fake.execs[0];
		if (!captured) throw new Error("missing exec");
		expect(captured.sql).toMatch(/UPDATE notes SET archived = 1/);
		expect(captured.bind[0]).toBeInstanceOf(Uint8Array);
	});
});

describe("NoteRepositorySql.list", () => {
	it("clamps the limit and selects newest-first", () => {
		const fake = new FakeDatabase();
		fake.queryResults = [];
		const repo = new NoteRepositorySql(fake);
		repo.list({ limit: 500, cursor: null, includeArchived: false });
		expect(fake.lastQuery?.sql).toMatch(/ORDER BY updated_day DESC, id DESC/);
		// limit + 1, with limit clamped to MAX (200).
		expect(fake.lastQuery?.bind.at(-1)).toBe(201);
	});

	it("returns null nextCursor when the page does not overflow", () => {
		const fake = new FakeDatabase();
		const rowInput = row();
		fake.queryResults = [rawRow(rowInput)];
		const repo = new NoteRepositorySql(fake);
		const page = repo.list({ limit: 10, cursor: null, includeArchived: false });
		expect(page.rows).toHaveLength(1);
		expect(page.nextCursor).toBeNull();
	});

	it("returns a (day:id) nextCursor when the page overflows", () => {
		const fake = new FakeDatabase();
		const first = row({ updatedDay: 20_005 });
		const second = row({ updatedDay: 20_004 });
		fake.queryResults = [rawRow(first), rawRow(second)];
		const repo = new NoteRepositorySql(fake);
		const page = repo.list({ limit: 1, cursor: null, includeArchived: false });
		expect(page.rows).toHaveLength(1);
		expect(page.nextCursor).toMatch(/^20005:[0-9A-Z]{26}$/);
	});

	it("binds the cursor tuple for deterministic paging", () => {
		const fake = new FakeDatabase();
		const repo = new NoteRepositorySql(fake);
		const lastId = generateRowId();
		repo.list({
			limit: 5,
			cursor: `19999:${lastId}`,
			includeArchived: false,
		});
		const [day1, day2, idBytes] = fake.lastQuery?.bind ?? [];
		expect(day1).toBe(19_999);
		expect(day2).toBe(19_999);
		expect(idBytes).toBeInstanceOf(Uint8Array);
	});

	it("rejects a malformed cursor", () => {
		const fake = new FakeDatabase();
		const repo = new NoteRepositorySql(fake);
		expect(() =>
			repo.list({ limit: 10, cursor: "garbage", includeArchived: false }),
		).toThrow(/malformed cursor/);
	});

	it("hides archived rows by default and exposes them on opt-in", () => {
		const fake = new FakeDatabase();
		const repo = new NoteRepositorySql(fake);
		repo.list({ limit: 10, cursor: null, includeArchived: false });
		expect(fake.lastQuery?.sql).toContain("AND archived = 0");
		repo.list({ limit: 10, cursor: null, includeArchived: true });
		expect(fake.lastQuery?.sql).not.toContain("AND archived = 0");
	});

	it("encodes the row id bytes back to Crockford on the way out", () => {
		const fake = new FakeDatabase();
		const expectedId = encodeRowId(new Uint8Array(16).fill(0xab));
		fake.queryResults = [rawRow(row())];
		const repo = new NoteRepositorySql(fake);
		const page = repo.list({ limit: 10, cursor: null, includeArchived: false });
		expect(page.rows[0]?.id).toBe(expectedId);
	});
});
