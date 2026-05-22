/**
 * Behavioural tests for `IdleLockCoordinator` — the pure logic the
 * `useIdleVaultLock` React hook adapts. Driving the coordinator with
 * a fake clock + fake `publish` callback lets us exercise every
 * timing-sensitive branch without `jsdom` or a real BroadcastChannel.
 *
 * Scenarios covered:
 *   - `noteActivity()` debounces heartbeat publishes
 *   - `tick()` does NOT lock before the idle window expires
 *   - `tick()` locks after the idle window expires and broadcasts
 *     `vault-locked`
 *   - A remote heartbeat resets the idle clock, keeping the tab alive
 *   - A remote `vault-locked` mirrors the lock without re-publishing
 *     (no broadcast loop)
 *   - Once locked, further activity / ticks / messages are no-ops
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	HEARTBEAT_INTERVAL_MS,
	IDLE_MS_DEFAULT,
	IdleLockCoordinator,
	type VaultChannelMessage,
} from "./idle-lock-coordinator.js";

describe("IDLE_MS_DEFAULT", () => {
	it("is exactly 5 minutes (ADR 0005)", () => {
		expect(IDLE_MS_DEFAULT).toBe(5 * 60 * 1000);
	});
});

describe("HEARTBEAT_INTERVAL_MS", () => {
	it("is 30 seconds — short enough that idle siblings notice quickly", () => {
		expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
	});
});

type Harness = {
	readonly coord: IdleLockCoordinator;
	readonly onLock: ReturnType<typeof vi.fn>;
	readonly publish: ReturnType<
		typeof vi.fn<(msg: VaultChannelMessage) => void>
	>;
	advance(ms: number): void;
	clock(): number;
};

function makeHarness(opts?: { idleMs?: number }): Harness {
	let now = 1_000_000_000_000; // arbitrary epoch ms
	const onLock = vi.fn();
	const publish = vi.fn<(msg: VaultChannelMessage) => void>();
	const coord = new IdleLockCoordinator({
		onLock,
		publish,
		now: () => now,
		idleMs: opts?.idleMs,
	});
	return {
		coord,
		onLock,
		publish,
		advance(ms) {
			now += ms;
		},
		clock() {
			return now;
		},
	};
}

describe("IdleLockCoordinator.noteActivity", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
	});

	it("publishes a heartbeat on the first call", () => {
		h.coord.noteActivity();
		expect(h.publish).toHaveBeenCalledTimes(1);
		expect(h.publish).toHaveBeenCalledWith({ kind: "vault-heartbeat" });
	});

	it("debounces heartbeat publishes within the heartbeat interval", () => {
		h.coord.noteActivity();
		h.advance(HEARTBEAT_INTERVAL_MS - 1);
		h.coord.noteActivity();
		h.coord.noteActivity();
		expect(h.publish).toHaveBeenCalledTimes(1);
	});

	it("publishes another heartbeat once the interval has elapsed", () => {
		h.coord.noteActivity();
		h.advance(HEARTBEAT_INTERVAL_MS);
		h.coord.noteActivity();
		expect(h.publish).toHaveBeenCalledTimes(2);
	});

	it("does nothing after the coordinator has locked", () => {
		h.coord.noteActivity();
		h.advance(IDLE_MS_DEFAULT);
		h.coord.tick(); // triggers the lock
		expect(h.coord.locked).toBe(true);
		h.publish.mockClear();
		h.coord.noteActivity();
		expect(h.publish).not.toHaveBeenCalled();
	});
});

describe("IdleLockCoordinator.tick", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
		// One heartbeat establishes the baseline lastActivity = now.
		h.coord.noteActivity();
		h.publish.mockClear();
	});

	it("does not lock before idleMs has elapsed", () => {
		h.advance(IDLE_MS_DEFAULT - 1);
		h.coord.tick();
		expect(h.coord.locked).toBe(false);
		expect(h.onLock).not.toHaveBeenCalled();
		expect(h.publish).not.toHaveBeenCalled();
	});

	it("locks at exactly idleMs", () => {
		h.advance(IDLE_MS_DEFAULT);
		h.coord.tick();
		expect(h.coord.locked).toBe(true);
		expect(h.onLock).toHaveBeenCalledTimes(1);
		expect(h.publish).toHaveBeenCalledWith({ kind: "vault-locked" });
	});

	it("locks past idleMs", () => {
		h.advance(IDLE_MS_DEFAULT + 60_000);
		h.coord.tick();
		expect(h.coord.locked).toBe(true);
		expect(h.onLock).toHaveBeenCalledTimes(1);
	});

	it("is idempotent: a second tick after locking does nothing extra", () => {
		h.advance(IDLE_MS_DEFAULT);
		h.coord.tick();
		h.publish.mockClear();
		h.onLock.mockClear();
		h.advance(IDLE_MS_DEFAULT);
		h.coord.tick();
		expect(h.onLock).not.toHaveBeenCalled();
		expect(h.publish).not.toHaveBeenCalled();
	});
});

describe("IdleLockCoordinator.receive", () => {
	let h: Harness;
	beforeEach(() => {
		h = makeHarness();
		h.coord.noteActivity();
		h.publish.mockClear();
	});

	it("vault-heartbeat from a sibling resets the idle clock", () => {
		// Almost-idle. A sibling heartbeat lands; we should NOT lock
		// on the next tick because lastActivity just bumped to now.
		h.advance(IDLE_MS_DEFAULT - 1_000);
		h.coord.receive({ kind: "vault-heartbeat" });
		h.advance(IDLE_MS_DEFAULT - 1);
		h.coord.tick();
		expect(h.coord.locked).toBe(false);
	});

	it("vault-heartbeat does NOT publish back (no broadcast storms)", () => {
		h.coord.receive({ kind: "vault-heartbeat" });
		expect(h.publish).not.toHaveBeenCalled();
	});

	it("vault-locked mirrors the lock locally and does NOT re-publish", () => {
		h.coord.receive({ kind: "vault-locked" });
		expect(h.coord.locked).toBe(true);
		expect(h.onLock).toHaveBeenCalledTimes(1);
		// Critical: the receiving tab must not re-broadcast, otherwise
		// every tab would echo and we'd see N-1 redundant messages.
		expect(h.publish).not.toHaveBeenCalled();
	});

	it("ignores messages received after this coordinator already locked", () => {
		h.advance(IDLE_MS_DEFAULT);
		h.coord.tick();
		h.onLock.mockClear();
		h.publish.mockClear();
		h.coord.receive({ kind: "vault-heartbeat" });
		h.coord.receive({ kind: "vault-locked" });
		expect(h.onLock).not.toHaveBeenCalled();
		expect(h.publish).not.toHaveBeenCalled();
	});
});

describe("IdleLockCoordinator full scenarios", () => {
	it("two-tab dance: active tab keeps idle tab alive", () => {
		// Simulate two coordinators sharing a fake channel. Tab A is
		// active; Tab B is idle and would lock by itself, but tab A's
		// heartbeats reach it and reset its clock.
		let now = 0;
		const bus: VaultChannelMessage[] = [];
		const onLockA = vi.fn();
		const onLockB = vi.fn();
		const a = new IdleLockCoordinator({
			onLock: onLockA,
			publish: (m) => bus.push(m),
			now: () => now,
		});
		const b = new IdleLockCoordinator({
			onLock: onLockB,
			publish: (m) => bus.push(m),
			now: () => now,
		});

		// Helper that drains the bus to every coordinator EXCEPT the
		// sender. For simplicity we just re-deliver everything to both
		// (a coordinator ignores messages after it locks anyway, and
		// `noteActivity`+`receive` only differ in publish behaviour).
		const deliverToBoth = (): void => {
			while (bus.length > 0) {
				const msg = bus.shift();
				if (!msg) break;
				a.receive(msg);
				b.receive(msg);
			}
		};

		// t=0 — both mount, both publish their first heartbeat.
		a.noteActivity();
		b.noteActivity();
		deliverToBoth();

		// For 10 minutes, tab A is active every 30 s. Tab B never
		// touches its mouse. Tick both every 30 s. Tab B should not lock.
		for (let elapsed = 0; elapsed < 10 * 60 * 1000; elapsed += 30_000) {
			now += 30_000;
			a.noteActivity(); // publishes a heartbeat every 30 s
			deliverToBoth();
			a.tick();
			b.tick();
		}

		expect(onLockA).not.toHaveBeenCalled();
		expect(onLockB).not.toHaveBeenCalled();
		expect(a.locked).toBe(false);
		expect(b.locked).toBe(false);
	});

	it("both tabs idle for 5 min: first to tick locks, the other mirrors", () => {
		let now = 0;
		const bus: VaultChannelMessage[] = [];
		const onLockA = vi.fn();
		const onLockB = vi.fn();
		const a = new IdleLockCoordinator({
			onLock: onLockA,
			publish: (m) => bus.push(m),
			now: () => now,
		});
		const b = new IdleLockCoordinator({
			onLock: onLockB,
			publish: (m) => bus.push(m),
			now: () => now,
		});
		const deliverToBoth = (): void => {
			while (bus.length > 0) {
				const msg = bus.shift();
				if (!msg) break;
				a.receive(msg);
				b.receive(msg);
			}
		};

		a.noteActivity();
		b.noteActivity();
		deliverToBoth();

		// 5 minutes pass with no activity from either tab.
		now += IDLE_MS_DEFAULT;
		// Tab A's tick fires first.
		a.tick();
		expect(onLockA).toHaveBeenCalledTimes(1);
		expect(a.locked).toBe(true);
		// The vault-locked message is in the bus.
		expect(bus).toEqual([{ kind: "vault-locked" }]);
		deliverToBoth();
		// Tab B mirrors.
		expect(onLockB).toHaveBeenCalledTimes(1);
		expect(b.locked).toBe(true);
		// Tab B's subsequent tick is a no-op.
		b.tick();
		expect(onLockB).toHaveBeenCalledTimes(1);
	});
});
