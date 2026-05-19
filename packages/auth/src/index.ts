/**
 * `@opfs/auth` — WebAuthn PRF orchestration.
 *
 * Owns the browser-side `navigator.credentials.create / get` ceremony
 * with the PRF extension and the HKDF→KEK→DEK chain that follows. The
 * raw key material never crosses back into JS — see ADR 0005.
 *
 * Stub for now; the ceremony lands in the PRF implementation PR.
 */

export type VaultCredential = {
	readonly credentialId: Uint8Array;
	readonly prfSalt: Uint8Array;
	readonly wrappedDek: Uint8Array;
	readonly wrappedDekNonce: Uint8Array;
};

export type AuthFeatureSupport = {
	readonly webauthn: boolean;
	readonly prfExtension: boolean | "unknown";
};

/**
 * Best-effort feature detect. The `prf` extension's presence is not
 * directly queryable; "unknown" means "we'll try and fall back to an
 * unsupported screen if the authenticator does not return PRF data."
 */
export function detectSupport(): AuthFeatureSupport {
	const webauthn =
		typeof globalThis !== "undefined" &&
		typeof (globalThis as { PublicKeyCredential?: unknown })
			.PublicKeyCredential !== "undefined";
	return { webauthn, prfExtension: webauthn ? "unknown" : false };
}
