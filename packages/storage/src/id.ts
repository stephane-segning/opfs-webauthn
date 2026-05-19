/**
 * Random 128-bit row ids encoded as Crockford base32. Per ADR 0004 we
 * deliberately do NOT use ULIDs / UUIDv7 — their embedded timestamps
 * would leak into the plaintext primary key column and defeat the
 * day-quantization on `updated_day`.
 */

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const ROW_ID_BYTES = 16;
export const ROW_ID_CHARS = 26; // ceil(128 / 5)

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	const buf = new Uint8Array(new ArrayBuffer(length));
	crypto.getRandomValues(buf);
	return buf;
}

/** Generate a fresh random 16-byte id, Crockford-base32 encoded. */
export function generateRowId(): string {
	return encodeRowId(randomBytes(ROW_ID_BYTES));
}

/** Encode 16 bytes as 26 Crockford-base32 chars (left-padded with 0s). */
export function encodeRowId(bytes: Uint8Array): string {
	if (bytes.length !== ROW_ID_BYTES) {
		throw new Error(`rowId must be ${ROW_ID_BYTES} bytes, got ${bytes.length}`);
	}
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += CROCKFORD[(value >>> bits) & 0b11111];
		}
	}
	if (bits > 0) {
		out += CROCKFORD[(value << (5 - bits)) & 0b11111];
	}
	return out;
}

/** Decode a 26-char Crockford-base32 id back into its 16 bytes. */
export function decodeRowId(id: string): Uint8Array {
	if (id.length !== ROW_ID_CHARS) {
		throw new Error(`rowId must be ${ROW_ID_CHARS} chars, got ${id.length}`);
	}
	const bytes = new Uint8Array(ROW_ID_BYTES);
	let bits = 0;
	let value = 0;
	let i = 0;
	for (const ch of id) {
		const v = CROCKFORD.indexOf(ch.toUpperCase());
		if (v < 0) throw new Error(`rowId contains non-Crockford char ${ch}`);
		value = (value << 5) | v;
		bits += 5;
		if (bits >= 8) {
			bits -= 8;
			bytes[i++] = (value >>> bits) & 0xff;
		}
	}
	return bytes;
}
