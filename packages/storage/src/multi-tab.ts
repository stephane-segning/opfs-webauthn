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
 */

import type { WorkerNotification } from "./rpc.js";

/**
 * BroadcastChannel name carrying `tx-applied` (and any future
 * fan-out events). Reserved for notifications only: RPC always
 * rides a private `MessagePort`.
 */
export const TX_APPLIED_CHANNEL = "opfs-storage-tx";

/**
 * Page-side subscription. Returns an unsubscribe function. The
 * listener fires for every `tx-applied` envelope posted on
 * `TX_APPLIED_CHANNEL`, regardless of which tab / worker emitted
 * it (BC same-origin fan-out).
 *
 * `BroadcastChannel` is exposed on every modern target browser and
 * on Node ≥ 18, which keeps the same code path usable in vitest
 * without polyfills.
 */
export function subscribeTxApplied(
	listener: (notification: WorkerNotification) => void,
): () => void {
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
