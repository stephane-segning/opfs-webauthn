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

export type { InitInput, InitOutput, SyncInitInput } from "../dist/opfs_core.js";
