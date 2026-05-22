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

	it("propagates writer crashes to pending RPCs and frees the lock", async () => {
		// Fix #1 regression. `LeaderBridge` used to listen only on
		// `"message"`; a writer that loaded and then died (or never
		// loaded at all — Worker script error) emits only `"error"`,
		// so outstanding `bootstrap` calls would hang forever and the
		// next-tier fallback never engaged.
		//
		// We build a writer that exposes a `triggerError` hook so the
		// test can synthesize the failure deterministically.
		const locks = new FakeLockManager();
		const channelSuffix = `writer-crash-${Math.random()}`;

		// Stub writer: never responds to RPC, just collects listeners
		// so the test can dispatch an `error` event by hand.
		const writerErrorListeners = new Set<(event: Event) => void>();
		const stubWriter: WorkerLike = {
			postMessage: () => {
				// Black hole — we never want responses; the crash should
				// short-circuit the pending RPC before any response is
				// produced.
			},
			addEventListener: ((type: string, listener: unknown) => {
				if (type === "error") {
					writerErrorListeners.add(listener as (event: Event) => void);
				}
				// message listener is registered by the bridge but we
				// never dispatch one; that's the bug being tested.
			}) as WorkerLike["addEventListener"],
			removeEventListener: ((type: string, listener: unknown) => {
				if (type === "error") {
					writerErrorListeners.delete(listener as (event: Event) => void);
				}
			}) as WorkerLike["removeEventListener"],
			close: () => {
				writerErrorListeners.clear();
			},
		};

		const deps = makeDeps(
			channelSuffix,
			locks,
			"crashLeader",
			() => stubWriter,
		);
		const transport = createLeaderTransport(deps);
		try {
			await transport.whenReady;
			const client = new WorkerClient(transport);
			// Fire off a request — it'll sit in-flight because stubWriter
			// never responds. The crash should reject it.
			const pending = client.send({ kind: "bootstrap" });
			// Yield once so the envelope reaches the bridge before we
			// trigger the crash.
			await new Promise((r) => setTimeout(r, 10));
			// Dispatch the writer-error: in production this is the
			// `Worker`'s native `"error"` event (script load failure,
			// uncaught exception). All listeners should fire.
			const event = new Event("error");
			for (const l of writerErrorListeners) l(event);

			await expect(pending).rejects.toThrow();
		} finally {
			transport.close();
		}

		// And the lock must be free now — a fresh transport should be
		// able to acquire it without the original being explicitly
		// closed beyond what `handleWriterFailure` did.
		const tabAfter = createLeaderTransport(
			makeDeps(
				`writer-crash-after-${Math.random()}`,
				locks,
				"afterCrash",
				() => {
					// Provide a valid writer for the follow-on tab.
					return makeWriterStub();
				},
			),
		);
		try {
			await tabAfter.whenReady;
		} finally {
			tabAfter.close();
		}
	});

	it("replays in-flight RPCs only after the new leader acks the pair", async () => {
		// Fix #2 regression. `attachPair` used to replay synchronously,
		// but BC delivery is async + non-replaying: a replay before the
		// leader-side bridge subscribed to the per-pair BC would post
		// into the void.
		//
		// We force the ordering: tab A becomes leader, then a request
		// from tab B (queued behind A on the lock) sits in `inFlight`.
		// We then close A and release the lock so B becomes leader. B
		// is its own writer (self-pair, synchronous), so the request
		// must surface in the writer post-handover. If the replay-on-
		// ack path regresses, the request will be lost in the gap.
		const db = await openDb();
		const { worker: workerB } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelSuffix = `replay-${Math.random()}`;
		const vault = makeVault();

		// Pre-occupy the lock with a blocker that doesn't actually need
		// a writer to do anything useful — its job is to hold the lock
		// while tabB queues envelopes.
		const blocker = createLeaderTransport(
			makeDeps(channelSuffix, locks, "blocker", () => makeWriterStub()),
		);
		await blocker.whenReady;

		// Tab B starts behind blocker on the lock.
		const tabB = createLeaderTransport(
			makeDeps(channelSuffix, locks, "leaderB", () => workerB),
		);
		const clientB = new WorkerClient(tabB);
		const repoB = new Repo(clientB, vault);
		// `bootstrap` is the in-flight RPC the spec calls out — its
		// envelope sits in `inFlight` while tabB waits its turn on the
		// lock. If replay regresses, the envelope is silently dropped
		// when tabB self-pairs and `bootstrap()` hangs.
		const bootstrapPromise = repoB.bootstrap();

		// Give the envelope a tick to reach `postMessage` and land in
		// `inFlight`. Without this yield the test could close the
		// blocker before B's send even ran.
		await new Promise((r) => setTimeout(r, 10));

		blocker.close();
		locks.releaseHeld();

		try {
			await bootstrapPromise; // must succeed via replay onto B
			const note = await repoB.upsertNote({
				title: "replay-after-ack",
				body: "x",
			});
			expect(note.id).toHaveLength(26);
		} finally {
			tabB.close();
		}
	});

	it("a follower closing does not tear down the leader's writer", async () => {
		// Fix #3 regression. The previous code forwarded a follower's
		// `{kind: "close"}` straight to the leader's writer, where the
		// dispatcher disposed the shared writer-side `Connection` and
		// orphaned every other paired tab. The bridge now intercepts
		// `close` per-client: synthesizes the response, drops only that
		// client's bridge, leaves the writer alive.
		const db = await openDb();
		const { worker } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelSuffix = `client-close-${Math.random()}`;
		const vault = makeVault();

		const depsA = makeDeps(channelSuffix, locks, "leaderA", () => worker);
		const tabA = createLeaderTransport(depsA);
		await tabA.whenReady;

		const depsB = makeDeps(channelSuffix, locks, "tabB", () => {
			throw new Error("tabB must not become leader");
		});
		const tabB = createLeaderTransport(depsB);
		await tabB.whenReady;

		const clientA = new WorkerClient(tabA);
		const clientB = new WorkerClient(tabB);
		const repoA = new Repo(clientA, vault);
		const repoB = new Repo(clientB, vault);
		await repoA.bootstrap();
		await repoB.bootstrap();

		// Client A (the follower-from-the-leader's-POV is actually the
		// non-leader tab, B; A is the leader. So we close B and assert
		// A keeps working). Naming follows the finding's wording.
		await repoB.close();

		// Leader's RPCs must continue. If `close` were still forwarded
		// to the writer this would hang (connection disposed) or throw
		// (post-dispose port).
		const note = await repoA.upsertNote({
			title: "after follower close",
			body: "leader still alive",
		});
		const fetched = await repoA.getNote(note.id);
		expect(fetched?.title).toBe("after follower close");

		tabA.close();
		// tabB was already torn down by `repoB.close()` via `terminate()`.
	});

	it("recovers from a single writer crash by re-requesting the lock", async () => {
		// Round-3 fix. In a single-tab session, a writer crash used to
		// leave the transport stuck: `handleWriterFailure` released the
		// lock but nothing re-requested it, so the only tab on the
		// origin sat with `currentLeaderId === null` forever. The fix
		// re-requests the lock automatically; in a single-tab world the
		// queue is empty so the same tab is granted again immediately,
		// spawns a fresh writer, re-establishes the self-pair, and the
		// in-flight RPC succeeds via the new writer.
		const db = await openDb();
		const locks = new FakeLockManager();
		const channelSuffix = `writer-recover-${Math.random()}`;
		const vault = makeVault();

		// First writerFactory invocation returns a crash-only stub
		// (collects error listeners, never replies). Subsequent
		// invocations return a real working writer wired to the shared
		// in-memory DB so the replayed `bootstrap` envelope actually
		// gets answered.
		const crashListeners = new Set<(event: Event) => void>();
		const crashWriter: WorkerLike = {
			postMessage: () => {
				// black-hole — pending RPC stays in flight until the crash
			},
			addEventListener: ((type: string, listener: unknown) => {
				if (type === "error") {
					crashListeners.add(listener as (event: Event) => void);
				}
			}) as WorkerLike["addEventListener"],
			removeEventListener: ((type: string, listener: unknown) => {
				if (type === "error") {
					crashListeners.delete(listener as (event: Event) => void);
				}
			}) as WorkerLike["removeEventListener"],
			close: () => {
				crashListeners.clear();
			},
		};
		let factoryCalls = 0;
		const factory = (): WorkerLike => {
			factoryCalls += 1;
			if (factoryCalls === 1) return crashWriter;
			return makeWriter(db).worker;
		};

		const deps = makeDeps(channelSuffix, locks, "recover", factory);
		const transport = createLeaderTransport(deps);
		try {
			await transport.whenReady;
			const client = new WorkerClient(transport);
			const repo = new Repo(client, vault);
			// Fire bootstrap before crashing the writer. The envelope
			// sits in `inFlight`; the crash drains the writer-side
			// failure path; the restart replays it onto a healthy
			// writer and the promise resolves.
			const bootstrapPromise = repo.bootstrap();
			// Yield once so the envelope lands in inFlight + reaches
			// the bridge (which posts it into the crashWriter's
			// black-hole `postMessage`).
			await new Promise((r) => setTimeout(r, 10));
			// Crash the first writer. The transport must observe the
			// error, give up the lock, and re-request it. In the empty
			// FakeLockManager queue we'll be granted again immediately,
			// the second factory call returns a healthy writer, and the
			// replayed bootstrap succeeds.
			const event = new Event("error");
			for (const l of crashListeners) l(event);

			// The pending bootstrap rejects via the synthesized error
			// envelope from `failPending`. The interesting recovery
			// signal is that a *fresh* RPC works after the restart —
			// proving the new leader is wired up end-to-end.
			await expect(bootstrapPromise).rejects.toThrow();

			// Wait for the second writer to be in place. The restart
			// path is synchronous in `handleWriterFailure → restartLock
			// Request → requestLock → becomeLeader`, but the FakeLock
			// Manager may schedule the grant asynchronously, so poll
			// until the factory has been called twice.
			await waitFor(() => factoryCalls >= 2, 1000);
			expect(factoryCalls).toBeGreaterThanOrEqual(2);

			// A fresh request on the recovered transport must round-
			// trip via the new writer.
			const repo2 = new Repo(new WorkerClient(transport), vault);
			await repo2.bootstrap();
			const note = await repo2.upsertNote({
				title: "after recovery",
				body: "fresh writer",
			});
			const fetched = await repo2.getNote(note.id);
			expect(fetched?.title).toBe("after recovery");
		} finally {
			transport.close();
		}
	});

	it("stops re-requesting the lock after the restart budget is exhausted", async () => {
		// Round-3 fix. The restart loop is bounded so a writer that
		// crashes on every boot can't pin the event loop forever. After
		// the Nth failure within the window, the transport surfaces a
		// final `error` event (so callers watching the event channel
		// know the recovery loop has given up) and stops calling
		// `writerFactory`. The exact cap matches `MAX_FAILURES` inside
		// `leader.ts` (currently 3); changing it requires this test
		// updated too.
		const locks = new FakeLockManager();
		const channelSuffix = `writer-cap-${Math.random()}`;

		// Every writer this factory returns is crash-only. We collect
		// the per-writer error-listener sets so each call to
		// `triggerNextCrash()` only fires on the most recent writer
		// (which is the one currently installed in the bridge).
		const writerErrorListeners: Array<Set<(event: Event) => void>> = [];
		let factoryCalls = 0;
		const factory = (): WorkerLike => {
			factoryCalls += 1;
			const listeners = new Set<(event: Event) => void>();
			writerErrorListeners.push(listeners);
			return {
				postMessage: () => {},
				addEventListener: ((type: string, listener: unknown) => {
					if (type === "error") {
						listeners.add(listener as (event: Event) => void);
					}
				}) as WorkerLike["addEventListener"],
				removeEventListener: ((type: string, listener: unknown) => {
					if (type === "error") {
						listeners.delete(listener as (event: Event) => void);
					}
				}) as WorkerLike["removeEventListener"],
				close: () => {
					listeners.clear();
				},
			};
		};

		const deps = makeDeps(channelSuffix, locks, "capLeader", factory);
		const transport = createLeaderTransport(deps);
		// Count transport-level error events. We expect at least one
		// after the cap is hit (the budget-exhausted signal). Per-crash
		// errors also flow through the same channel, so the absolute
		// count is "at least RESTART_CAP + 1" — we assert the final
		// state (no further factory calls) rather than an exact count.
		const errorEvents: Event[] = [];
		transport.addEventListener("error", (e) => errorEvents.push(e));

		try {
			await transport.whenReady;

			// Fire crashes one at a time, waiting between each so the
			// restart path (release lock → grant → becomeLeader → new
			// writer in `writerErrorListeners[i]`) settles before we
			// trigger the next one.
			const triggerLatest = (): void => {
				const latest = writerErrorListeners[writerErrorListeners.length - 1];
				if (!latest) return;
				const event = new Event("error");
				for (const l of latest) l(event);
			};

			// Crash #1 — within budget, transport restarts.
			triggerLatest();
			await waitFor(() => factoryCalls >= 2, 1000);
			// Crash #2 — still within budget.
			triggerLatest();
			await waitFor(() => factoryCalls >= 3, 1000);
			// Crash #3 — budget exhausted on this attempt. After this
			// crash the transport must NOT spawn a fourth writer.
			triggerLatest();

			// Give the (would-be) restart path a few event-loop turns
			// to misbehave if it's going to. With the cap in place,
			// `factoryCalls` stays at 3 indefinitely.
			await new Promise((r) => setTimeout(r, 50));
			expect(factoryCalls).toBe(3);
			// At least one error event must have fired (the per-crash
			// path emits one; the budget-exhausted path emits another
			// on top). The exact count varies with timing, but the
			// floor is meaningful.
			expect(errorEvents.length).toBeGreaterThanOrEqual(1);
		} finally {
			transport.close();
		}
	});

	it("clears the pending pair-ack retry when promoted to leader", async () => {
		// Round-3 fix: a tab that paired with a previous (now-vanished)
		// leader armed `pendingPair` and started the 500ms `pair-request`
		// retry timer. If that tab later wins the Web Lock and becomes
		// leader itself, `becomeLeader` must clear the stale retry —
		// otherwise the timer keeps re-posting `pair-request` envelopes
		// for the dead leader onto the discovery channel forever,
		// spamming late joiners and confusing peers.
		//
		// Setup: pre-occupy the lock via a direct `locks.request` so
		// tab B is queued without any "real" leader tab also listening
		// on the discovery channel (a blocker tab would race the ghost
		// leader-elected with its own announce on tab B's `leader-query`
		// probe). With no peer answering the probe, tab B's last-known
		// leader is the ghost — exactly the handover-race state the fix
		// must handle.
		const db = await openDb();
		const { worker: workerB } = makeWriter(db);
		const locks = new FakeLockManager();
		const channelSuffix = `clear-pending-${Math.random()}`;

		// Hold the lock with a bare `locks.request` — no transport, no
		// discovery participation. Releases via `locks.releaseHeld()`.
		let releaseLock!: () => void;
		const lockHeld = locks.request(
			"opfs-db-writer",
			{ mode: "exclusive" },
			() =>
				new Promise<void>((resolve) => {
					releaseLock = resolve;
				}),
		);
		void lockHeld;
		// Yield so the FakeLockManager actually grants the lock to the
		// bare requester before tab B queues behind it.
		await new Promise((r) => setTimeout(r, 0));

		// Tab B — queued behind the bare lock holder. No competing tab
		// is on the discovery channel, so the only leader tab B will
		// hear about is the ghost we inject below.
		const tabB = createLeaderTransport(
			makeDeps(channelSuffix, locks, "leaderB", () => workerB),
		);

		// Eavesdrop on the discovery channel from a separate BC. Same
		// suffix-rewritten name the transport uses internally. Capture
		// every `pair-request` so we can assert the post-promotion
		// silence on the ghost id.
		const spy = new BroadcastChannel(`opfs-leader-${channelSuffix}`);
		const ghostPairRequests: Array<{ leaderId: string; at: number }> = [];
		spy.addEventListener("message", (event) => {
			const data = event.data as { kind?: string; leaderId?: string };
			if (data?.kind === "pair-request" && data.leaderId === "ghost-leader") {
				ghostPairRequests.push({
					leaderId: data.leaderId,
					at: Date.now(),
				});
			}
		});

		// Inject the ghost leader announcement. Tab B hears it via the
		// discovery channel, calls `pairWithLeader("ghost-leader")`,
		// arms `pendingPair`, and starts the 500ms retry. The ghost
		// never acks, so the retry timer keeps firing.
		spy.postMessage({ kind: "leader-elected", id: "ghost-leader" });

		// Wait for at least one retry to fire (the initial post plus
		// one timer-driven retry) so we know `pendingPair` is genuinely
		// armed before promotion — sanity-check the setup.
		await waitFor(() => ghostPairRequests.length >= 2, 1500);
		expect(ghostPairRequests.length).toBeGreaterThanOrEqual(2);

		try {
			// Release the bare lock → tab B is granted → `becomeLeader`
			// runs. The fix clears the stale `pendingPair` here.
			releaseLock();
			locks.releaseHeld();
			await tabB.whenReady;

			// Snapshot the count at promotion, then wait 700ms (> one
			// PAIR_ACK_RETRY_MS) and assert no further ghost
			// pair-requests appeared. If the fix regresses, the retry
			// timer keeps firing and the count grows.
			const countAtPromotion = ghostPairRequests.length;
			await new Promise((r) => setTimeout(r, 700));
			expect(ghostPairRequests.length).toBe(countAtPromotion);
		} finally {
			spy.close();
			tabB.close();
		}
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

/**
 * Minimal `WorkerLike` stub for tests that only need to satisfy the
 * leader transport's writer-factory contract without actually serving
 * RPCs. Used by the writer-crash and replay tests where the writer's
 * role is to exist (so `becomeLeader` succeeds) but not to respond.
 */
function makeWriterStub(): WorkerLike {
	return {
		postMessage: () => {},
		addEventListener: (() => {}) as WorkerLike["addEventListener"],
		removeEventListener: (() => {}) as WorkerLike["removeEventListener"],
		close: () => {},
	};
}
