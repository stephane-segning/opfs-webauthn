/**
 * Pickup-code shape + normalization. Lives in its own module so the
 * regex + cleanup logic stays testable without standing up the WASM
 * runtime (the rest of the share orchestration lights up the wasm
 * boundary on the first call).
 *
 * The backend accepts `[0-9A-Z]{12}`; users transcribe codes in
 * mixed case and often group them as `ABC-DEF GHI-JKL` for
 * readability. Normalize before we burn a network round-trip.
 */

/** Pickup-code length in Crockford-base32 characters. */
export const CODE_LEN = 12;

const CODE_PATTERN = /^[0-9A-Z]{12}$/;

/**
 * Trim, drop separators (whitespace and `-`), uppercase. Returns
 * `null` for any input that doesn't look like a valid code so the
 * caller can surface a typed protocol error instead of a backend
 * 404.
 */
export function normalizeCode(raw: string): string | null {
	const cleaned = raw.replace(/[\s-]+/g, "").toUpperCase();
	return CODE_PATTERN.test(cleaned) ? cleaned : null;
}
