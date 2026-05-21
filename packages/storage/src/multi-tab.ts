/**
 * Multi-tab fan-out wiring. Per ADR 0006, `tx-applied`
 * notifications travel over a named `BroadcastChannel` rather than
 * the request/response `MessagePort`. Reasons:
 *
 *  - SharedWorker: one writer, many tabs — the worker publishes
 *    once and every tab page hears the message through its own
 *    BC instance.
 *  - DedicatedWorker fallback: each tab has its own writer worker.
 *    Both workers post on the same-named channel and every tab's
 *    page-side BC receives the union of all writes. The originating
 *    page also gets the notification (BC delivers to every other
 *    instance with the same name, in any same-origin context),
 *    which is exactly what the page's store-refresh wiring wants.
 *
 * The channel name is exported as a constant so the worker entries,
 * the page-side subscriber, and tests all bind to the exact same
 * stream — a typo would silently strand notifications.
 *
 * `BroadcastChannel` is widely supported but not universal — older
 * iOS Safari and WebView contexts can lack it. Both the
 * `makeTxBroadcaster` and `subscribeTxApplied` helpers feature-
 * detect it and degrade to a no-op rather than throwing at module
 * load (codex flagged the unconditional `new BroadcastChannel()`
 * in the worker entries on PR #43). Without BC the app keeps
 * working per-tab; cross-tab fan-out simply doesn't happen.
 */

import type { WorkerNotification } from "./rpc.js";

/**
 * BroadcastChannel name carrying `tx-applied` (and any future
 * fan-out events). Reserved for notifications only: RPC always
 * rides a private `MessagePort`.
 */
export const TX_APPLIED_CHANNEL = "opfs-storage-tx";

/**
 * Returns `true` if the active context exposes a usable
 * `BroadcastChannel` constructor. Cheap; safe to call at module
 * load. We probe `globalThis` rather than relying on a bare
 * `BroadcastChannel` reference so TypeScript's `lib.dom` typings
 * don't mask the runtime absence on a target that omits it.
 */
function hasBroadcastChannel(): boolean {
	return (
		typeof globalThis !== "undefined" &&
		typeof (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel !==
			"undefined"
	);
}

/**
 * Worker-side broadcaster + cleanup pair. The dispatcher calls
 * `broadcast(notification)` after each successful write; the
 * `close` hook lets a hot-reload teardown release the underlying
 * channel handle.
 *
 * When `BroadcastChannel` is unavailable both functions are no-ops:
 * the worker stays alive and answers RPC, just without cross-tab
 * fan-out. Per-tab use still works because the originating tab's
 * UI mutates through its own RPC return values, not a broadcast.
 */
export type TxBroadcaster = {
	readonly broadcast: (notification: WorkerNotification) => void;
	readonly close: () => void;
};

export function makeTxBroadcaster(): TxBroadcaster {
	if (!hasBroadcastChannel()) {
		return {
			broadcast: () => {
				/* no-op — environment lacks BroadcastChannel */
			},
			close: () => {},
		};
	}
	const channel = new BroadcastChannel(TX_APPLIED_CHANNEL);
	return {
		broadcast: (notification) => {
			channel.postMessage(notification);
		},
		close: () => {
			channel.close();
		},
	};
}

/**
 * Page-side subscription. Returns an unsubscribe function. The
 * listener fires for every `tx-applied` envelope posted on
 * `TX_APPLIED_CHANNEL`, regardless of which tab / worker emitted
 * it (BC same-origin fan-out).
 *
 * When `BroadcastChannel` is unavailable the function returns an
 * already-detached unsubscribe so callers don't have to gate the
 * call site themselves. The listener will never fire — that matches
 * the worker-side no-op broadcaster on the same target.
 */
export function subscribeTxApplied(
	listener: (notification: WorkerNotification) => void,
): () => void {
	if (!hasBroadcastChannel()) {
		return () => {};
	}
	const channel = new BroadcastChannel(TX_APPLIED_CHANNEL);
	const onMessage = (event: MessageEvent<WorkerNotification>): void => {
		listener(event.data);
	};
	channel.addEventListener("message", onMessage);
	return () => {
		channel.removeEventListener("message", onMessage);
		channel.close();
	};
}
