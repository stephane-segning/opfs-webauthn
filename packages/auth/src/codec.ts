/**
 * Small base64 (URL-safe, no padding) codec used to serialize
 * `Uint8Array` fields into the credential blob persisted in
 * `localStorage`. URL-safe so we can ship the credential in a query
 * string later if we want to.
 */

const PAD = "=";
const URL_SAFE_ALPHABET = /^[A-Za-z0-9_-]*$/;

export function bytesToBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary)
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replaceAll(PAD, "");
}

export function base64UrlToBytes(s: string): Uint8Array {
	if (!URL_SAFE_ALPHABET.test(s)) {
		throw new Error("invalid base64url input");
	}
	const padLen = (4 - (s.length % 4)) % 4;
	const padded =
		s.replaceAll("-", "+").replaceAll("_", "/") + PAD.repeat(padLen);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}
