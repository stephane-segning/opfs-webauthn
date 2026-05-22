/**
 * Unit tests for the idle vault lock module.
 *
 * The `useIdleVaultLock` hook itself requires a React + jsdom
 * environment with `@testing-library/react` to test behaviorally.
 * That is tracked as a follow-up; this file covers the exported
 * constant so we catch accidental drift from ADR 0005.
 */

import { describe, expect, it } from "vitest";

import { IDLE_MS_DEFAULT } from "./use-idle-vault-lock.js";

describe("IDLE_MS_DEFAULT", () => {
	it("is exactly 5 minutes (ADR 0005)", () => {
		expect(IDLE_MS_DEFAULT).toBe(5 * 60 * 1000);
	});

	it("is measured in milliseconds and exceeds 1 minute", () => {
		// Sanity guard: if someone accidentally writes `5` (seconds)
		// or `300_000_000` (nanoseconds) the vault would either lock
		// instantly or never.
		expect(IDLE_MS_DEFAULT).toBeGreaterThan(60_000);
		expect(IDLE_MS_DEFAULT).toBeLessThan(60 * 60 * 1000);
	});
});
