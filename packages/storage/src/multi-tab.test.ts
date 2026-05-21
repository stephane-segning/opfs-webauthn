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
import {
	makeTxBroadcaster,
	subscribeTxApplied,
	TX_APPLIED_CHANNEL,
} from "./multi-tab.js";
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

/**
 * Poll until `predicate()` is true or `timeoutMs` elapses. BC
 * delivery is async and on slow CI runners can take well over the
 * naive 10ms window that worked locally. Polling instead of a
 * single sleep keeps the assertion deterministic without bloating
 * the per-test budget.
 */
async function waitFor(
	predicate: () => boolean,
	timeoutMs = 1_000,
	stepMs = 5,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate() && Date.now() < deadline) {
		await new Promise((r) => setTimeout(r, stepMs));
	}
}

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
			await waitFor(() => received.length > 0);
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
		// Give BC enough time to deliver if it were going to —
		// `waitFor` exits early on truthy, so an idle wait still costs
		// the full budget. A flat 50ms is the bounded confirmation.
		await new Promise((r) => setTimeout(r, 50));
		expect(received).toEqual([]);
	});

	it("worker dispatcher broadcasts after upsertNote, reaching another tab", async () => {
		const db = await openInMemoryDatabase();
		const tx = makeTxBroadcaster();
		const dispatch = createDispatcher({
			openDatabase: async () => db,
			broadcast: tx.broadcast,
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
			await waitFor(() => received.includes(note.id));
			expect(received).toContain(note.id);
		} finally {
			unsubscribe();
			db.close();
		}
	});

	it("degrades to no-op when BroadcastChannel is missing", () => {
		// Older iOS Safari / WebView contexts lack BC. The helpers must
		// stay callable so worker bootstrap doesn't throw at module
		// load and the page-side subscribe doesn't crash the caller.
		// Codex flagged the unconditional BC construction on PR #43.
		const real = (globalThis as { BroadcastChannel?: unknown })
			.BroadcastChannel;
		(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = undefined;
		try {
			expect(() => makeTxBroadcaster().close()).not.toThrow();
			expect(() => subscribeTxApplied(() => {})()).not.toThrow();
			// The broadcaster must accept a notification silently — the
			// dispatcher always calls it after every successful write.
			const tx = makeTxBroadcaster();
			expect(() =>
				tx.broadcast({ kind: "tx-applied", ids: ["x"] }),
			).not.toThrow();
			tx.close();
		} finally {
			(globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = real;
		}
	});

	it("archiveNote also fans out the affected id", async () => {
		const db = await openInMemoryDatabase();
		const tx = makeTxBroadcaster();
		const dispatch = createDispatcher({
			openDatabase: async () => db,
			broadcast: tx.broadcast,
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
			await waitFor(() => received.includes(note.id));
			expect(received).toContain(note.id);
		} finally {
			unsubscribe();
			db.close();
		}
	});
});
