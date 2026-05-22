/**
 * Web-Locks leader-election transport (ADR 0006 fallback tier).
 *
 * Why this exists: when SharedWorker can't host sqlite-wasm (Firefox
 * today — `createSyncAccessHandle` is dedicated-worker-only there)
 * the storage layer falls back to a dedicated worker. The naive
 * "every tab spawns its own writer" approach races the exclusive
 * OPFS handle and corrupts the DB. ADR 0006 specifies the fix: elect
 * a single leader tab via the Web Locks API, have it own the writer,
 * and let other tabs talk to it over a private channel.
 *
 * # Pair handshake — why no `MessagePort` transfer
 *
 * The textbook implementation would have each non-leader tab create a
 * `MessageChannel`, transfer one end to the leader via the discovery
 * `BroadcastChannel`, and use the matching port locally. **That does
 * not work.** `BroadcastChannel.postMessage` is structured-clone-only
 * — it has no `transfer` argument, and any object that requires
 * transfer (a `MessagePort`, an `ArrayBuffer` listed for transfer,
 * etc.) raises `DataCloneError`. The Node.js implementation enforces
 * this explicitly; the browser spec does the same.
 *
 * So the handshake exchanges *channel names*, not ports. Concretely:
 *
 *  1. Every tab calls `navigator.locks.request("opfs-db-writer",
 *     { mode: "exclusive" }, ...)`. The callback returns a never-
 *     resolving promise so the lock is held until the tab closes.
 *  2. The winning tab becomes the leader: it spawns the dedicated DB
 *     worker and announces itself on the discovery
 *     `BroadcastChannel("opfs-leader")` with
 *     `{ kind: "leader-elected", id }`.
 *  3. Each non-leader tab, on hearing `leader-elected`, mints a fresh
 *     per-pair channel name (`opfs-pair-{leaderId}-{clientId}`),
 *     opens a `BroadcastChannel` on that name as its private RPC
 *     transport, and posts `{ kind: "pair-request", leaderId,
 *     clientId, channel }` on the discovery channel. No transferables.
 *  4. The leader hears the `pair-request`, opens its own
 *     `BroadcastChannel` on that same per-pair name, and bridges the
 *     pair-channel to its local writer worker. From that point on
 *     RPC envelopes ride the per-pair BC end-to-end — no discovery
 *     traffic mixed in.
 *
 * Per-pair BCs are noisy (every tab on the same origin still sees
 * messages on channels it subscribes to), but a tab only subscribes
 * to its *own* pair name, so cross-pair filtering is implicit. The
 * scheme also gives us trivial replay-on-handover: a new leader uses
 * the same announcement path, clients re-pair under the new leader id
 * with a fresh channel name, and any in-flight envelope buffered in
 * the page-side `inFlight` map is replayed onto the new pair BC.
 *
 * # Transport-only RPC over the per-pair BC
 *
 * Discovery BC carries discovery + per-pair channel names only.
 * RPC envelopes (`ClientEnvelope` / `ServerEnvelope`) ride the
 * per-pair BC. `tx-applied` fan-out still goes over the dedicated
 * `multi-tab` BC defined elsewhere — this transport is RPC-only.
 *
 * # Feature detection
 *
 * Short-circuits to `null` when the environment lacks
 * `navigator.locks` or `BroadcastChannel`. The caller (`index.ts`)
 * then falls through to a plain dedicated worker, accepting the
 * per-tab race because it's the only option left.
 */

import type { WorkerLike } from "./rpc.js";

/** BroadcastChannel name for leader discovery + pair-request fan-out. */
export const LEADER_CHANNEL = "opfs-leader";

/** Web Locks key the leader holds for its tab's entire lifetime. */
export const LEADER_LOCK_NAME = "opfs-db-writer";

/**
 * Discovery wire messages. Strictly fan-out / handshake — no RPC
 * payload ever rides the discovery channel. Per-pair channel names
 * are exchanged as strings (BC can't transfer `MessagePort`s).
 */
type LeaderAnnouncement = {
	readonly kind: "leader-elected";
	readonly id: string;
};
type PairRequest = {
	readonly kind: "pair-request";
	/** The leader id being addressed; filters stale handshakes. */
	readonly leaderId: string;
	/** Per-tab id; uniquifies the pair channel name. */
	readonly clientId: string;
	/** Name of the `BroadcastChannel` the pair will use for RPC. */
	readonly channel: string;
};
/**
 * Leader's acknowledgement that it has opened its end of the per-pair
 * channel and is ready to receive RPC envelopes. The client uses this
 * to gate `whenReady` so the first `bootstrap` envelope can't be
 * posted into the void before the leader has subscribed.
 */
type PairAck = {
	readonly kind: "pair-ack";
	readonly leaderId: string;
	readonly clientId: string;
};
/**
 * Late-join probe. A tab that comes up *after* a leader has already
 * announced won't see the announce (BC doesn't replay), so it posts
 * `leader-query`. The current leader, if any, replies with a fresh
 * `leader-elected`. Without this, late joiners would stall until the
 * next handover.
 */
type LeaderQuery = { readonly kind: "leader-query" };
/**
 * Leader's "writer crashed, give up on me" signal. Sent when the
 * dedicated writer worker fires an `error` event (script load failure,
 * uncaught exception in the worker scope, etc.). Clients drop their
 * pair channel and wait for the next `leader-elected` — the failing
 * tab also releases the Web Lock so a queued peer can take over.
 *
 * The leader still posts synthetic error envelopes on each per-pair
 * BC before broadcasting this, so in-flight RPCs reject promptly via
 * the normal `kind: "error"` envelope path. `leader-failed` is the
 * channel-level signal for "drop your pair channel, the leader is
 * gone" — the per-pair error envelopes drain the pending request
 * queue.
 */
