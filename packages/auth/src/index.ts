/**
 * `@opfs/auth` — WebAuthn PRF enrollment + unlock orchestration.
 *
 * The browser-side bridge of the key hierarchy in [ADR 0005]:
 *
 *   passkey  ──PRF eval(prfSalt)──▶  prfOutput ──HKDF──▶ KEK
 *                                                          │
 *                       wrappedDek (persisted) ◀──AES-GCM──┤
 *                                                          ▼
 *                                                          DEK (in-wasm)
 *
 * The PRF output and the DEK never appear in JS-visible byte
 * buffers — `@opfs/core-wasm` generates the DEK and wraps it inside
 * the wasm module; this package just drives the browser ceremony.
 *
 * [ADR 0005]: ../../docs/adrs/0005-webauthn-prf-key-derivation.md
 */

export { enroll, unlock } from "./ceremony.js";
export type { CredentialStore } from "./credential-store.js";
export {
	CredentialStoreUnavailableError,
	credentialStore,
} from "./credential-store.js";
export type {
	AuthFeatureSupport,
	EnrollOptions,
	UnlockOptions,
	VaultCredential,
} from "./types.js";
export {
	AuthCeremonyError,
	AuthUnsupportedError,
} from "./types.js";

/**
 * Best-effort feature detect. The `prf` extension's presence is not
 * directly queryable; "unknown" means "we'll try and fall back to an
 * unsupported screen if the authenticator does not return PRF data."
 */
export function detectSupport(): import("./types.js").AuthFeatureSupport {
	const webauthn =
		typeof globalThis !== "undefined" &&
		typeof (globalThis as { PublicKeyCredential?: unknown })
			.PublicKeyCredential !== "undefined";
	return { webauthn, prfExtension: webauthn ? "unknown" : false };
}
