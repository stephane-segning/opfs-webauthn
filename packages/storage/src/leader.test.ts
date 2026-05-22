/**
 * Leader-election transport tests (ADR 0006 fallback tier).
 *
 * Stands up the same in-process loopback shape `repo.test.ts` uses
 * for the writer side, then layers `createLeaderTransport` on top so
 * we exercise the production pair-request / handover path without
 * touching real Web Locks or real browser BroadcastChannel.
 *
 * Why a fake `LockManager`: vitest runs under Node, which since
 * v22 ships `navigator.locks`, but a single process means every
 * simulated "tab" shares one LockManager — fine for a single-leader
 * test, awkward for handover where we want to *force* a specific
 * tab to win the lock first. The fake `FakeLockManager` lets each
 * test decide the queue ordering explicitly.
 *
 * Why a real `BroadcastChannel`: Node ≥ 18 ships one; the production
 * leader uses BC for discovery and we want that wiring exercised
 * end-to-end. We give each test its own BC name suffix to avoid
 * cross-test bleed.
 */

import { CryptoVault } from "@opfs/core-wasm";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { Connection, type PortLike } from "./connection.js";
import { openInMemoryDatabase } from "./database.js";
import {
	createLeaderTransport,
	type LeaderDeps,
	type LockManagerLike,
	supportsLeaderElection,
} from "./leader.js";
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

/**
 * Identical to `repo.test.ts`'s loopback. We need a `WorkerLike`
 * that the leader-election test can pass to `writerFactory`: a
 * leader spawns "the writer" via this factory, so we stand up an
 * in-memory DB + dispatcher behind a loopback `WorkerLike`. Each
 * call mints a fresh stack — exactly what a new-leader handover
 * looks like in production (the old leader's worker is gone, the
 * new one opens its own).
 */
function makeWriter(db: Awaited<ReturnType<typeof openInMemoryDatabase>>): {
	worker: WorkerLike;
	tx: { broadcast: () => void };
} {
	const pageListeners = new Set<(event: MessageEvent) => void>();
	const workerListeners = new Set<(event: MessageEvent) => void>();
	const hop = (fn: () => void): void => {
		queueMicrotask(fn);
	};
	const tx = { broadcast: () => {} };
	const dispatch = createDispatcher({
		openDatabase: async () => db,
		broadcast: tx.broadcast,
	});
	const port: PortLike = {
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
	new Connection(port, dispatch);
	const worker: WorkerLike = {
		postMessage: (data) => {
			hop(() => {
				const ev = { data } as MessageEvent;
				for (const l of workerListeners) l(ev);
			});
		},
		addEventListener: ((type: string, listener: unknown) => {
			if (type === "message") {
				pageListeners.add(listener as (event: MessageEvent) => void);
			}
		}) as WorkerLike["addEventListener"],
		removeEventListener: ((type: string, listener: unknown) => {
			if (type === "message") {
				pageListeners.delete(listener as (event: MessageEvent) => void);
			}
		}) as WorkerLike["removeEventListener"],
		close: () => {
			pageListeners.clear();
			workerListeners.clear();
		},
	};
	return { worker, tx };
}

/**
 * Hand-rolled lock manager. Each test instantiates one, then every
 * simulated "tab" calls `request()` against it. The lock is granted
 * FIFO; releasing it (by resolving the held promise via
 * `release()`) advances the queue. This matches the spec semantics
 * Web Locks gives us in a real browser.
 */
class FakeLockManager implements LockManagerLike {
	#held: { release: () => void } | null = null;
	#queue: Array<() => void> = [];

	request<T>(
		_name: string,
		_options: { mode: "exclusive" },
		callback: () => Promise<T>,
	): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const grant = (): void => {
				const cbPromise = callback();
				const release = (): void => {
					this.#held = null;
					const next = this.#queue.shift();
					if (next) next();
				};
				this.#held = { release };
				// When the callback's promise settles, release the lock.
				// In production the callback never resolves until the tab
				// closes; in tests we keep the same shape but expose a
				// `releaseHeld()` so the test driver can simulate closure.
				cbPromise.then(
					(v) => {
						release();
						resolve(v);
					},
					(err) => {
						release();
						reject(err);
					},
				);
			};
			if (!this.#held) {
				grant();
			} else {
				this.#queue.push(grant);
			}
		});
	}

	/**
	 * Simulate the leader tab closing — releases the lock and lets
	 * the next queued requester (if any) become the new leader. The
	 * never-resolving promise from the production callback never
	 * settles on its own, so this is the only way to advance.
	 */
	releaseHeld(): void {
		const held = this.#held;
		if (!held) return;
		// We can't reach into the callback's promise to reject it from
		// the outside, but we can simulate release by rotating the
		// queue: pretend the callback resolved.
		this.#held = null;
		const next = this.#queue.shift();
		if (next) next();
		// Note: the original lockPromise stays pending. That's fine —
		// production code does the same (the lock outlives the tab).
		void held;
	}
}