type LeaderFailed = {
	readonly kind: "leader-failed";
	readonly leaderId: string;
	readonly message: string;
};
export type LeaderMessage =
	| LeaderAnnouncement
	| PairRequest
	| PairAck
	| LeaderQuery
	| LeaderFailed;

/**
 * Time the client waits for a `pair-ack` before re-sending its
 * `pair-request`. The handshake races leader-side `pair-request`
 * delivery vs. discovery-channel subscribe order; a retry covers the
 * (rare) case where the leader hadn't subscribed yet when the client
 * posted.
 */
const PAIR_ACK_RETRY_MS = 500;

/**
 * What the leader needs in order to host the writer. Injected so the
 * page-side adapter can swap in a dedicated `Worker` for prod and a
 * loopback dispatcher for tests. The leader bridges this worker to
 * each per-tab pair BC it accepts via `pair-request`.
 */
export type WriterFactory = () => WorkerLike;

/**
 * Minimum surface we need from `navigator.locks`. Tests inject a
 * fake; production binds to the real `LockManager`. Typed against
 * the spec's behaviour: `request(name, { mode }, callback)` and the
 * callback's promise is held for the lifetime of the lock.
 *
 * The optional `signal` mirrors the Web Locks spec — passing an
 * `AbortSignal` lets the caller cancel a queued request that hasn't
 * been granted yet. Used by `close()` to bail out of a restart-after-
 * crash lock re-request if teardown races the new election.
 */
export interface LockManagerLike {
	request<T>(
		name: string,
		options: { mode: "exclusive"; signal?: AbortSignal },
		callback: () => Promise<T>,
	): Promise<T>;
}

/**
 * Dependencies the transport needs. All injected so tests can
 * substitute deterministic fakes for Web Locks + BC. Production
 * passes the platform globals via `makeLeaderTransport` below.
 */
export type LeaderDeps = {
	readonly locks: LockManagerLike;
	readonly newBroadcastChannel: (name: string) => BroadcastChannel;
	readonly writerFactory: WriterFactory;
	readonly newLeaderId: () => string;
	readonly newClientId: () => string;
};

/**
 * Tab-local UUID seed. We can't rely on `crypto.randomUUID` in every
 * worker context (older Safari), so the production deps pass a
 * fallback. Kept here so tests can deterministically inject ids.
 */
