/**
 * Codec tests for the mint-response framing. The Rust encoder lives
 * in `apps/share-backend/src/handlers.rs::encode_mint_response`; if
 * either side drifts on byte layout, the share flow's first
 * round-trip breaks. These tests pin the layout from the JS side.
 */

import { COMMITMENT_CODE_LEN, PROTOCOL_VERSION } from "@opfs/core-wasm";
import { describe, expect, it } from "vitest";

import { ShareError } from "./errors.js";
import {
	decodeMintResponse,
	encodeMintResponse,
	MINT_RESPONSE_LEN,
} from "./mint-response.js";

const SAMPLE_CODE = "ABCDEFGHJKMN";

describe("MINT_RESPONSE_LEN", () => {
	it("is exactly version + u64 + code length", () => {
		expect(MINT_RESPONSE_LEN).toBe(1 + 8 + COMMITMENT_CODE_LEN);
	});
});

describe("encodeMintResponse / decodeMintResponse", () => {
	it("roundtrips a representative value", () => {
		const bytes = encodeMintResponse({
			code: SAMPLE_CODE,
			expiresAt: 1_700_000_000,
		});
		expect(bytes.length).toBe(MINT_RESPONSE_LEN);
		const decoded = decodeMintResponse(bytes);
		expect(decoded).toEqual({ code: SAMPLE_CODE, expiresAt: 1_700_000_000 });
	});

	it("places the version, BE u64, and ASCII code at known offsets", () => {
		// 0x0001_0203_0405_0607 = 281,479,272,432,135 — well within
		// Number.MAX_SAFE_INTEGER while still hitting every byte of
		// the u64. Using a value that exercises all 8 bytes catches
		// endianness drift on either side.
		const bytes = encodeMintResponse({
			code: SAMPLE_CODE,
			expiresAt: 0x0001_0203_0405_0607,
		});
		expect(bytes[0]).toBe(PROTOCOL_VERSION);
		// Big-endian: high byte first.
		expect(Array.from(bytes.subarray(1, 9))).toEqual([
			0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07,
		]);
		expect(new TextDecoder("ascii").decode(bytes.subarray(9))).toBe(
			SAMPLE_CODE,
		);
	});

	it("handles expiresAt = 0 and expiresAt at Number.MAX_SAFE_INTEGER", () => {
		const zero = encodeMintResponse({ code: SAMPLE_CODE, expiresAt: 0 });
		expect(decodeMintResponse(zero).expiresAt).toBe(0);

		const big = encodeMintResponse({
			code: SAMPLE_CODE,
			expiresAt: Number.MAX_SAFE_INTEGER,
		});
		expect(decodeMintResponse(big).expiresAt).toBe(Number.MAX_SAFE_INTEGER);
	});

	it("rejects a wrong-length code", () => {
		expect(() =>
			encodeMintResponse({ code: "TOO-SHORT", expiresAt: 1 }),
		).toThrowError(ShareError);
	});

	it("rejects non-ASCII codepoints in the code", () => {
		// 12 chars total but one is non-ASCII.
		const sneaky = `AAAAAAAAAAAé`;
		expect(sneaky.length).toBe(COMMITMENT_CODE_LEN);
		expect(() =>
			encodeMintResponse({ code: sneaky, expiresAt: 1 }),
		).toThrowError(ShareError);
	});

	it("rejects a non-integer expiresAt", () => {
		expect(() =>
			encodeMintResponse({ code: SAMPLE_CODE, expiresAt: 1.5 }),
		).toThrowError(ShareError);
	});

	it("decode rejects a short buffer", () => {
		expect(() => decodeMintResponse(new Uint8Array(20))).toThrowError(
			ShareError,
		);
	});

	it("decode rejects an unknown version byte", () => {
		const valid = encodeMintResponse({ code: SAMPLE_CODE, expiresAt: 1 });
		const tampered = new Uint8Array(valid);
		tampered[0] = 0xff;
		expect(() => decodeMintResponse(tampered)).toThrowError(ShareError);
	});

	it("decode rejects non-ASCII bytes in the code region", () => {
		const valid = encodeMintResponse({ code: SAMPLE_CODE, expiresAt: 1 });
		const tampered = new Uint8Array(valid);
		tampered[15] = 0xff; // somewhere inside the code segment
		expect(() => decodeMintResponse(tampered)).toThrowError(ShareError);
	});

	it("decode rejects an expiresAt above Number.MAX_SAFE_INTEGER", () => {
		// Hand-build a 21-byte payload with `hi` set so the resulting
		// u64 exceeds 2^53 - 1. The decoder must refuse rather than
		// silently losing precision.
		const bytes = new Uint8Array(MINT_RESPONSE_LEN);
		bytes[0] = PROTOCOL_VERSION;
		// hi = 0x0020_0000, lo = 0 → value = 2^53, just past max-safe.
		bytes[1] = 0x00;
		bytes[2] = 0x20;
		bytes[3] = 0x00;
		bytes[4] = 0x00;
		bytes[5] = 0x00;
		bytes[6] = 0x00;
		bytes[7] = 0x00;
		bytes[8] = 0x00;
		for (let i = 0; i < COMMITMENT_CODE_LEN; i++) {
			bytes[9 + i] = SAMPLE_CODE.charCodeAt(i);
		}
		expect(() => decodeMintResponse(bytes)).toThrowError(ShareError);
	});
});
