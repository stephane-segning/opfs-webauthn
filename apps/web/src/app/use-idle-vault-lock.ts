"use client";

import { useEffect, useRef } from "react";

/**
 * Cross-tab idle vault locking (ADR 0005 + ADR 0006).
 *
 * As long as ANY tab is active, it sends periodic heartbeats that reset
 * every other tab's idle clock. Once ALL tabs have been inactive for
 * `idleMs` (default 5 minutes per ADR 0005), the first tab to notice
 * broadcasts `vault-locked` and calls `onLock`.
 *
 * ### Channel protocol
 *
 * `BroadcastChannel("opfs-vault")` carries two message kinds:
 *
 * - `vault-heartbeat` — "I am active right now." Any tab that receives
 *   this resets its idle timer. Published at most once per
 *   `HEARTBEAT_INTERVAL_MS` while user events are occurring.
 * - `vault-locked` — "I have locked; please do the same." Every tab
 *   that receives this calls `onLock` immediately.
 *
 * ### Usage
 *
 * Mount this hook ONLY while the vault is open (e.g. inside
 * `NotesShell`). It cleans up every listener and closes the channel on
 * unmount, so it does NOT run when the user is already on the locked
 * screen.
 */

const CHANNEL_NAME = "opfs-vault";

/** Default idle timeout from ADR 0005. */
export const IDLE_MS_DEFAULT = 5 * 60 * 1000;

/** Heartbeat publish cadence — at most once per this interval. */
const HEARTBEAT_INTERVAL_MS = 30_000;

type VaultChannelMessage =
	| { readonly kind: "vault-heartbeat" }
	| { readonly kind: "vault-locked" };

/**
 * DOM events that reset the idle clock. `passive: true` on all so we
 * never block scrolling or input handling.
 */
const USER_EVENTS: ReadonlyArray<keyof WindowEventMap> = [
	"mousemove",
	"mousedown",
	"keydown",
	"touchstart",
	"scroll",
	"wheel",
	"click",
];

export function useIdleVaultLock(
	onLock: () => void,
	idleMs: number = IDLE_MS_DEFAULT,
): void {
	// Ref lets the effect's closure always call the *current* `onLock`
	// without needing it as an effect dependency (stable identity not
	// guaranteed from React's perspective, but the value changes safely).
	const onLockRef = useRef(onLock);
	onLockRef.current = onLock;

	const lastActivityRef = useRef(Date.now());
	// Guard so the first lock signal (local timer OR remote broadcast)
	// wins and we never call `onLock` twice.
	const lockedRef = useRef(false);

	useEffect(() => {
		const channel = new BroadcastChannel(CHANNEL_NAME);
		lockedRef.current = false;

		function lock(): void {
			if (lockedRef.current) return;
			lockedRef.current = true;
			channel.postMessage({
				kind: "vault-locked",
			} satisfies VaultChannelMessage);
			onLockRef.current();
		}

		function resetActivity(): void {
			lastActivityRef.current = Date.now();
		}

		let lastHeartbeatSent = 0;
		function sendHeartbeatIfDue(): void {
			const now = Date.now();
			if (now - lastHeartbeatSent >= HEARTBEAT_INTERVAL_MS) {
				lastHeartbeatSent = now;
				channel.postMessage({
					kind: "vault-heartbeat",
				} satisfies VaultChannelMessage);
			}
		}

		function onUserEvent(): void {
			resetActivity();
			sendHeartbeatIfDue();
		}

		function onVisibility(): void {
			if (document.visibilityState === "visible") {
				resetActivity();
				sendHeartbeatIfDue();
			}
		}

		function onMessage(ev: MessageEvent<VaultChannelMessage>): void {
			const msg = ev.data;
			if (msg.kind === "vault-heartbeat") {
				// A sibling tab is active — reset our idle clock so we
				// do not lock while the user is working elsewhere.
				resetActivity();
			} else if (msg.kind === "vault-locked") {
				// A sibling tab decided to lock — mirror it immediately
				// so all tabs reach the locked screen at the same time.
				if (!lockedRef.current) {
					lockedRef.current = true;
					onLockRef.current();
				}
			}
		}

		channel.addEventListener("message", onMessage);
		document.addEventListener("visibilitychange", onVisibility);
		for (const type of USER_EVENTS) {
			window.addEventListener(type, onUserEvent, { passive: true });
		}

		// Publish one heartbeat immediately so sibling tabs know this
		// tab is alive the moment the vault unlocks.
		onUserEvent();

		// Poll every 30 s. If we haven't heard from any tab (including
		// ourselves) for `idleMs`, fire the lock.
		const interval = setInterval(() => {
			if (Date.now() - lastActivityRef.current >= idleMs) {
				lock();
			}
		}, HEARTBEAT_INTERVAL_MS);

		return () => {
			clearInterval(interval);
			channel.removeEventListener("message", onMessage);
			document.removeEventListener("visibilitychange", onVisibility);
			for (const type of USER_EVENTS) {
				window.removeEventListener(type, onUserEvent);
			}
			channel.close();
		};
	}, [idleMs]);
}
