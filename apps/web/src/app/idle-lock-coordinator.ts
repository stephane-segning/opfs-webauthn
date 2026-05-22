/**
 * Pure cross-tab idle-lock coordinator (ADR 0005 + ADR 0006).
 *
 * Holds no references to React, `window`, `document`, or
 * `BroadcastChannel`. The React hook (`useIdleVaultLock`) wires this
 * class up to those real APIs; tests wire it to fake ones.
 *
 * Behaviour:
 *
 * - Calling `noteActivity()` updates `lastActivity` and *may* publish
 *   a `vault-heartbeat` (rate-limited to one per
 *   `HEARTBEAT_INTERVAL_MS`).
 * - Calling `tick()` checks `now() - lastActivity` and, if it exceeds
 *   `idleMs`, publishes `vault-locked` and invokes `onLock`. The hook
 *   schedules `tick()` on a periodic interval.
 * - `receive(msg)` reacts to remote messages: `vault-heartbeat` resets
 *   the local idle clock (a sibling tab is active); `vault-locked`
 *   triggers a mirror-lock.
 *
 * The lock signal is one-shot: once locked (via local timer OR remote
 * broadcast), subsequent `tick()` / `receive("vault-locked")` calls
 * are no-ops. The owning hook discards the coordinator on unmount.
 */

export type VaultChannelMessage =
	| { readonly kind: "vault-heartbeat" }
	| { readonly kind: "vault-locked" };

/** Heartbeat publish cadence — at most once per this interval. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** Default idle timeout from ADR 0005. */
export const IDLE_MS_DEFAULT = 5 * 60 * 1000;

export type IdleLockCoordinatorOptions = {
	readonly onLock: () => void;
	readonly publish: (msg: VaultChannelMessage) => void;
	readonly now: () => number;
	readonly idleMs?: number;
	readonly heartbeatIntervalMs?: number;
};

export class IdleLockCoordinator {
	readonly #onLock: () => void;
	readonly #publish: (msg: VaultChannelMessage) => void;
	readonly #now: () => number;
	readonly #idleMs: number;
	readonly #heartbeatIntervalMs: number;

	#lastActivity: number;
	#lastHeartbeatSent = 0;
	#locked = false;

	constructor(opts: IdleLockCoordinatorOptions) {
		this.#onLock = opts.onLock;
		this.#publish = opts.publish;
		this.#now = opts.now;
		this.#idleMs = opts.idleMs ?? IDLE_MS_DEFAULT;
		this.#heartbeatIntervalMs =
			opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
		// Seed `lastActivity` to *now* so a freshly-mounted coordinator
		// is treated as fully fresh, never idle.
		this.#lastActivity = this.#now();
	}

	/** Has this coordinator already fired its lock? */
	get locked(): boolean {
		return this.#locked;
	}

	/**
	 * Record user activity in this tab. Updates `lastActivity` and
	 * publishes a heartbeat if enough time has elapsed since the last
	 * one — this is what keeps sibling tabs awake while the user is
	 * active here.
	 */
	noteActivity(): void {
		if (this.#locked) return;
		const now = this.#now();
		this.#lastActivity = now;
		if (now - this.#lastHeartbeatSent >= this.#heartbeatIntervalMs) {
			this.#lastHeartbeatSent = now;
			this.#publish({ kind: "vault-heartbeat" });
		}
	}

	/**
	 * React to a message received on the `opfs-vault` channel.
	 * `vault-heartbeat` from a sibling resets the idle clock (without
	 * triggering an outbound heartbeat — only local activity does
	 * that, to avoid heartbeat storms). `vault-locked` mirrors the
	 * lock locally.
	 */
	receive(msg: VaultChannelMessage): void {
		if (this.#locked) return;
		if (msg.kind === "vault-heartbeat") {
			this.#lastActivity = this.#now();
			return;
		}
		// vault-locked: mirror the lock but do NOT re-publish; the
		// sending tab already broadcast and a re-broadcast would loop.
		this.#locked = true;
		this.#onLock();
	}

	/**
	 * Periodic idle check. The hook calls this once per
	 * `heartbeatIntervalMs` on a `setInterval`. If the gap since the
	 * last activity (local or remote) has crossed `idleMs`, we lock:
	 * broadcast `vault-locked` so siblings mirror, then invoke
	 * `onLock` locally.
	 */
	tick(): void {
		if (this.#locked) return;
		if (this.#now() - this.#lastActivity < this.#idleMs) return;
		this.#locked = true;
		this.#publish({ kind: "vault-locked" });
		this.#onLock();
	}
}
