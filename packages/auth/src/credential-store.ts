import { base64UrlToBytes, bytesToBase64Url } from "./codec.js";
import type { VaultCredential } from "./types.js";

/**
 * `localStorage` key under which the vault credential is persisted.
 * `localStorage` is the right home for *credential metadata*
 * specifically — it's small, multi-tab visible, and survives reloads.
 * The encrypted notes themselves live in OPFS; see ADR 0004.
 */
const STORAGE_KEY = "opfs-webauthn/v1/credential";

type Serialized = {
	readonly credentialId: string;
	readonly prfSalt: string;
	readonly wrappedDek: string;
	readonly wrapNonce: string;
	readonly rpId: string;
	readonly createdAt: number;
};

function serialize(c: VaultCredential): Serialized {
	return {
		credentialId: bytesToBase64Url(c.credentialId),
		prfSalt: bytesToBase64Url(c.prfSalt),
		wrappedDek: bytesToBase64Url(c.wrappedDek),
		wrapNonce: bytesToBase64Url(c.wrapNonce),
		rpId: c.rpId,
		createdAt: c.createdAt,
	};
}

function deserialize(raw: string): VaultCredential | null {
	let obj: Partial<Serialized>;
	try {
		obj = JSON.parse(raw) as Partial<Serialized>;
	} catch {
		return null;
	}
	if (
		typeof obj.credentialId !== "string" ||
		typeof obj.prfSalt !== "string" ||
		typeof obj.wrappedDek !== "string" ||
		typeof obj.wrapNonce !== "string" ||
		typeof obj.rpId !== "string" ||
		typeof obj.createdAt !== "number"
	) {
		return null;
	}
	try {
		return {
			credentialId: base64UrlToBytes(obj.credentialId),
			prfSalt: base64UrlToBytes(obj.prfSalt),
			wrappedDek: base64UrlToBytes(obj.wrappedDek),
			wrapNonce: base64UrlToBytes(obj.wrapNonce),
			rpId: obj.rpId,
			createdAt: obj.createdAt,
		};
	} catch {
		return null;
	}
}

/**
 * Tiny `localStorage`-backed adapter. Pluggable — callers in tests
 * or alternate hosts can supply their own implementation of this
 * interface and pass it to `enroll` / `unlock` (next iteration); the
 * default singleton talks to `window.localStorage`.
 */
export type CredentialStore = {
	readonly get: () => VaultCredential | null;
	readonly set: (credential: VaultCredential) => void;
	readonly clear: () => void;
};

export const credentialStore: CredentialStore = {
	get(): VaultCredential | null {
		if (typeof localStorage === "undefined") return null;
		const raw = localStorage.getItem(STORAGE_KEY);
		return raw ? deserialize(raw) : null;
	},
	set(credential): void {
		if (typeof localStorage === "undefined") return;
		localStorage.setItem(STORAGE_KEY, JSON.stringify(serialize(credential)));
	},
	clear(): void {
		if (typeof localStorage === "undefined") return;
		localStorage.removeItem(STORAGE_KEY);
	},
};