/**
 * Counter-based ids so test assertions can predict announce/pair ids.
 * Real `crypto.randomUUID` would force every test to scrape ids out
 * of message events to compare them — unnecessary indirection here.
 */
function counterIds(prefix: string): () => string {
	let n = 0;
	return () => `${prefix}-${++n}`;
}

/**
 * Wait until `predicate()` is truthy or the deadline passes. Same
 * shape as `multi-tab.test.ts` — leader election is async-by-design
 * and a polling check is the deterministic way to assert on it.
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

const openDbs: Array<{ close: () => void }> = [];
afterEach(() => {
	while (openDbs.length) {
		const db = openDbs.pop();
		if (db) {
			try {
				db.close();
			} catch {
				// ignore
			}
		}
	}
});

async function openDb(): Promise<
	Awaited<ReturnType<typeof openInMemoryDatabase>>
> {
	const db = await openInMemoryDatabase();
	openDbs.push(db);
	return db;
}

/**
 * Build a deps bundle wired against a FakeLockManager. Tests use a
 * shared `channelSuffix` so every tab in one test sees the same
 * discovery + pair channels (BC is name-scoped same-origin), but
 * tests in different `it` blocks get fresh suffixes so they don't
 * bleed. The leader transport opens both a discovery channel
 * (`opfs-leader`) and per-pair channels (`opfs-pair-{leaderId}-
 * {clientId}`); we rewrite *every* channel name to carry the
 * suffix so the entire wire is namespaced.
 */
function makeDeps(
	channelSuffix: string,
	locks: FakeLockManager,
	idPrefix: string,
	writerFactoryOverride?: () => WorkerLike,
): LeaderDeps {
	return {
		locks,
		newBroadcastChannel: (name) =>
			new BroadcastChannel(`${name}-${channelSuffix}`),
		writerFactory:
			writerFactoryOverride ??
			(() => {
				throw new Error("writerFactory called but not provided");
			}),
		newLeaderId: counterIds(idPrefix),
		newClientId: counterIds(`${idPrefix}-client`),
	};
}

