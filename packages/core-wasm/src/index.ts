/**
 * `@opfs/core-wasm` — typed re-export over the wasm-bindgen output in
 * `./dist`. Run `pnpm --filter @opfs/core-wasm build` (or rely on
 * Turbo) to generate that dist before importing this package.
 *
 * Use:
 * ```ts
 * import init, { codeForPubkey, verifyCode } from "@opfs/core-wasm";
 * await init();
 * const code = codeForPubkey(epk);
 * ```
 */

export type {
	InitInput,
	InitOutput,
	SyncInitInput,
} from "../dist/opfs_core.js";

// Compile-time constants. Mirror the values the wasm functions return
// at runtime, so callers can use them in static positions (type bounds,
// default values, etc.) without first awaiting `init()`. Keep them in
// sync with the Rust constants by hand — they are short enough that
// drift is obvious in review.
export const PROTOCOL_VERSION = 1 as const;
export const X25519_PUBKEY_LEN = 32 as const;
export const AES_GCM_NONCE_LEN = 12 as const;
export const COMMITMENT_CODE_LEN = 12 as const;
// biome-ignore lint/performance/noBarrelFile: this is the package's public surface
export {
	codeForPubkey,
	commitmentCodeLen,
	default,
	default as init,
	initSync,
	protocolVersion,
	verifyCode,
	x25519PubkeyLen,
} from "../dist/opfs_core.js";
