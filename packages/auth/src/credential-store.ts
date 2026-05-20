import { base64UrlToBytes, bytesToBase64Url } from "./codec.js";
import type { VaultCredential } from "./types.js";

/**
 * Filename inside the origin's OPFS root where the vault credential
 * metadata lives.
 *
 * Originally this was a `localStorage` key. Two problems with that
 * home:
 *   1. It surfaced alarmingly in DevTools → Application → Local
 *      Storage even though the `wrappedDek` is useless without a
 *      passkey ceremony to derive the KEK.
 *   2. `localStorage.clear()` and "clear cookies for this site"
 *      silently nuked the wrap, locking the user out even though
 *      the passkey still existed.
 *
 * OPFS is the same scope the encrypted notes already live in (one
 * origin = one vault), and it's much harder to clear by accident —
 * only "delete all site data" reaches it, and that's an intentional
 * destructive action.
 */
const VAULT_FILE = "opfs-webauthn-vault.json";

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
 * OPFS root accessor. `navigator.storage.getDirectory()` works in
 * main-thread context — only `createSyncAccessHandle` is restricted
 * to workers, and we don't need it here (the file is tiny and we
 * read/write it with the async stream APIs).
 */
async function opfsRoot(): Promise<FileSystemDirectoryHandle | null> {
	if (typeof navigator === "undefined" || !navigator.storage?.getDirectory) {
		return null;
	}
	try {
		return await navigator.storage.getDirectory();
	} catch {
		return null;
	}
}

async function readVaultFile(): Promise<VaultCredential | null> {
	const root = await opfsRoot();
	if (!root) return null;
	let fileHandle: FileSystemFileHandle;
	try {
		fileHandle = await root.getFileHandle(VAULT_FILE);
	} catch {
		// `NotFoundError` — no vault yet. Don't auto-create on read;
		// `set()` is the only writer.
		return null;
	}
	try {
		const file = await fileHandle.getFile();
		const text = await file.text();
		return deserialize(text);
	} catch {
		return null;
	}
}

async function writeVaultFile(credential: VaultCredential): Promise<void> {
	const root = await opfsRoot();
	if (!root) return;
	const fileHandle = await root.getFileHandle(VAULT_FILE, { create: true });
	const writable = await fileHandle.createWritable();
	try {
		await writable.write(JSON.stringify(serialize(credential)));
	} finally {
		await writable.close();
	}
}

async function deleteVaultFile(): Promise<void> {
	const root = await opfsRoot();
	if (!root) return;
	try {
		await root.removeEntry(VAULT_FILE);
	} catch {
		// `NotFoundError` is fine; idempotent clear.
	}
}

/**
 * Pluggable adapter for the vault credential. The default singleton
 * persists to OPFS (origin-scoped, hidden from the localStorage tab,
 * survives soft cookie-clears). No migration from the previous
 * localStorage-backed implementation — the project is pre-1.0 and
 * still in testing, so existing testers just re-enroll.
 */
export type CredentialStore = {
	readonly get: () => Promise<VaultCredential | null>;
	readonly set: (credential: VaultCredential) => Promise<void>;
	readonly clear: () => Promise<void>;
};

export const credentialStore: CredentialStore = {
	get: readVaultFile,
	set: writeVaultFile,
	clear: deleteVaultFile,
};