describe("Web-Locks leader-election transport", () => {
	it("feature detection follows the host platform", () => {
		// Node ≥ 22 ships navigator.locks + BroadcastChannel, so this
		// returns true under vitest. The detection rule itself is what
		// we want to lock in (changing either branch is a behaviour
		// change worth re-reading the ADR for).
		expect(supportsLeaderElection()).toBe(true);
	});

	it("single tab elects itself, hosts the writer, and round-trips through it", async () => {
		const db = await openDb();
		const { worker } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelName = `opfs-leader-test-${Math.random()}`;

		const deps = makeDeps(channelName, locks, "leaderA", () => worker);
		const transport = createLeaderTransport(deps);
		try {
			await transport.whenReady;
			const client = new WorkerClient(transport);
			const repo = new Repo(client, makeVault());
			await repo.bootstrap();
			const note = await repo.upsertNote({
				title: "single-tab leader",
				body: "wrote me",
			});
			const fetched = await repo.getNote(note.id);
			expect(fetched?.title).toBe("single-tab leader");
		} finally {
			transport.close();
		}
	});

	it("a second client pairs with the existing leader over the discovery channel", async () => {
		// Two tabs sharing one DB (one writer worker, exercised through
		// two `Connection`s — one per pair). The leader tab hosts the
		// writer; the client tab's RPC reaches that same writer via the
		// per-pair `BroadcastChannel` set up in `pair-request`. Both
		// page-side `Repo`s share the same `CryptoVault` because in
		// production the vault lives on the page (key-blind worker), so
		// every page-side instance of the same vault decrypts every
		// row encrypted by any peer.
		const db = await openDb();
		const { worker: writerWorker } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelSuffix = `pair-${Math.random()}`;
		const vault = makeVault();

		// Tab A starts first and wins the lock → becomes leader.
		const depsA = makeDeps(channelSuffix, locks, "leaderA", () => writerWorker);
		const tabA = createLeaderTransport(depsA);
		await tabA.whenReady;

		// Tab B starts after the announce. BroadcastChannel doesn't
		// replay messages, so B relies on its construction-time
		// `leader-query` probe to elicit a fresh `leader-elected` from
		// the running leader.
		const depsB = makeDeps(channelSuffix, locks, "tabB", () => {
			throw new Error("tabB must not become leader; leader is tab A");
		});
		const tabB = createLeaderTransport(depsB);

		try {
			await tabB.whenReady;

			const clientA = new WorkerClient(tabA);
			const clientB = new WorkerClient(tabB);
			const repoA = new Repo(clientA, vault);
			const repoB = new Repo(clientB, vault);
			await repoA.bootstrap();
			await repoB.bootstrap();

			const note = await repoA.upsertNote({
				title: "from tab A",
				body: "leader wrote",
			});
			// B asks the leader for it — RPC flows through the paired
			// BroadcastChannel, not the discovery channel.
			const fetched = await repoB.getNote(note.id);
			expect(fetched?.title).toBe("from tab A");
		} finally {
			tabA.close();
			tabB.close();
		}
	});

	it("on leader handover, in-flight requests succeed via the new leader", async () => {
		// Shared DB across both writer workers — in production, both
		// leaders open the same OPFS-backed sqlite database, so a row
		// inserted by leader A is visible to leader B when B takes
		// over. The page-side `CryptoVault` is also shared because in
		// production both `Repo`s live in the same browser page (the
		// page survives the worker handover; the page-held vault key
		// keeps decrypting rows written by the old leader). Different
		// vaults would simulate two separate logins, which is not what
		// the handover test exercises.
		const db = await openDb();
		const { worker: workerA } = makeWriter(db);
		const { worker: workerB } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelSuffix = `handover-${Math.random()}`;
		const vault = makeVault();

		// Tab A wins first.
		const depsA = makeDeps(channelSuffix, locks, "leaderA", () => workerA);
		const tabA = createLeaderTransport(depsA);
		await tabA.whenReady;

		// Tab B queues for the lock; B will only become leader after A
		// releases. While A still holds the lock, B's transport buffers
		// any outgoing envelope in its in-flight map.
		const depsB = makeDeps(channelSuffix, locks, "leaderB", () => workerB);
		const tabB = createLeaderTransport(depsB);

		// Bootstrap A first so the DB schema is in place before either
		// transport issues writes.
		const clientA = new WorkerClient(tabA);
		const repoA = new Repo(clientA, vault);
		await repoA.bootstrap();
		const initial = await repoA.upsertNote({
			title: "before handover",
			body: "from A",
		});

		// Kick off a request on B that's "in flight". B is still
		// queued behind A on the lock, so its transport has no pair
		// yet and buffers the envelope. When A releases, B wins,
		// becomes leader (its writerFactory runs), self-pairs, and
		// replays the buffered envelope.
		const clientB = new WorkerClient(tabB);
		const repoB = new Repo(clientB, vault);
		const bootstrapPromise = repoB.bootstrap();

		// Simulate A closing: tear A's transport down, then release
		// the lock so B is granted. Order matters — closing A first
		// stops its discovery listener from seeing the dying
		// `leader-elected` echo, and releasing afterwards is what
		// hands the lock to B.
		tabA.close();
		locks.releaseHeld();

		try {
			await bootstrapPromise; // must resolve via the new leader
			const fetched = await repoB.getNote(initial.id);
			expect(fetched?.title).toBe("before handover");

			// And new writes work straight through B.
			const second = await repoB.upsertNote({
				title: "after handover",
				body: "from B",
			});
			expect(second.id).toHaveLength(26);
		} finally {
			tabB.close();
		}
	});

	it("close() detaches BroadcastChannel + ports cleanly", async () => {
		const db = await openDb();
		const { worker } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelName = `opfs-leader-test-${Math.random()}`;

		const deps = makeDeps(channelName, locks, "leaderC", () => worker);
		const transport = createLeaderTransport(deps);
		await transport.whenReady;

		expect(() => transport.close()).not.toThrow();
		// Idempotent — calling again is a no-op.
		expect(() => transport.close()).not.toThrow();

		// Posting after close drops silently rather than throwing —
		// the caller may be racing teardown with an unrelated `send`.
		expect(() =>
			transport.postMessage({ id: 999, request: { kind: "ping" } }),
		).not.toThrow();
	});

	// Wait briefly so the polling helper is exercised when handover
	// timing matters. Kept as a sanity test rather than reaching into
	// the BC delivery internals.
	it("polling helper expires deterministically on a false predicate", async () => {
		const start = Date.now();
		await waitFor(() => false, 30);
		expect(Date.now() - start).toBeGreaterThanOrEqual(25);
	});
});
