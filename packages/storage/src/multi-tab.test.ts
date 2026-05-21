/**
 * Cross-tab fan-out semantics. Exercises:
 *
 *  - `subscribeTxApplied` receives notifications posted to the named
 *    `BroadcastChannel` from any other channel instance.
 *  - The dispatcher's `broadcast` callback wires through to every
 *    page-side subscriber after a successful write.
 *  - Unsubscribe stops the channel cleanly.
 *
 * The test stands up the same data path as `repo.test.ts` but pipes
 * the dispatcher's `broadcast` into a real `BroadcastChannel` so a
 * second `subscribeTxApplied` listener (the "other tab") observes
 * the message. Node ≥ 18 ships `BroadcastChannel`, so this runs
 * unmodified under vitest.
 */

import { CryptoVault } from "@opfs/core-wasm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Connection, type PortLike } from "./connection.js";
import { openInMemoryDatabase } from "./database.js";
import { subscribeTxApplied, TX_APPLIED_CHANNEL } from "./multi-tab.js";
import { Repo } from "./repo.js";
import { WorkerClient, type WorkerLike } from "./rpc.js";
import { ensureWasm } from "./wasm.js";
import { createDispatcher } from "./worker-handlers.js";

beforeAll(ensureWasm);

function makeVault(): CryptoVault {
	const prfOutput = new Uint8Array(32).fill(0xa5);
	const prfSalt = new Uint8Array(32).fill(0x5a);
	return CryptoVault.enroll(prfOutput, prfSalt).takeVault();
}

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

// Some BroadcastChannel implementations (including Node's) hold a
// process-level ref count; close everything we open per-test so the
// vitest worker exits cleanly.
const ownedChannels: BroadcastChannel[] = [];
function ownedChannel(name: string): BroadcastChannel {
	const ch = new BroadcastChannel(name);
	ownedChannels.push(ch);
	return ch;
}
afterAll(() => {
	for (const ch of ownedChannels) ch.close();
});

describe("BroadcastChannel multi-tab fan-out", () => {
	it("constants are stable and exported", () => {
		expect(TX_APPLIED_CHANNEL).toBe("opfs-storage-tx");
	});

	it("subscribeTxApplied receives posts from another BC instance", async () => {
		const received: string[][] = [];
		const unsubscribe = subscribeTxApplied((n) => {
			if (n.kind === "tx-applied") received.push([...n.ids]);
		});
		try {
			const emitter = ownedChannel(TX_APPLIED_CHANNEL);
			emitter.postMessage({ kind: "tx-applied", ids: ["a", "b"] });
			// BC delivery is async; yield twice so the listener fires.
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
			expect(received).toEqual([["a", "b"]]);
		} finally {
			unsubscribe();
		}
	});

	it("unsubscribe stops further delivery", async () => {
		const received: string[][] = [];
		const unsubscribe = subscribeTxApplied((n) => {
			if (n.kind === "tx-applied") received.push([...n.ids]);
		});
		unsubscribe();
		const emitter = ownedChannel(TX_APPLIED_CHANNEL);
		emitter.postMessage({ kind: "tx-applied", ids: ["should-not-arrive"] });
		await new Promise((r) => setTimeout(r, 5));
		expect(received).toEqual([]);
	});

	it("worker dispatcher broadcasts after upsertNote, reaching another tab", async () => {
		const db = await openInMemoryDatabase();
		const workerChannel = ownedChannel(TX_APPLIED_CHANNEL);
		const dispatch = createDispatcher({
			openDatabase: async () => db,
			broadcast: (n) => workerChannel.postMessage(n),
		});
		const { page, worker } = makeLoopback();
		new Connection(worker, dispatch);
		const client = new WorkerClient(page);
		const repo = new Repo(client, makeVault());
		await repo.bootstrap();

		// "Other tab" subscribes via the same channel name.
		const received: string[] = [];
		const unsubscribe = subscribeTxApplied((n) => {
			if (n.kind === "tx-applied") received.push(...n.ids);
		});

		try {
			const note = await repo.upsertNote({
				title: "broadcast me",
				body: "and you'll see this",
			});
			// BC delivery is async — give the listener a turn or two
			// to fire. A real UI would refresh on the next paint.
			await new Promise((r) => setTimeout(r, 10));
			expect(received).toContain(note.id);
		} finally {
			unsubscribe();
			db.close();
		}
	});

	it("archiveNote also fans out the affected id", async () => {
		const db = await openInMemoryDatabase();
		const workerChannel = ownedChannel(TX_APPLIED_CHANNEL);
		const dispatch = createDispatcher({
			openDatabase: async () => db,
			broadcast: (n) => workerChannel.postMessage(n),
		});
		const { page, worker } = makeLoopback();
		new Connection(worker, dispatch);
		const client = new WorkerClient(page);
		const repo = new Repo(client, makeVault());
		await repo.bootstrap();

		const note = await repo.upsertNote({ title: "x", body: "y" });

		const received: string[] = [];
		const unsubscribe = subscribeTxApplied((n) => {
			if (n.kind === "tx-applied") received.push(...n.ids);
		});
		try {
			await repo.archiveNote(note.id);
			await new Promise((r) => setTimeout(r, 10));
			expect(received).toContain(note.id);
		} finally {
			unsubscribe();
			db.close();
		}
	});
});
