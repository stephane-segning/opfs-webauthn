/**
 * Full-stack `Repo` round-trip. Wires:
 *
 *   Repo (plaintext + RowCodec + CryptoVault)
 *     ↕ WorkerClient
 *     ↕ LoopbackWorker  ← page ↔ worker boundary, in-process
 *     ↕ Connection
 *     ↕ createDispatcher
 *     ↕ NoteRepositorySql
 *     ↕ openInMemoryDatabase (real sqlite-wasm)
 *
 * Real `CryptoVault.enroll` + real wasm AAD. The only thing missing
 * vs production is the actual postMessage hop and the OPFS-SAH VFS.
 * The goal is to catch any drift between the page-side encryption
 * and the worker-side storage path before it ships.
 */

import { CryptoVault } from "@opfs/core-wasm";
import { beforeAll, describe, expect, it } from "vitest";

import { Connection, type PortLike } from "./connection.js";
import { type Database, openInMemoryDatabase } from "./database.js";
import { Repo } from "./repo.js";
import { WorkerClient, type WorkerLike } from "./rpc.js";
import { ensureWasm } from "./wasm.js";
import { createDispatcher } from "./worker-handlers.js";

beforeAll(ensureWasm);

/**
 * In-memory MessageChannel-like split. The page side gets a
 * `WorkerLike`, the worker side gets a `PortLike`; together they
 * shuttle envelopes via a microtask hop so we don't collapse async
 * ordering (vitest's `expect(...).resolves` relies on the
 * event-loop turning between send and receive).
 */
function makeLoopback(): { page: WorkerLike; worker: PortLike } {
	const pageListeners = new Set<(event: MessageEvent) => void>();
	const workerListeners = new Set<(event: MessageEvent) => void>();
	const hop = (fn: () => void): void => {
		queueMicrotask(fn);
	};

	const page: WorkerLike = {
		postMessage: (data) => {
			hop(() => {
				const ev = { data } as MessageEvent;
				for (const l of workerListeners) l(ev);
			});
		},
		addEventListener: (type, listener) => {
			if (type === "message") pageListeners.add(listener as never);
		},
		removeEventListener: (type, listener) => {
			if (type === "message") pageListeners.delete(listener as never);
		},
		close: () => {
			pageListeners.clear();
			workerListeners.clear();
		},
	};

	const worker: PortLike = {
		postMessage: (data) => {
			hop(() => {
				const ev = { data } as MessageEvent;
				for (const l of pageListeners) l(ev);
			});
		},
		addEventListener: (_type, listener) => {
			workerListeners.add(listener);
		},
		removeEventListener: (_type, listener) => {
			workerListeners.delete(listener);
		},
		start: () => {},
		close: () => {
			workerListeners.clear();
		},
	};

	return { page, worker };
}

/**
 * Attach a fresh page ↔ worker stack to an existing `Database`. Each
 * call mints a new `Repo` (and therefore a new `RowCodec`/`vault`)
 * over the same underlying SQLite rows — exactly what "tab reopens
 * after lock" looks like in production.
 */
function attachStack(db: Database, vault: CryptoVault): Repo {
	const dispatch = createDispatcher({
		openDatabase: async () => db,
		broadcast: () => {
			/* not exercised here — see multi-tab.test.ts */
		},
	});
	const { page, worker } = makeLoopback();
	new Connection(worker, dispatch);
	const client = new WorkerClient(page);
	return new Repo(client, vault);
}

function makeVault(): CryptoVault {
	// PRF outputs are 32-byte HKDF-derived material in production;
	// any 32-byte sequence drives `enroll` correctly because the
	// vault treats it as opaque IKM. Same for the salt.
	const prfOutput = new Uint8Array(32).fill(0xa5);
	const prfSalt = new Uint8Array(32).fill(0x5a);
	return CryptoVault.enroll(prfOutput, prfSalt).takeVault();
}

