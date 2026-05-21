/**
 * Persisted handle that lets a passkey-holding user re-open their
 * vault. Stored alongside the encrypted DB; never includes the DEK,
 * the KEK, or the raw PRF output. See ADR 0005.
 */
export type VaultCredential = {
	readonly credentialId: Uint8Array;
	readonly prfSalt: Uint8Array;
	readonly wrappedDek: Uint8Array;
	readonly wrapNonce: Uint8Array;
	/**
	 * The relying-party id that was bound into the credential at
	 * enrollment time. `unlock` passes this verbatim to
	 * `navigator.credentials.get`, so the browser finds the enrolled
	 * credential even when the page is served from a sibling subdomain
	 * (e.g. credential created for `example.com`, app served from
	 * `notes.example.com`).
	 */
	readonly rpId: string;
	readonly createdAt: number;
};

export type EnrollOptions = {
	/**
	 * Relying-party id — defaults to `location.hostname`. Override only
	 * if you are running the app under a different effective domain
	 * (e.g. behind a Pages custom domain).
	 */
	readonly rpId?: string;
	/** Display name shown by the authenticator UI. */
	readonly userName?: string;
	/**
	 * 16+ random bytes that identify this user *to the authenticator*.
	 * If omitted, a fresh 16-byte value is generated. Note: the actual
	 * vault has no concept of "users" — this just satisfies the
	 * WebAuthn ceremony.
	 */
	readonly userHandle?: Uint8Array;
	/**
	 * Which class of authenticator the browser may enroll. The library
	 * default is `undefined` — any authenticator is acceptable. Apps
	 * that need stricter posture override here.
	 *
	 * - `"platform"`: only authenticators built into the device
	 *   (Touch ID, Windows Hello, Android biometrics). Excludes
	 *   external security keys **and** password-manager
	 *   authenticators (1Password, Bitwarden, …). Choose this when
	 *   the vault holds data that must stay on this device — e.g.
	 *   for a local-first app where syncing the key material through
	 *   a third-party credential manager would defeat the data
	 *   locality goal.
	 * - `"cross-platform"`: only external authenticators (YubiKey,
	 *   roaming Bitwarden, etc.). Rarely useful as a hard pin.
	 * - `undefined`: any authenticator the browser surfaces. The
	 *   library default.
	 *
	 * **Verification, not a guarantee**: this field is a *hint* to
	 * the browser. Some browsers honour it strictly; others surface
	 * cross-platform options anyway. `enroll` additionally checks
	 * `credential.authenticatorAttachment` on the returned
	 * credential and throws `AuthUnsupportedError` if it doesn't
	 * match what you asked for, so the rejection is enforced
	 * client-side.
	 */
	readonly authenticatorAttachment?: AuthenticatorAttachment;
};

export type UnlockOptions = {
	readonly credential: VaultCredential;
};

export type AuthFeatureSupport = {
	readonly webauthn: boolean;
	readonly prfExtension: boolean | "unknown";
};

/**
 * Thrown when the active browser / authenticator does not support
 * everything the vault needs. The message names the missing piece.
 */
export class AuthUnsupportedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthUnsupportedError";
	}
}

/** Thrown when a WebAuthn ceremony fails or returns nothing usable. */
export class AuthCeremonyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AuthCeremonyError";
	}
}
