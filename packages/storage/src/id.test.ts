import { beforeAll, describe, expect, it } from "vitest";

import {
	decodeRowId,
	encodeRowId,
	generateRowId,
	ROW_ID_BYTES,
	ROW_ID_CHARS,
} from "./id.js";
import { ensureWasm } from "./wasm.js";

// The id codec lives in `opfs-repo` (wasm) — every test needs the
// bindings loaded before the first call. `ensureWasm` is idempotent;
// vitest's beforeAll guarantees it runs once per file before any
// test body. See `wasm.ts` for the node-vs-browser init paths.
beforeAll(ensureWasm);

describe("rowId codec", () => {
	it("round-trips arbitrary 16-byte payloads", () => {
		const fixtures: Uint8Array[] = [
			new Uint8Array(16),
			new Uint8Array(16).fill(0xff),
			Uint8Array.from({ length: 16 }, (_, i) => i * 17),
			Uint8Array.from({ length: 16 }, (_, i) => (i * 31) & 0xff),
		];
		for (const bytes of fixtures) {
			const encoded = encodeRowId(bytes);
			expect(encoded).toHaveLength(ROW_ID_CHARS);
			expect(decodeRowId(encoded)).toEqual(bytes);
		}
	});

	it("rejects payloads of the wrong length", () => {
		// The wasm-side `encodeRowId` throws a `JsError` whose message
		// carries the expected/got lengths. Match substring rather than
		// the exact text so the test survives minor Rust-side rewording.
		expect(() => encodeRowId(new Uint8Array(15))).toThrow(/16/);
		expect(() => encodeRowId(new Uint8Array(17))).toThrow(/16/);
		expect(() => decodeRowId("ABC")).toThrow(/26/);
	});

	it("rejects non-Crockford characters", () => {
		// Replace the last char with 'U' which is not in Crockford base32.
		const bad = `${generateRowId().slice(0, ROW_ID_CHARS - 1)}U`;
		expect(() => decodeRowId(bad)).toThrow(/Crockford/);
	});

	it("generateRowId produces 26 Crockford chars", () => {
		for (let i = 0; i < 16; i++) {
			const id = generateRowId();
			expect(id).toHaveLength(ROW_ID_CHARS);
			expect(id).toMatch(/^[0-9A-Z]+$/);
		}
	});

	it("generates distinct ids on repeated calls", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 64; i++) seen.add(generateRowId());
		expect(seen.size).toBe(64);
	});

	it("ROW_ID_BYTES and ROW_ID_CHARS are consistent", () => {
		// 26 chars × 5 bits = 130 bits; we emit exactly 16 bytes (128 bits)
		// with the last char carrying 3 bits of payload + 2 bits of zero
		// padding. Round-trip preserves the bytes regardless.
		expect(ROW_ID_CHARS).toBe(Math.ceil((ROW_ID_BYTES * 8) / 5));
	});
});