describe("Repo end-to-end through WorkerClient + sqlite-wasm", () => {
	it("upsert / getNote / listNotes round-trips plaintext through ciphertext", async () => {
		const db = await openInMemoryDatabase();
		try {
			const repo = attachStack(db, makeVault());
			await repo.bootstrap();
			const created = await repo.upsertNote({
				title: "first",
				body: "hello world",
			});
			expect(created.id).toHaveLength(26);

			const fetched = await repo.getNote(created.id);
			expect(fetched).not.toBeNull();
			expect(fetched?.title).toBe("first");
			expect(fetched?.body).toBe("hello world");

			const page = await repo.listNotes();
			expect(page.notes).toHaveLength(1);
			expect(page.notes[0]?.title).toBe("first");
		} finally {
			db.close();
		}
	});

	it("archived notes drop off the default list but stay reachable by id", async () => {
		const db = await openInMemoryDatabase();
		try {
			const repo = attachStack(db, makeVault());
			await repo.bootstrap();
			const note = await repo.upsertNote({ title: "doomed", body: "x" });
			await repo.archiveNote(note.id);

			const visible = await repo.listNotes();
			expect(visible.notes).toEqual([]);

			const direct = await repo.getNote(note.id);
			expect(direct?.archived).toBe(true);
			expect(direct?.title).toBe("doomed");
		} finally {
			db.close();
		}
	});

	it("deleteNote removes the row so getNote / listNotes no longer find it", async () => {
		const db = await openInMemoryDatabase();
		try {
			const repo = attachStack(db, makeVault());
			await repo.bootstrap();
			const a = await repo.upsertNote({ title: "doomed", body: "x" });
			const b = await repo.upsertNote({ title: "spared", body: "y" });

			await repo.deleteNote(a.id);

			expect(await repo.getNote(a.id)).toBeNull();
			const page = await repo.listNotes();
			expect(page.notes.map((n) => n.id)).toEqual([b.id]);
		} finally {
			db.close();
		}
	});

	it("deleteNote against an unknown id resolves without error", async () => {
		const db = await openInMemoryDatabase();
		try {
			const repo = attachStack(db, makeVault());
			await repo.bootstrap();
			// Mirror the cross-tab race: id never inserted, delete is a no-op.
			await expect(
				repo.deleteNote("00000000000000000000000000"),
			).resolves.toBeUndefined();
		} finally {
			db.close();
		}
	});

	it("getNote returns null for an unknown id", async () => {
		const db = await openInMemoryDatabase();
		try {
			const repo = attachStack(db, makeVault());
			await repo.bootstrap();
			// 26 valid Crockford chars that this DB has never seen.
			expect(await repo.getNote("00000000000000000000000000")).toBeNull();
		} finally {
			db.close();
		}
	});

	it("a fresh Repo reopens the same DB and reads back its rows", async () => {
		// The vault is what the user unlocks per session; the DEK
		// inside is deterministic from `(prfOutput, prfSalt)` only
		// when reusing the same `(wrappedDek, wrapNonce)` pair, so we
		// build the second vault via `unlock` against the persisted
		// material the first `enroll` produced. This mirrors how a
		// browser tab "reopens" the vault after a hard reload.
		const prfOutput = new Uint8Array(32).fill(0xc3);
		const prfSalt = new Uint8Array(32).fill(0x3c);
		const enroll = CryptoVault.enroll(prfOutput, prfSalt);
		const wrappedDek = enroll.wrappedDek;
		const wrapNonce = enroll.wrapNonce;
		const vault1 = enroll.takeVault();

		const db = await openInMemoryDatabase();
		try {
			const writer = attachStack(db, vault1);
			await writer.bootstrap();
			const created = await writer.upsertNote({
				title: "survive me",
				body: "across sessions",
			});

			const vault2 = CryptoVault.unlock(
				prfOutput,
				prfSalt,
				wrappedDek,
				wrapNonce,
			);
			const reader = attachStack(db, vault2);
			await reader.bootstrap();
			const fetched = await reader.getNote(created.id);
			expect(fetched?.title).toBe("survive me");
			expect(fetched?.body).toBe("across sessions");
		} finally {
			db.close();
		}
	});
});
