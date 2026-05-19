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
