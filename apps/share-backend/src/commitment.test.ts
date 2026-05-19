/**
 * Commitment-parity tests. The JS derivation must match the Rust
 * `opfs-crypto::commitment` crate byte-for-byte, otherwise the
 * sender's WASM-side `verify_code` would refuse server-issued codes
 * and the share flow silently breaks.
 */

import { describe, expect, it } from "vitest";

import { CODE_LEN, codeForPubkey } from "./commitment.js";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]+$/;

describe("codeForPubkey", () => {
	it("emits 12 Crockford-base32 characters", () => {
		const code = codeForPubkey(new Uint8Array(32).fill(9));
		expect(code).toHaveLength(CODE_LEN);
		expect(code).toMatch(CROCKFORD);
	});

	it("is deterministic for the same input", () => {
		const epk = Uint8Array.from([1, 2, 3, 4, 5]);
		expect(codeForPubkey(epk)).toEqual(codeForPubkey(epk));
	});

	it("collides only at the 60-bit truncation horizon", () => {
		const a = codeForPubkey(new Uint8Array(32).fill(0));
		const b = codeForPubkey(new Uint8Array(32).fill(1));
		expect(a).not.toEqual(b);
	});

	// Reference vector: `cargo run -p opfs-crypto --example dump_code`
	// printed `FA31QBAS6ZFG` for an all-`9` epk. Pinning it here means
	// any algorithmic drift (alphabet ordering, mask byte, truncation
	// length) is caught the moment the JS and Rust ports disagree.
	it("matches the Rust reference vector for epk = [9; 32]", () => {
		const code = codeForPubkey(new Uint8Array(32).fill(9));
		expect(code).toEqual("FA31QBAS6ZFG");
	});
});
