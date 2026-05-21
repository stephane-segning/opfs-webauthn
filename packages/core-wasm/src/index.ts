/**
 * `@opfs/core-wasm` — typed re-export over the wasm-bindgen output in
 * `./dist`. Run `pnpm --filter @opfs/core-wasm build` (or rely on
 * Turbo) to generate that dist before importing this package.
 *
 * Use:
 * ```ts
 * import init, { CryptoVault, codeForPubkey } from "@opfs/core-wasm";
 * await init();
 *
 * // Wasm generates the DEK + wrap nonce inside the module
 * // (crypto.getRandomValues via getrandom). The raw key bytes never
 * // cross back into JS — see ADR 0005.
 * const enroll = CryptoVault.enroll(prfOutput, prfSalt);
 * persistToOPFS({ wrappedDek: enroll.wrappedDek, wrapNonce: enroll.wrapNonce });
 * const vault = enroll.takeVault();
 *
 * // Cold-start unlock:
 * const reopened = CryptoVault.unlock(prfOutput, prfSalt, wrappedDek, wrapNonce);
 * ```
 */

export type {
	InitInput,
	InitOutput,
	SyncInitInput,
} from "../dist/opfs_core.js";
export {
	aadFor,
	aesGcmNonceLen,
	aesGcmTagLen,
	CryptoVault,
	codeForPubkey,
	commitmentCodeLen,
	decodeRowId,
	default,
	default as init,
	dekLen,
	EnrollResult,
	encodeRowId,
	initSync,
	protocolVersion,
	RecipientHandle,
	rowAad,
	rowIdBytes,
	rowIdChars,
	SealedShare,
	schemaSql,
	schemaVersion,
	sealShare,
	verifyCode,
	x25519PubkeyLen,
} from "../dist/opfs_core.js";

// Compile-time constants. Mirror the values the wasm functions return
// at runtime, so callers can use them in static positions (type bounds,
// default values, etc.) without first awaiting `init()`. Keep them in
// sync with the Rust constants by hand — they are short enough that
// drift is obvious in review.
export const PROTOCOL_VERSION = 1 as const;
export const X25519_PUBKEY_LEN = 32 as const;
export const COMMITMENT_CODE_LEN = 12 as const;
export const DEK_LEN = 32 as const;
export const AES_GCM_NONCE_LEN = 12 as const;
export const AES_GCM_TAG_LEN = 16 as const;
