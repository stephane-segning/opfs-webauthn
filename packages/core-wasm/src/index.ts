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
 * const dek = crypto.getRandomValues(new Uint8Array(32));
 * const wrapNonce = crypto.getRandomValues(new Uint8Array(12));
 * const enroll = CryptoVault.enroll(dek, wrapNonce, prfOutput, prfSalt);
 * // persist enroll.wrappedDek + enroll.wrapNonce in OPFS, keep the vault
 * const vault = enroll.takeVault();
 * ```
 */

export type {
	InitInput,
	InitOutput,
	SyncInitInput,
} from "../dist/opfs_core.js";
// biome-ignore lint/performance/noBarrelFile: this is the package's public surface
export {
	aesGcmNonceLen,
	aesGcmTagLen,
	CryptoVault,
	codeForPubkey,
	commitmentCodeLen,
	default,
	default as init,
	dekLen,
	EnrollResult,
	initSync,
	protocolVersion,
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
