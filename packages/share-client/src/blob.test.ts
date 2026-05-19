/**
 * Codec parity tests. Roundtrip + boundary cases for the wire
 * framing — the share flow refuses anything it can't unambiguously
 * parse, so these guards have to hold across protocol revisions.
 */

import { describe, expect, it } from "vitest";

import {
	decodeShareBlob,
	encodeShareBlob,
	SHARE_BLOB_HEADER_LEN,
} from "./blob.js";
import { ShareError } from "./errors.js";

const PUBKEY = new Uint8Array(32).fill(7);
const NONCE = new Uint8Array(12).fill(3);

describe("encodeShareBlob / decodeShareBlob", () => {
	it("round-trips through the binary framing", () => {
		const ciphertext = Uint8Array.from([0xaa, 0xbb, 0xcc]);
		const encoded = encodeShareBlob({
			senderPubkey: PUBKEY,
			nonce: NONCE,
			ciphertext,
		});
		expect(encoded.length).toBe(SHARE_BLOB_HEADER_LEN + ciphertext.length);
		expect(encoded[0]).toBe(1);
		const parts = decodeShareBlob(encoded);
		expect(parts.senderPubkey).toEqual(PUBKEY);
		expect(parts.nonce).toEqual(NONCE);
		expect(parts.ciphertext).toEqual(ciphertext);
	});

	it("rejects a senderPubkey of the wrong length", () => {
		expect(() =>
			encodeShareBlob({
				senderPubkey: new Uint8Array(31),
				nonce: NONCE,
				ciphertext: new Uint8Array(),
			}),
		).toThrowError(ShareError);
	});

	it("rejects a nonce of the wrong length", () => {
		expect(() =>
			encodeShareBlob({
				senderPubkey: PUBKEY,
				nonce: new Uint8Array(11),
				ciphertext: new Uint8Array(),
			}),
		).toThrowError(ShareError);
	});

	it("rejects a truncated blob shorter than the header", () => {
		expect(() =>
			decodeShareBlob(new Uint8Array(SHARE_BLOB_HEADER_LEN - 1)),
		).toThrowError(ShareError);
	});

	it("rejects a blob with an unknown protocol version", () => {
		const bogus = new Uint8Array(SHARE_BLOB_HEADER_LEN);
		bogus[0] = 0x99;
		expect(() => decodeShareBlob(bogus)).toThrowError(ShareError);
	});

	it("allows an empty ciphertext (degenerate but well-formed)", () => {
		const encoded = encodeShareBlob({
			senderPubkey: PUBKEY,
			nonce: NONCE,
			ciphertext: new Uint8Array(),
		});
		const parts = decodeShareBlob(encoded);
		expect(parts.ciphertext.length).toBe(0);
	});

	it("returns independent buffers from decode (caller-safe mutation)", () => {
		const encoded = encodeShareBlob({
			senderPubkey: PUBKEY,
			nonce: NONCE,
			ciphertext: Uint8Array.from([1, 2, 3]),
		});
		const parts = decodeShareBlob(encoded);
		parts.senderPubkey.fill(0);
		// Mutating the decoded view must not poison the source buffer.
		expect(encoded.slice(1, 33)).toEqual(PUBKEY);
	});
});
