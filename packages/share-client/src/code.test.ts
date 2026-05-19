/**
 * Code-normalization tests. Lives outside `share.ts` so the
 * canonicalization logic stays exercisable without touching the
 * WASM runtime (the rest of the share orchestration lights up wasm
 * on first call).
 */

import { describe, expect, it } from "vitest";

import { CODE_LEN, normalizeCode } from "./code.js";

describe("normalizeCode", () => {
	it("accepts a clean uppercase code", () => {
		expect(normalizeCode("ABCDEFGHJKMN")).toBe("ABCDEFGHJKMN");
	});

	it("uppercases lowercase input", () => {
		expect(normalizeCode("abcdefghjkmn")).toBe("ABCDEFGHJKMN");
	});

	it("strips spaces and dashes used as visual grouping", () => {
		expect(normalizeCode("ABC-DEF GHJ-KMN")).toBe("ABCDEFGHJKMN");
		expect(normalizeCode("ABC DEF GHJ KMN")).toBe("ABCDEFGHJKMN");
		expect(normalizeCode("  ABCDEFGHJKMN  ")).toBe("ABCDEFGHJKMN");
	});

	it("rejects codes of the wrong length", () => {
		expect(normalizeCode("ABCDEFGHJKM")).toBeNull();
		expect(normalizeCode("ABCDEFGHJKMNQ")).toBeNull();
		expect(normalizeCode("")).toBeNull();
	});

	it("rejects characters outside Crockford-base32", () => {
		// `?` is not in the alphabet at all.
		expect(normalizeCode("ABCDEFGHJKM?")).toBeNull();
	});

	it("rejects an empty string after stripping", () => {
		expect(normalizeCode("---")).toBeNull();
	});

	it("expects exactly CODE_LEN characters after normalization", () => {
		expect(CODE_LEN).toBe(12);
		const grouped = "ABC-DEF-GHJ-KMN";
		const result = normalizeCode(grouped);
		expect(result).not.toBeNull();
		expect((result as string).length).toBe(CODE_LEN);
	});
});
