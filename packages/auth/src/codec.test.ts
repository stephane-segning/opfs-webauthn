import { describe, expect, it } from "vitest";

import { base64UrlToBytes, bytesToBase64Url } from "./codec.js";

describe("base64url codec", () => {
	it("round-trips arbitrary byte arrays", () => {
		const cases: Uint8Array[] = [
			new Uint8Array(0),
			new Uint8Array([0]),
			new Uint8Array([0xff]),
			new Uint8Array([1, 2, 3]),
			new Uint8Array([0xfb, 0xff, 0xbf]),
			Uint8Array.from({ length: 32 }, (_, i) => i),
			Uint8Array.from({ length: 47 }, (_, i) => (i * 17) & 0xff),
		];
		for (const bytes of cases) {
			expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
		}
	});

	it("emits url-safe alphabet without padding", () => {
		const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0xfa]);
		const encoded = bytesToBase64Url(bytes);
		expect(encoded).not.toMatch(/[+/=]/);
		expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("rejects non-url-safe input", () => {
		expect(() => base64UrlToBytes("not base64 +=")).toThrow(/base64url/);
	});

	it("handles inputs that need 1, 2, or 3 bytes of padding", () => {
		// length % 4 of the encoded form drives the padding count.
		const a = bytesToBase64Url(new Uint8Array([0xaa])); // needs 2 pad chars
		const b = bytesToBase64Url(new Uint8Array([0xaa, 0xbb])); // needs 1 pad char
		const c = bytesToBase64Url(new Uint8Array([0xaa, 0xbb, 0xcc])); // needs 0 pad chars
		expect(base64UrlToBytes(a)).toEqual(new Uint8Array([0xaa]));
		expect(base64UrlToBytes(b)).toEqual(new Uint8Array([0xaa, 0xbb]));
		expect(base64UrlToBytes(c)).toEqual(new Uint8Array([0xaa, 0xbb, 0xcc]));
	});
});
