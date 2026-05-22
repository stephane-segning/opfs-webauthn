"use client";

import { useEffect, useRef } from "react";

import {
	HEARTBEAT_INTERVAL_MS,
	IDLE_MS_DEFAULT,
	IdleLockCoordinator,
	type VaultChannelMessage,
} from "./idle-lock-coordinator.js";

export { IDLE_MS_DEFAULT } from "./idle-lock-coordinator.js";

/**
 * Cross-tab idle vault locking (ADR 0005 + ADR 0006).
 *
 * Thin React adapter over `IdleLockCoordinator`: wires DOM events,
 * the `visibilitychange` listener, the periodic tick, and a real
 * `BroadcastChannel("opfs-vault")` to the pure coordinator. All
 * timing-sensitive logic lives in the coordinator and is unit-tested
 * with a fake clock there.
 *
 * Mount this hook ONLY while the vault is open (e.g. inside
 * `NotesShell`). The cleanup function tears down every listener and
 * closes the channel, so it does NOT run when the user is on the
 * locked screen.
 */

const CHANNEL_NAME = "opfs-vault";

/**
 * DOM events that count as user activity. `passive: true` on all so
 * we never block scrolling or input handling.
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
	// Ref so the effect's closure always calls the *current* `onLock`
	// (React doesn't guarantee a stable identity, and we don't want
	// to tear down the channel on every parent re-render).
	const onLockRef = useRef(onLock);
	onLockRef.current = onLock;

	useEffect(() => {
		const channel = new BroadcastChannel(CHANNEL_NAME);
		const coord = new IdleLockCoordinator({
			onLock: () => onLockRef.current(),
			publish: (msg) => channel.postMessage(msg),
			now: Date.now,
			idleMs,
		});

		function onUserEvent(): void {
			coord.noteActivity();
		}
		function onVisibility(): void {
			if (document.visibilityState === "visible") coord.noteActivity();
		}
		function onMessage(ev: MessageEvent<VaultChannelMessage>): void {
			coord.receive(ev.data);
		}

		channel.addEventListener("message", onMessage);
		document.addEventListener("visibilitychange", onVisibility);
		for (const type of USER_EVENTS) {
			window.addEventListener(type, onUserEvent, { passive: true });
		}

		// Publish one heartbeat immediately so sibling tabs know this
		// tab is alive the moment the vault unlocks.
		coord.noteActivity();

		const interval = setInterval(() => coord.tick(), HEARTBEAT_INTERVAL_MS);

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