export function defaultNewLeaderId(): string {
	const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
	if (c?.randomUUID) return c.randomUUID();
	// 16 random bytes, hex-encoded. Good enough for "distinguish two
	// leaders within a session" — collision risk is negligible.
	const bytes = new Uint8Array(16);
	(
		globalThis as { crypto?: { getRandomValues?: (b: Uint8Array) => void } }
	).crypto?.getRandomValues?.(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Adapts a `BroadcastChannel` to the `WorkerLike` surface. The leader
 * uses one of these per paired client; the client uses one as its
 * outbound `postMessage` target. Messages dispatched on the channel
 * are *all* RPC envelopes — the pair BC is private to the two ends
 * of one pairing, so no filtering is needed.
 *
 * The `"error"` channel never fires on a `BroadcastChannel` (no
 * `error` event in the spec), so we accept listeners but never
 * dispatch.
 */
function bcToWorkerLike(channel: BroadcastChannel): WorkerLike {
	const errorListeners = new Set<(event: Event) => void>();
	return {
		postMessage: (data) => channel.postMessage(data),
		addEventListener: ((type: string, listener: unknown) => {
			if (type === "message") {
				channel.addEventListener("message", listener as EventListener);
			} else if (type === "error") {
				errorListeners.add(listener as (event: Event) => void);
			}
		}) as WorkerLike["addEventListener"],
		removeEventListener: ((type: string, listener: unknown) => {
			if (type === "message") {
				channel.removeEventListener("message", listener as EventListener);
			} else if (type === "error") {
				errorListeners.delete(listener as (event: Event) => void);
			}
		}) as WorkerLike["removeEventListener"],
		close: () => {
			errorListeners.clear();
			try {
				channel.close();
			} catch {
				// ignore — already closed
			}
		},
	};
}

/**
 * Bridges the dedicated writer worker to a single client's pair BC.
 * The leader hosts one bridge per paired tab plus one self-bridge
 * for its own RPC traffic.
 *
 * Multiplexing: the dedicated writer worker has a single `self`
 * `Connection` — every response comes out the same stream regardless
 * of which client issued the matching request. The bridge demuxes by
 * tracking the request ids it has forwarded *into* the worker and
 * only forwarding responses whose id is in that set back out. This
 * is the same demux trick a SharedWorker would do server-side; we
 * just do it on the page side here because the dedicated worker
 * doesn't speak multi-port.
 *
 * To keep ids globally unique across clients, the bridge rewrites
 * each inbound envelope's id to a leader-assigned id before
 * forwarding; the response's id is rewritten back to the client's
 * original id on the way out. This decouples the per-client id
 * numbering — every `WorkerClient` starts its `nextId` counter at 1,
 * so without rewriting two clients would collide.
 *
 * Echo-suppression: `BroadcastChannel` does NOT redeliver a sender's
 * own messages back to it, so the bridge can forward writer output
 * onto the pair BC without seeing it bounce back as a client request.
 *
 * Client-close interception (fix #3): in leader mode every paired tab
 * shares ONE writer connection. If a follower's `Repo.close()` were
 * forwarded as `{kind: "close"}` to the writer, the writer-side
 * `Connection.dispose()` would tear down the shared `self` port,
 * killing the writer for every other paired tab. The bridge instead
 * intercepts close envelopes per-client: it synthesizes the response
 * locally, fires `onClientClose` so the transport can drop the
 * bridge from its registry, and disposes itself. The writer stays up
 * — its lifecycle is owned by `giveUpLeadership()` on the leader tab.
 */
class LeaderBridge {
	readonly #channel: BroadcastChannel;
	readonly #writer: WorkerLike;
	readonly #idMap: Map<number, number>;
	readonly #allocate: () => number;
	readonly #onClientClose: () => void;
	#disposed = false;

	constructor(
		channel: BroadcastChannel,
		writer: WorkerLike,
		idMap: Map<number, number>,
		allocate: () => number,
		onClientClose: () => void = () => {},
	) {
		this.#channel = channel;
		this.#writer = writer;
		this.#idMap = idMap;
		this.#allocate = allocate;
		this.#onClientClose = onClientClose;
		channel.addEventListener("message", this.#onClientMessage);
		writer.addEventListener("message", this.#onWriterMessage);
	}

	#onClientMessage = (event: MessageEvent): void => {
		if (this.#disposed) return;
		const data = event.data as {
			id?: unknown;
			request?: { kind?: unknown } | unknown;
		};
		if (typeof data?.id !== "number") {
			this.#writer.postMessage(event.data);
			return;
		}
		// Fix #3: intercept `close` from clients. Forwarding it would
		// dispose the shared writer-side `Connection` and break every
		// other paired tab. Synthesize the response, signal the leader
		// transport via `onClientClose`, and tear down only this bridge.
		const request = (data as { request?: { kind?: unknown } }).request;
		if (
			request &&
			typeof request === "object" &&
			(request as { kind?: unknown }).kind === "close"
		) {
			const clientId = data.id;
			try {
				this.#channel.postMessage({
					kind: "response",
					id: clientId,
					response: { kind: "close" },
				});
			} catch {
				// BC may already be torn down — the client called close
				// and the response is best-effort anyway.
			}
			const cb = this.#onClientClose;
			this.dispose();
			try {
				cb();
			} catch {
				// caller-supplied callback; we own bridge state, so a
				// throw upward shouldn't leak into the dispose path
			}
			return;
		}
		const clientId = data.id;
		const leaderId = this.#allocate();
		this.#idMap.set(leaderId, clientId);
		this.#writer.postMessage({ ...data, id: leaderId });
	};

	#onWriterMessage = (event: MessageEvent): void => {
		if (this.#disposed) return;
		const data = event.data as { id?: unknown };
		if (typeof data?.id !== "number") return;
		const leaderId = data.id;
		const clientId = this.#idMap.get(leaderId);
		if (clientId === undefined) return; // belongs to another bridge
		this.#idMap.delete(leaderId);
		this.#channel.postMessage({ ...data, id: clientId });
	};

	/**
	 * Reject every in-flight client request mapped through this bridge
	 * by posting a synthetic `{kind: "error"}` envelope per pending id
	 * on the per-pair channel. The client's `WorkerClient` treats the
	 * envelope identically to a writer-side error, so pending promises
	 * (`bootstrap`, `upsertNote`, etc.) reject promptly instead of
	 * stranding. Used by the transport when the writer fires its
	 * `"error"` event (fix #1). The bridge stays usable after this
	 * call only to support test-time inspection — production callers
	 * always `dispose()` immediately after.
	 */
	failPending(message: string): void {
		if (this.#disposed) return;
		for (const clientId of this.#idMap.values()) {
			try {
				this.#channel.postMessage({
					kind: "error",
					id: clientId,
					message,
				});
			} catch {
				// per-pair BC may already be detached; best-effort
			}
		}
		this.#idMap.clear();
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		this.#channel.removeEventListener("message", this.#onClientMessage);
		this.#writer.removeEventListener("message", this.#onWriterMessage);
		try {
			this.#channel.close();
		} catch {
			// best-effort: the channel may already be detached
		}
	}
}

/**
 * Returns `true` if the current context has both required platform
 * APIs. The caller (`index.ts`) uses this as the feature gate before
 * even trying to instantiate the transport.
 */
export function supportsLeaderElection(): boolean {
	const nav = (globalThis as { navigator?: { locks?: unknown } }).navigator;
	const hasLocks = !!nav && "locks" in nav && !!nav.locks;
	const hasBc =
		typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel !==
		"undefined";
	return hasLocks && hasBc;
}

/**
 * Build the production deps. Split out so tests can inject fakes via
 * `createLeaderTransport(deps)` directly without touching globals.
 */
export function defaultLeaderDeps(writerFactory: WriterFactory): LeaderDeps {
	const nav = (globalThis as { navigator: { locks: LockManagerLike } })
		.navigator;
	return {
		locks: nav.locks,
		newBroadcastChannel: (name) => new BroadcastChannel(name),
		writerFactory,
		newLeaderId: defaultNewLeaderId,
		newClientId: defaultNewLeaderId,
	};
}

/**
 * The shape returned to `createRepo`. Same `WorkerLike` interface the
 * rest of the storage layer already speaks; nothing else has to know
 * a leader election sits underneath.
 *
 * `whenReady` resolves once the first pairing is established (either
 * by becoming the leader or by hearing a leader announce and
 * receiving a pair-channel name). `createRepo` awaits it before
 * issuing `bootstrap`, otherwise that first envelope would be posted
 * into the void while we wait for the leader-elected event.
 */
export type LeaderTransport = WorkerLike & {
	readonly whenReady: Promise<void>;
};

/**
 * In-flight envelope tracking. We keep the raw posted data so re-
 * posting onto a new pair BC is byte-identical. Each pending entry
 * is deleted once a matching response (or error envelope) flows back
 * through the page side.
 */
type InFlight = {
	readonly data: unknown;
};

/**
 * Best-effort: extract the request id from an envelope so the
 * transport can match server responses back to the originating
 * client envelope without depending on `rpc.ts` internals. The
 * envelope shape is stable — both ClientEnvelope and ServerEnvelope
 * carry a numeric `id` — but we narrow defensively so a misshapen
 * message just gets forwarded without bookkeeping.
 */
function envelopeId(data: unknown): number | null {
	if (typeof data !== "object" || data === null) return null;
	const id = (data as { id?: unknown }).id;
	return typeof id === "number" ? id : null;
}

/**
 * Build the per-pair channel name. Same shape on both sides so the
 * client and the leader subscribe to the identical string.
 */
function pairChannelName(leaderId: string, clientId: string): string {
	return `opfs-pair-${leaderId}-${clientId}`;
}

/**
 * Page-side transport that swaps its underlying pair `BroadcastChannel`
 * whenever a new leader is elected. Owns the discovery
 * `BroadcastChannel` and the (replayable) in-flight buffer.
 *
 * Lifecycle is deliberately simple: one instance per tab, lives
 * until the tab is unloaded. The `close()` method is for tests +
 * symmetric teardown when `createRepo` decides to abandon this
 * transport (e.g. bootstrap fails and we fall through to the plain
 * dedicated worker tier).
 */
export function createLeaderTransport(deps: LeaderDeps): LeaderTransport {
	const discovery = deps.newBroadcastChannel(LEADER_CHANNEL);
	const messageListeners = new Set<(event: MessageEvent) => void>();
	const errorListeners = new Set<(event: Event) => void>();
	const inFlight = new Map<number, InFlight>();
	const clientId = deps.newClientId();

	let pairChannel: BroadcastChannel | null = null;
	let currentLeaderId: string | null = null;
	let closed = false;
	/**
	 * Set once we've issued a pair-request for the *current* leader id
	 * and are waiting for the matching `pair-ack`. Cleared on ack so
	 * subsequent leader changes can re-arm the handshake. Drives the
	 * retry timer below.
	 */
	let pendingPair: {
		leaderId: string;
		channel: string;
		timer: ReturnType<typeof setTimeout> | null;
	} | null = null;

	// Leader-side state, populated only on the tab that wins the lock.
	let writer: WorkerLike | null = null;
	let leaderId: string | null = null;
	const bridges = new Map<string, LeaderBridge>(); // keyed by clientId
	// Shared id allocator across all bridges so the writer sees a
	// monotonically increasing, globally-unique id space regardless of
	// which client issued the original request.
	let nextLeaderEnvelopeId = 1;
	const allocateLeaderId = (): number => nextLeaderEnvelopeId++;
	/**
	 * Set by `becomeLeader` to a closure that removes the writer's
	 * `error` listener. Cleared by `giveUpLeadership`. Hoisted into the
	 * transport scope so the leader-failure handler and the orderly
	 * `close()` path share the same cleanup.
	 */
	let pendingWriterErrorCleanup: (() => void) | null = null;

	// Web-Locks lifecycle plumbing. `resolveLock` settles the never-
	// resolving promise we return from the lock callback — calling it
	// releases the `opfs-db-writer` lock so peer tabs can advance. The
	// ready promise is settable from either side so a lock-request
	// rejection (rare: `SecurityError`, `InvalidStateError`) or a
	// `close()` before pairing surfaces as a real rejection instead of
	// an indefinite hang.
	let resolveLock: (() => void) | null = null;
	let resolveReady: (() => void) | null = null;
	let rejectReady: ((err: Error) => void) | null = null;
	let readySettled = false;
	const whenReady = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	// Avoid unhandled-rejection noise: callers that don't await
	// `whenReady` (e.g. tests that only exercise the transport's
	// teardown path) shouldn't see a rejection bubble to the host.
	whenReady.catch(() => {});
	const markReady = (): void => {
		if (readySettled) return;
		readySettled = true;
		resolveReady?.();
		resolveReady = null;
		rejectReady = null;
	};
	const failReady = (err: Error): void => {
		if (readySettled) return;
		readySettled = true;
		rejectReady?.(err);
		resolveReady = null;
		rejectReady = null;
	};

	const onPairMessage = (event: MessageEvent): void => {
		// Drop bookkeeping once a response arrives. Errors carry the same
		// id; either resolution is terminal for that request.
		const id = envelopeId(event.data);
		if (id !== null) {
			const env = event.data as {
				kind?: "response" | "error";
				id: number;
			};
			if (env.kind === "response" || env.kind === "error") {
				inFlight.delete(id);
			}
		}
		for (const l of messageListeners) l(event);
	};

	const detachPair = (): void => {
		if (!pairChannel) return;
		pairChannel.removeEventListener("message", onPairMessage);
		try {
			pairChannel.close();
		} catch {
			// ignore — channel may already be closed
		}
		pairChannel = null;
	};

	const clearPendingPair = (): void => {
		if (pendingPair?.timer) clearTimeout(pendingPair.timer);
		pendingPair = null;
	};

	/**
	 * Wire the pair channel locally. Does NOT replay buffered envelopes
	 * — BC delivers only to currently-subscribed peers and has no queue,
	 * so a replay here would race the leader-side subscribe. The replay
	 * is gated on `pair-ack` (or, for the leader's self-pair, executed
	 * synchronously in `becomeLeader` since both ends are subscribed by
	 * construction). Fix #2.
	 *
	 * Does NOT mark ready — readiness for non-leader tabs is gated on
	 * the `pair-ack` (BC delivery is async, so the leader hasn't
	 * necessarily subscribed by the time we'd otherwise resolve).
	 * Leader-side self-pair is special-cased in `becomeLeader`.
	 */
	const attachPair = (channel: BroadcastChannel): void => {
		detachPair();
		pairChannel = channel;
		channel.addEventListener("message", onPairMessage);
	};

	/**
	 * Re-post every in-flight envelope onto the supplied (already
	 * subscribed) BroadcastChannel. The leader has no memory of these
	 * ids, so the request reruns server-side; the response carries the
	 * same id so the page-side `WorkerClient` resolves the original
	 * promise. ADR 0006: in-flight requests are retried once with the
	 * same id. Fix #2: caller is responsible for sequencing — only
	 * invoke after the leader-side bridge is known to be listening
	 * (i.e. on `pair-ack` or on synchronous self-pair construction).
	 */
	const replayInFlight = (channel: BroadcastChannel): void => {
		for (const pending of inFlight.values()) {
			channel.postMessage(pending.data);
		}
	};

	const sendPairRequest = (announcedLeaderId: string, name: string): void => {
		if (closed) return;
		const pair: PairRequest = {
			kind: "pair-request",
			leaderId: announcedLeaderId,
			clientId,
			channel: name,
		};
		discovery.postMessage(pair);
	};

	const pairWithLeader = (announcedLeaderId: string): void => {
		if (closed) return;
		// Already paired with this leader? Don't churn a new channel.
		if (currentLeaderId === announcedLeaderId && pairChannel) return;
		currentLeaderId = announcedLeaderId;
		clearPendingPair();
		const name = pairChannelName(announcedLeaderId, clientId);
		const channel = deps.newBroadcastChannel(name);
		// Attach our end first so we can hear the leader's responses
		// the moment its bridge starts forwarding. The `pair-ack` rides
		// the discovery channel (BC can't transfer ports either way),
		// is filtered client-side by `clientId`, and signals that the
		// leader has subscribed to the per-pair BC — only then is it
		// safe to mark `whenReady`.
		attachPair(channel);
		// Schedule a retry on no-ack: BC delivery is async and a stale
		// leader announce could lose the race. The leader is idempotent
		// on duplicate pair-requests (it disposes the old bridge and
		// opens a fresh one), so re-sending is safe.
		const arm = (): void => {
			pendingPair = {
				leaderId: announcedLeaderId,
				channel: name,
				timer: setTimeout(() => {
					if (
						!pendingPair ||
						pendingPair.leaderId !== announcedLeaderId ||
						closed
					) {
						return;
					}
					sendPairRequest(announcedLeaderId, name);
					arm();
				}, PAIR_ACK_RETRY_MS),
			};
		};
		arm();
		sendPairRequest(announcedLeaderId, name);
	};

	const onDiscoveryMessage = (event: MessageEvent<LeaderMessage>): void => {
		const msg = event.data;
		if (msg.kind === "leader-elected") {
			// Non-leader tabs (including a now-demoted ex-leader — though
			// in practice a demoted leader's tab is about to close)
			// trigger re-pairing. The leader itself ignores its own
			// announcement because its in-process self-pair already set
			// `currentLeaderId`.
			if (msg.id !== leaderId) {
				pairWithLeader(msg.id);
			}
			return;
		}
		if (msg.kind === "pair-request") {
			// Only the current leader services pair requests. Stale
			// pair-requests addressed to a previous leader are filtered
			// by id; out-of-tab self-loops are filtered by the discovery
			// BC's no-echo rule (a sender never sees its own message).
			if (!writer || leaderId === null || msg.leaderId !== leaderId) return;
			// Idempotent: if the same client re-pairs (e.g. transient
			// disconnect), replace the old bridge.
			const existing = bridges.get(msg.clientId);
			if (existing) existing.dispose();
			const channel = deps.newBroadcastChannel(msg.channel);
			const incomingClientId = msg.clientId;
			const bridge = new LeaderBridge(
				channel,
				writer,
				new Map<number, number>(),
				allocateLeaderId,
				() => {
					// Fix #3: bridge intercepted a client `close` and is
					// removing itself. Drop the entry from our registry
					// so a later `pair-request` from the same clientId
					// (re-pairing tab) doesn't trip the "dispose existing"
					// branch on a stale handle.
					bridges.delete(incomingClientId);
				},
			);
			bridges.set(incomingClientId, bridge);
			// Now that the leader has subscribed to the per-pair BC,
			// ack the client so it can resolve `whenReady` and start
			// pushing RPC envelopes. Without this, BC delivery latency
			// could let the client post `bootstrap` before the leader
			// is listening, dropping the envelope silently.
			const ack: PairAck = {
				kind: "pair-ack",
				leaderId,
				clientId: msg.clientId,
			};
			discovery.postMessage(ack);
			return;
		}
		if (msg.kind === "pair-ack") {
			// Client-side: only react to the ack addressed at us, for
			// the leader we're currently pairing with. Anything else is
			// a stale ack from a previous pairing (drop) or another
			// tab's ack (ignore — discovery is shared).
			if (msg.clientId !== clientId) return;
			if (!pendingPair || pendingPair.leaderId !== msg.leaderId) return;
			clearPendingPair();
			// Fix #2: the ack is our proof that the leader's bridge has
			// subscribed to the per-pair BC. Now — and only now — is it
			// safe to replay any in-flight envelopes that accumulated
			// while we were waiting for the handshake. Replaying earlier
			// (inside `attachPair`) would have raced BC subscribe order
			// and silently dropped the buffered RPCs.
			if (pairChannel) replayInFlight(pairChannel);
			markReady();
			return;
		}
		if (msg.kind === "leader-failed") {
			// The current leader's writer crashed. Drop our pair channel
			// — the leader is about to release its Web Lock and a queued
			// peer will be promoted shortly. Pending RPCs already saw
			// per-pair error envelopes (synthesized by the dying leader's
			// bridge) so `WorkerClient` has rejected them; what remains
			// is to clear our local pair state so the next
			// `leader-elected` triggers a fresh `pairWithLeader`.
			if (msg.leaderId !== currentLeaderId) return;
			detachPair();
			currentLeaderId = null;
			clearPendingPair();
			// Surface the failure to the transport's error listeners so
			// any code path that only watches `error` events (rather
			// than per-request rejections) also notices.
			const event = new Event("error");
			for (const l of errorListeners) l(event);
			return;
		}
		if (msg.kind === "leader-query") {
			// Late-join probe — only the current leader answers. Re-
			// announcing is cheap and idempotent: any peer that already
			// paired with us filters this in `pairWithLeader` via the
			// `currentLeaderId === announcedLeaderId` check.
			if (!writer || leaderId === null) return;
			const announce: LeaderAnnouncement = {
				kind: "leader-elected",
				id: leaderId,
			};
			discovery.postMessage(announce);
			return;
		}
	};

	discovery.addEventListener("message", onDiscoveryMessage);

	const becomeLeader = (): void => {
		if (closed) return;
		// Clear any pending `pair-request` retry armed by an earlier
		// `pairWithLeader` for the *previous* leader. This tab queued
		// behind the Web Lock as a follower, started chasing the prior
		// leader's pair-ack, and only now won promotion — without this
		// clear, the 500ms retry timer keeps re-posting `pair-request`
		// onto the discovery channel forever, spamming late joiners and
		// confusing peers. Round-2 handover race.
		clearPendingPair();
		leaderId = deps.newLeaderId();
		writer = deps.writerFactory();

		// Fix #1: a writer that fails to load or crashes mid-session
		// only emits `"error"`, never `"message"`, so the bridges'
		// message listeners never fire and outstanding RPCs (like the
		// `bootstrap` `createRepo` is awaiting) stay pending forever.
		// Install one error listener on the writer at the leader level,
		// fan out synthetic error envelopes per bridge, and tear the
		// leader down so a queued peer takes over.
		const myLeaderId = leaderId;
		const onWriterError = (_event: Event): void => {
			handleWriterFailure(myLeaderId, "storage writer error");
		};
		writer.addEventListener("error", onWriterError);

		// The leader is also a client of its own writer. We use a
		// dedicated per-pair BC (named after `clientId`) so the same
		// `LeaderBridge` code path serves both same-tab and cross-tab
		// clients — no special case for "I'm my own leader".
		//
		// Subtlety: `BroadcastChannel` does not redeliver a sender's own
		// messages back to it, so we cannot share *one* BC for both
		// sides of the self-pair. Instead we use TWO channels on the
		// same name: one owned by the bridge (writer side), one owned
		// by the transport (client side). They see each other's posts
		// normally.
		const selfChannelName = pairChannelName(leaderId, clientId);
		const bridgeSide = deps.newBroadcastChannel(selfChannelName);
		const clientSide = deps.newBroadcastChannel(selfChannelName);
		const bridge = new LeaderBridge(
			bridgeSide,
			writer,
			new Map<number, number>(),
			allocateLeaderId,
			() => {
				// Self-bridge close: only meaningful if the leader's own
				// page-side `Repo.close()` ran before the transport's
				// teardown. Drop the bridge from the registry; the
				// transport-level `close()` releases the writer + lock.
				bridges.delete(clientId);
			},
		);
		bridges.set(clientId, bridge);
		// Pretend the announcement happened for `currentLeaderId`
		// bookkeeping, then attach the local pair channel directly.
		// The leader is its own client: we already synchronously built
		// the bridge above, so unlike cross-tab clients we don't need
		// to wait for a `pair-ack` — both ends are subscribed already.
		currentLeaderId = leaderId;
		attachPair(clientSide);
		// Fix #2: replay-on-pair-ack is for cross-tab clients. The
		// leader's self-pair is synchronous (we just built both ends
		// above), so any envelopes that landed in `inFlight` while we
		// were waiting for the Web Lock can be flushed immediately.
		replayInFlight(clientSide);
		markReady();

		// Announce to peers so any tab that started before us can pair.
		// Tabs that start after will see this announce too because BC
		// delivery is fan-out. Tabs that joined the channel *before* we
		// became leader but stayed silent will hear us now and respond
		// with their own `pair-request`.
		const announce: LeaderAnnouncement = {
			kind: "leader-elected",
			id: leaderId,
		};
		discovery.postMessage(announce);
		// Cleanup hook used by `giveUpLeadership` to detach the error
		// listener on orderly shutdown. Kept as a side-effect of
		// `becomeLeader` so the listener registration and removal sit
		// next to each other in the source.
		pendingWriterErrorCleanup = (): void => {
			try {
				writer?.removeEventListener("error", onWriterError);
			} catch {
				// best-effort: writer may already be torn down
			}
		};
	};

	/**
	 * Fix #1: the dedicated writer worker has emitted `"error"`. We
	 * tear down all bridges (fabricating per-pair error envelopes so
	 * each client's `WorkerClient` rejects its in-flight RPCs), tell
	 * peers via `leader-failed` to drop their pair channels and wait
	 * for the next election, and release leadership so the Web Lock
	 * frees up for the next queued tab.
	 *
	 * Guarded by the `expectedLeaderId` snapshot so a stale error
	 * delivered after we already handed leadership off doesn't
	 * collaterally damage a fresh leader instance.
	 */
	const handleWriterFailure = (
		expectedLeaderId: string,
		message: string,
	): void => {
		if (closed) return;
		if (leaderId !== expectedLeaderId) return;
		const failingId = leaderId;
		for (const bridge of bridges.values()) {
			try {
				bridge.failPending(message);
			} catch {
				// best-effort: a thrown bridge shouldn't block the rest
			}
		}
		// Tell peers to drop their pair channels — the error envelopes
		// above drain pending RPCs, this drains pair state. Without
		// this, late-arriving requests would post into a per-pair BC
		// the leader is about to stop listening on.
		try {
			discovery.postMessage({
				kind: "leader-failed",
				leaderId: failingId,
				message,
			});
		} catch {
			// discovery may already be closed in a teardown race
		}
		// Surface to the leader tab's own transport listeners so the
		// leader-side `WorkerClient` (subscribed via the self-pair) sees
		// an error event in addition to the per-pair error envelopes.
		const event = new Event("error");
		for (const l of errorListeners) l(event);
		// Drop leadership: releases the Web Lock so a queued peer is
		// promoted, disposes the writer + bridges. Clears
		// `currentLeaderId` so the new leader's announce (either ours
		// after restart, or a peer's) drives a fresh `pairWithLeader`
		// on this tab.
		giveUpLeadership("writer-error");
		currentLeaderId = null;
		// Round 3: re-request the lock so a single-tab session recovers
		// automatically. In multi-tab sessions another peer queued on
		// `opfs-db-writer` may be granted first — that's fine, we'll
		// pair with it via the normal `leader-elected` discovery path.
		// Bounded by a sliding-window restart budget; once exceeded, we
		// emit a transport-level error and stop trying so `createRepo`
		// can degrade to the next tier instead of looping forever on a
		// boot-time crash.
		restartLockRequest();
	};

	const giveUpLeadership = (
		_cause: "close" | "writer-error" = "close",
	): void => {
		// Detach the writer-error listener before we close the writer
		// so its own teardown can't fire a spurious error event back
		// into the failure handler.
		if (pendingWriterErrorCleanup) {
			const cleanup = pendingWriterErrorCleanup;
			pendingWriterErrorCleanup = null;
			try {
				cleanup();
			} catch {
				// best-effort
			}
		}
		for (const bridge of bridges.values()) bridge.dispose();
		bridges.clear();
		if (writer) {
			try {
				writer.close();
			} catch {
				// best-effort
			}
			writer = null;
		}
		leaderId = null;
		// Release the Web Lock so peer tabs queued on `opfs-db-writer`
		// can be granted. Without this, the lock would be held until
		// page unload — `Repo.close()` while the page survives would
		// leave every other tab blocked indefinitely.
		if (resolveLock) {
			const r = resolveLock;
			resolveLock = null;
			try {
				r();
			} catch {
				// best-effort: nothing we can do if release throws
			}
		}
	};

	// Round 3: sliding-window restart budget. Each entry is the
	// timestamp (ms) of a writer-failure we've observed. We purge
	// entries older than the window on every check; if the surviving
	// count reaches `MAX_FAILURES`, we stop restarting and emit a
	// transport-level error so the caller can fall through to the
	// dedicated-worker tier instead of looping forever on a writer
	// that crashes on boot. `MAX_FAILURES` is the number of crashes
	// before we give up entirely — N=3 means the 3rd consecutive crash
	// in the window halts the restart loop (max 2 restarts → 3 writer
	// generations total).
	const RESTART_WINDOW_MS = 30_000;
	const MAX_FAILURES = 3;
	const failureTimestamps: number[] = [];
	// AbortController for the current in-flight `locks.request`. We
	// signal it from `close()` so a queued restart-after-crash can be
	// cancelled without leaking a never-settled lock-callback promise.
	let lockAbort: AbortController | null = null;

	const requestLock = (): void => {
		if (closed) return;
		const controller =
			typeof AbortController !== "undefined" ? new AbortController() : null;
		lockAbort = controller;
		const options: { mode: "exclusive"; signal?: AbortSignal } = {
			mode: "exclusive",
		};
		if (controller) options.signal = controller.signal;
		const p = deps.locks
			.request(
				LEADER_LOCK_NAME,
				options,
				() =>
					new Promise<void>((release) => {
						// If `close()` ran while we were still queued for the
						// lock, the grant arrives on a torn-down transport.
						// Release immediately so the next queued peer gets a
						// turn instead of inheriting an orphaned lock.
						if (closed) {
							release();
							return;
						}
						resolveLock = release;
						becomeLeader();
					}),
			)
			.catch((err: unknown) => {
				// Lock acquisition failure (e.g. `SecurityError` in non-
				// secure contexts, `InvalidStateError` on a detached
				// document, or `AbortError` from our own `close()`).
				// Without surfacing this, `whenReady` never settles and
				// `createRepo` hangs forever.
				if (closed) return; // teardown-initiated abort: stay quiet
				const event = new Event("error");
				for (const l of errorListeners) l(event);
				failReady(
					err instanceof Error
						? err
						: new Error(`leader lock request rejected: ${String(err)}`),
				);
			})
			.finally(() => {
				if (lockAbort === controller) lockAbort = null;
			});
		void p;
	};

	/**
	 * Round 3: re-request the lock after a writer crash. Tracks restart
	 * count in a sliding window so a pathological writer that crashes
	 * on every boot can't put us into an infinite loop. After the cap
	 * is reached we emit a transport `error` event — code that's only
	 * watching error events (e.g. `createRepo` deciding whether to fall
	 * through to the dedicated-worker tier) will see it.
	 */
	const restartLockRequest = (): void => {
		if (closed) return;
		const now = Date.now();
		const cutoff = now - RESTART_WINDOW_MS;
		while (failureTimestamps.length) {
			const head = failureTimestamps[0];
			if (head === undefined || head >= cutoff) break;
			failureTimestamps.shift();
		}
		failureTimestamps.push(now);
		if (failureTimestamps.length >= MAX_FAILURES) {
			// Budget exhausted: this crash makes the Nth in-window
			// failure. Stop restarting and tell the world. We don't
			// `failReady` here because `whenReady` is already settled
			// (the transport ran successfully at least once before
			// crashing); the contract for ongoing failures is the
			// `error` event.
			const event = new Event("error");
			for (const l of errorListeners) l(event);
			return;
		}
		requestLock();
	};

	// Kick off the election. Web Locks queues callers FIFO; only one
	// callback at a time holds the lock. The callback returns a
	// promise we keep open so the lock survives until either the tab
	// unloads (browser auto-releases) or `close()` resolves the
	// promise explicitly — required so a `Repo.close()` while the
	// page is still alive actually releases the lock to peer tabs.
	requestLock();

	// If a leader is already in the field when this tab started, they
	// announced before our discovery listener was attached. Browsers
	// don't replay BroadcastChannel messages on subscribe, so we prod
	// the field: post `leader-query`, and any running leader replies
	// with a fresh `leader-elected`. Cheap when there is no leader (a
	// no-op message hits the void); fast when there is.
	const probe: LeaderQuery = { kind: "leader-query" };
	discovery.postMessage(probe);

	return {
		postMessage: (data) => {
			if (closed) return;
			const id = envelopeId(data);
			if (id !== null) {
				inFlight.set(id, { data });
			}
			if (pairChannel) {
				pairChannel.postMessage(data);
			}
			// If we don't have a pair channel yet, the envelope sits in
			// inFlight and gets replayed once attachPair fires. Same
			// retry mechanism leader-handover uses — one code path.
		},
		addEventListener: ((type: string, listener: unknown) => {
			if (type === "message") {
				messageListeners.add(listener as (event: MessageEvent) => void);
			} else if (type === "error") {
				errorListeners.add(listener as (event: Event) => void);
			}
		}) as WorkerLike["addEventListener"],
		removeEventListener: ((type: string, listener: unknown) => {
			if (type === "message") {
				messageListeners.delete(listener as (event: MessageEvent) => void);
			} else if (type === "error") {
				errorListeners.delete(listener as (event: Event) => void);
			}
		}) as WorkerLike["removeEventListener"],
		close: () => {
			if (closed) return;
			closed = true;
			clearPendingPair();
			// If we never reached readiness, surface that as a real
			// rejection rather than a forever-pending promise. Callers
			// awaiting `whenReady` (e.g. `createRepo`) need to see the
			// failure to fall through to the next transport tier.
			failReady(new Error("leader transport closed before ready"));
			discovery.removeEventListener("message", onDiscoveryMessage);
			try {
				discovery.close();
			} catch {
				// already closed
			}
			detachPair();
			// Round 3: cancel any queued `locks.request` that hasn't
			// been granted yet (typically the restart-after-crash path
			// racing teardown). Aborting flushes the `.catch` below
			// with an `AbortError`, but the `closed` guard inside the
			// catch keeps it quiet — no spurious `error` event.
			if (lockAbort) {
				try {
					lockAbort.abort();
				} catch {
					// best-effort: implementation may not support abort
				}
				lockAbort = null;
			}
			// `giveUpLeadership` releases the lock if we currently hold
			// it (`resolveLock` is set inside the lock callback). Also
			// release if we were still queued — the `.catch` above will
			// fire and is a no-op for an already-settled `whenReady`.
			giveUpLeadership("close");
			if (resolveLock) {
				const r = resolveLock;
				resolveLock = null;
				try {
					r();
				} catch {
					// best-effort
				}
			}
			messageListeners.clear();
			errorListeners.clear();
			inFlight.clear();
		},
		whenReady,
	};
}

/**
 * Convenience: build the production transport using the platform
 * `navigator.locks` + `BroadcastChannel`. Returns `null` if either
 * is missing so the caller (`createRepo`) can fall through.
 */
export function makeLeaderTransport(
	writerFactory: WriterFactory,
): LeaderTransport | null {
	if (!supportsLeaderElection()) return null;
	return createLeaderTransport(defaultLeaderDeps(writerFactory));
}

// Re-export for tests + ergonomic external wiring.
export { bcToWorkerLike, LeaderBridge };
