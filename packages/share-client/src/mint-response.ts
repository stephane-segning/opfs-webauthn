/**
 * Wire codec for `POST /rendezvous` responses, mirroring the Rust
 * encoder in `apps/share-backend/src/handlers.rs::encode_mint_response`.
 *
 * Fixed-layout binary framing (21 bytes total):
 *
 * ```
 * offset  size  field
 * 0       1     version (u8, = PROTOCOL_VERSION)
 * 1       8     expiresAt (u64 big-endian, unix seconds)
 * 9       12    code (ASCII Crockford-base32, fixed COMMITMENT_CODE_LEN)
 * ```
 *
 * Why not CBOR: keeps the JS side dependency-free and matches the
 * existing `ShareBlob` framing in `./blob.ts`. The fields are
 * fixed-width, so the framing is unambiguous without a self-
 * describing format.
 *
 * `expiresAt` is read as a `Number`. The Crockford-base32 code is
 * ASCII-only by construction; the decoder rejects anything else.
 */

import { COMMITMENT_CODE_LEN, PROTOCOL_VERSION } from "@opfs/core-wasm";

import { ShareError } from "./errors.js";

/** Total byte length of a valid mint response. */
export const MINT_RESPONSE_LEN = 1 + 8 + COMMITMENT_CODE_LEN;

export type MintResponseParts = {
	readonly code: string;
	readonly expiresAt: number;
};

/**
 * Encode a mint response. Exported for symmetry with `blob.ts`'s
 * `encodeShareBlob` and used by transport tests; production JS only
 * decodes (the encoder lives in the Rust backend).
 */
export function encodeMintResponse(parts: MintResponseParts): Uint8Array {
	if (parts.code.length !== COMMITMENT_CODE_LEN) {
		throw new ShareError(
			"protocol",
			`code must be ${COMMITMENT_CODE_LEN} chars, got ${parts.code.length}`,
		);
	}
	if (!Number.isInteger(parts.expiresAt) || parts.expiresAt < 0) {
		throw new ShareError(
			"protocol",
			`expiresAt must be a non-negative integer, got ${parts.expiresAt}`,
		);
	}
	const out = new Uint8Array(MINT_RESPONSE_LEN);
	out[0] = PROTOCOL_VERSION;
	// Big-endian u64. JS Number only carries 53 bits of integer
	// precision; we split into hi/lo to put 4 bytes from each in
	// the right order without pulling in a BigInt dance.
	const hi = Math.floor(parts.expiresAt / 0x1_0000_0000);
	const lo = parts.expiresAt >>> 0;
	const view = new DataView(out.buffer, out.byteOffset, MINT_RESPONSE_LEN);
	view.setUint32(1, hi, false);
	view.setUint32(5, lo, false);
	for (let i = 0; i < COMMITMENT_CODE_LEN; i++) {
		const charCode = parts.code.charCodeAt(i);
		if (charCode > 0x7f) {
			throw new ShareError(
				"protocol",
				`code must be ASCII; saw codepoint ${charCode} at index ${i}`,
			);
		}
		out[9 + i] = charCode;
	}
	return out;
}

/**
 * Decode a mint response. Throws a typed `ShareError("protocol")` on
 * any framing violation so transport-layer callers don't have to
 * untangle a generic `RangeError` or `TypeError` from the runtime.
 */
export function decodeMintResponse(bytes: Uint8Array): MintResponseParts {
	if (bytes.length !== MINT_RESPONSE_LEN) {
		throw new ShareError(
			"protocol",
			`mint response must be exactly ${MINT_RESPONSE_LEN} bytes, got ${bytes.length}`,
		);
	}
	const version = bytes[0];
	if (version !== PROTOCOL_VERSION) {
		throw new ShareError(
			"protocol",
			`unknown mint-response version ${version}, expected ${PROTOCOL_VERSION}`,
		);
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, MINT_RESPONSE_LEN);
	const hi = view.getUint32(1, false);
	const lo = view.getUint32(5, false);
	// Reassemble. If `hi` has bits above 2^21 we'd exceed
	// Number.MAX_SAFE_INTEGER; unix-seconds timestamps are nowhere
	// near that for centuries, but reject explicitly rather than
	// silently lose precision.
	if (hi > 0x001f_ffff) {
		throw new ShareError(
			"protocol",
			"mint response expiresAt exceeds Number.MAX_SAFE_INTEGER",
		);
	}
	const expiresAt = hi * 0x1_0000_0000 + lo;
	// Validate ASCII before string-decoding so the message points at
	// the offending byte. TextDecoder("utf-8", {fatal:true}) would
	// only say "bytes invalid".
	for (let i = 9; i < MINT_RESPONSE_LEN; i++) {
		// Length is bounds-checked above, so the indexed read is
		// always defined — we just need to convince TS strictNullChecks.
		const b = bytes[i] as number;
		if (b > 0x7f) {
			throw new ShareError(
				"protocol",
				`mint response code byte at offset ${i} is non-ASCII: 0x${b.toString(16)}`,
			);
		}
	}
	const code = String.fromCharCode(...bytes.subarray(9, MINT_RESPONSE_LEN));
	return { code, expiresAt };
}
