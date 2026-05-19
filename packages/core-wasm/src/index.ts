/**
 * `@opfs/core-wasm` — generated wasm-bindgen wrapper for the `opfs-core`
 * Rust crate. The actual wasm artifact lands in a follow-up PR via
 * `wasm-pack build crates/core --target web --out-dir packages/core-wasm/dist`.
 *
 * Until then this stub exports the public surface shape so dependent
 * JS packages can type-check their imports.
 */

export const PROTOCOL_VERSION = 1 as const;
export const X25519_PUBKEY_LEN = 32 as const;
export const AES_GCM_NONCE_LEN = 12 as const;
export const COMMITMENT_CODE_LEN = 12 as const;

/** Placeholder until wasm-pack runs. */
export type WasmModule = {
	readonly ready: Promise<void>;
};
