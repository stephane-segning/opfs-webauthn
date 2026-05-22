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
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

/**
 * `navigator.locks` polyfill, scoped to this test file.
 *
 * CI runs on Node 20 which does *not* ship `navigator.locks` (Node
 * gained it in 22). The `supportsLeaderElection()` test needs the
 * detection to return `true` on every Node version the project's CI
 * exercises, so we install a minimal stub matching the spec's
 * `LockManager.request` signature. The stub is only consulted by the
 * feature-detection test — every other test injects a `FakeLockManager`
 * explicitly — but `supportsLeaderElection` reads `navigator.locks`
 * directly so the global has to exist.
 *
 * Restored in `afterAll` so we don't leak the polyfill into adjacent
 * test files (`test-setup.ts` is shared; per-file shims must clean up).
 */
type LocksGlobal = {
	navigator?: { locks?: unknown };
};
type PolyfillState = {
	addedNavigator: boolean;
	installedLocks: boolean;
};
const polyfill: PolyfillState = {
	addedNavigator: false,
	installedLocks: false,
};
beforeAll(() => {
	const g = globalThis as LocksGlobal;
	if (!g.navigator) {
		// Defining as a plain data property keeps the cleanup path
		// uncomplicated (no descriptor juggling on platforms where the
		// real `Navigator` exposes `locks` as a getter).
		Object.defineProperty(globalThis, "navigator", {
			value: {},
			writable: true,
			configurable: true,
		});
		polyfill.addedNavigator = true;
	}
	const nav = g.navigator as { locks?: unknown };
	if (!nav.locks) {
		// Stub matches the spec's request signature minimally — the
		// `supportsLeaderElection()` test only checks truthiness, and
		// every other test in this file injects a `FakeLockManager`
		// rather than calling through to `navigator.locks`.
		try {
			Object.defineProperty(nav, "locks", {
				value: { request: () => new Promise(() => {}) },
				writable: true,
				configurable: true,
			});
			polyfill.installedLocks = true;
		} catch {
			// On Node ≥ 22 `navigator.locks` is a non-configurable
			// accessor — the host platform already satisfies the
			// feature gate so we don't need to polyfill, and a failed
			// install means the original is still in place.
		}
	}
});
afterAll(() => {
	if (polyfill.installedLocks) {
		const nav = (globalThis as LocksGlobal).navigator as
			| { locks?: unknown }
			| undefined;
		if (nav) {
			try {
				delete nav.locks;
			} catch {
				// best-effort cleanup; nothing else in the test suite
				// reads `navigator.locks` directly
			}
		}
	}
	if (polyfill.addedNavigator) {
		try {
			delete (globalThis as { navigator?: unknown }).navigator;
		} catch {
			// best-effort
		}
	}
});

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
		// Node ≥ 22 ships `navigator.locks`; on Node 20 (the project's
		// CI runtime) the `beforeAll` above installs a minimal stub so
		// detection passes deterministically. The check we're locking
		// in is "both APIs present → true" — changing either branch is
		// a behaviour change worth re-reading the ADR for.
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

	it("close() releases the Web Lock so a queued tab is promoted to leader", async () => {
		// Reproduces the bug where the leader's lock callback returned
		// a never-resolving promise with no externally callable
		// resolver. `Repo.close()` (and therefore `WorkerClient.
		// terminate()` and `transport.close()`) would tear down the
		// page-side state while the lock stayed held until tab unload.
		// Every other tab on the origin queued on `opfs-db-writer`
		// would then hang forever in `createRepo()`.
		const db = await openDb();
		const { worker: workerA } = makeWriter(db);
		const { worker: workerB } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelSuffix = `close-releases-${Math.random()}`;

		// Tab A wins the lock.
		const depsA = makeDeps(channelSuffix, locks, "leaderA", () => workerA);
		const tabA = createLeaderTransport(depsA);
		await tabA.whenReady;

		// Tab B queues behind A — its writerFactory only runs once it
		// becomes leader, which requires A to release.
		let tabBBecameLeader = false;
		const depsB = makeDeps(channelSuffix, locks, "leaderB", () => {
			tabBBecameLeader = true;
			return workerB;
		});
		const tabB = createLeaderTransport(depsB);

		// Closing A must release the lock without us calling
		// `releaseHeld()` manually — `close()` is the only signal in
		// production.
		tabA.close();

		try {
			await tabB.whenReady;
			expect(tabBBecameLeader).toBe(true);
		} finally {
			tabB.close();
		}
	});

	it("close() before readiness rejects whenReady instead of hanging", async () => {
		// A transport that's torn down before it ever pairs (e.g.
		// `createRepo` aborting after a parallel failure) must surface
		// the close as a rejection on `whenReady`. Resolving it would
		// claim "we're paired" to the caller; never settling would
		// leave `createRepo` awaiting forever.
		const locks = new FakeLockManager();
		// Pre-occupy the lock so the new transport stays queued.
		const blocker = createLeaderTransport(
			makeDeps(
				`blocked-${Math.random()}`,
				locks,
				"blocker",
				// Blocker doesn't need a real writer; it just needs to
				// hold the lock. We give it a no-op stub WorkerLike.
				() => ({
					postMessage: () => {},
					addEventListener: (() => {}) as WorkerLike["addEventListener"],
					removeEventListener: (() => {}) as WorkerLike["removeEventListener"],
					close: () => {},
				}),
			),
		);
		await blocker.whenReady;

		const queued = createLeaderTransport(
			makeDeps(`blocked-${Math.random()}`, locks, "queued", () => {
				throw new Error("queued transport should not become leader");
			}),
		);

		// Close before B is granted — whenReady must reject.
		queued.close();
		await expect(queued.whenReady).rejects.toThrow(/closed before ready/);

		blocker.close();
	});

	it("a lock request that rejects surfaces as whenReady rejection", async () => {
		// `navigator.locks.request` can reject with SecurityError or
		// InvalidStateError (non-secure context, detached document).
		// Before the fix, the `.catch` only emitted an `error` event
		// and rethrew into an unobserved promise; `whenReady` never
		// settled and `createRepo` hung indefinitely.
		const rejectingLocks: LockManagerLike = {
			request: () => Promise.reject(new Error("SecurityError: stub")),
		};
		const channelSuffix = `reject-${Math.random()}`;
		const transport = createLeaderTransport({
			locks: rejectingLocks,
			newBroadcastChannel: (name) =>
				new BroadcastChannel(`${name}-${channelSuffix}`),
			writerFactory: () => {
				throw new Error("writerFactory must not run if the lock rejects");
			},
			newLeaderId: counterIds("rej"),
			newClientId: counterIds("rej-client"),
		});
		await expect(transport.whenReady).rejects.toThrow(/SecurityError/);
		transport.close();
	});

	it("clients only resolve whenReady after the leader has acked the pairing", async () => {
		// Guards finding #4: BC delivery is async + non-replaying, so
		// the leader-elected → pair-request → bridge-open chain races
		// the client's "I have a pair channel now, mark ready" code.
		// The pair-ack closes that race: clients hold `whenReady` open
		// until the leader confirms its end of the per-pair BC is up.
		const db = await openDb();
		const { worker } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelSuffix = `ack-${Math.random()}`;
		const vault = makeVault();

		const depsA = makeDeps(channelSuffix, locks, "leaderA", () => worker);
		const tabA = createLeaderTransport(depsA);
		await tabA.whenReady;

		const depsB = makeDeps(channelSuffix, locks, "tabB", () => {
			throw new Error("tabB must not become leader");
		});
		const tabB = createLeaderTransport(depsB);
		// tabB resolves whenReady only after pair-ack → first RPC
		// reaches the leader. If the ack handshake regresses, this
		// will either hang (handler dropped the envelope) or resolve
		// before bootstrap can complete.
		await tabB.whenReady;
		const clientB = new WorkerClient(tabB);
		const repoB = new Repo(clientB, vault);
		await repoB.bootstrap();
		// A round-trip after readiness confirms the leader's bridge is
		// genuinely listening — the test we'd otherwise lose without
		// pair-ack.
		const note = await repoB.upsertNote({
			title: "ack-gated",
			body: "x",
		});
		const fetched = await repoB.getNote(note.id);
		expect(fetched?.title).toBe("ack-gated");

		tabA.close();
		tabB.close();
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
