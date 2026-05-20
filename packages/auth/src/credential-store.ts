import { base64UrlToBytes, bytesToBase64Url } from "./codec.js";
import type { VaultCredential } from "./types.js";

/**
 * Filename inside the origin's OPFS root where the vault credential
 * metadata lives.
 *
 * Originally this was a `localStorage` key. Two problems with that
 * home:
 *   1. It surfaces alarmingly in DevTools → Application → Local
 *      Storage even though the `wrappedDek` is useless without a
 *      passkey ceremony to derive the KEK.
 *   2. `localStorage.clear()` and "clear cookies for this site"
 *      silently nuke the wrap, locking the user out even though
 *      the passkey still exists.
 *
 * OPFS is the same scope the encrypted notes already live in (one
 * origin = one vault), and it's much harder to clear by accident —
 * only "delete all site data" reaches it, and that's an intentional
 * destructive action.
 */
const VAULT_FILE = "opfs-webauthn-vault.json";

/**
 * Legacy localStorage key. Read once on first migration, then
 * cleared. Kept here so anyone who enrolled before the OPFS move
 * isn't logged out.
 */
const LEGACY_LOCAL_STORAGE_KEY = "opfs-webauthn/v1/credential";

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
 * Read the legacy localStorage entry if it exists. Used once at
 * mount so users who enrolled before the OPFS move aren't locked
 * out — we migrate their credential into OPFS and clear the legacy
 * value in the same call.
 */
function readLegacy(): VaultCredential | null {
	if (typeof localStorage === "undefined") return null;
	const raw = localStorage.getItem(LEGACY_LOCAL_STORAGE_KEY);
	return raw ? deserialize(raw) : null;
}

function clearLegacy(): void {
	if (typeof localStorage === "undefined") return;
	localStorage.removeItem(LEGACY_LOCAL_STORAGE_KEY);
}

/**
 * Pluggable adapter for the vault credential. The default singleton
 * persists to OPFS (origin-scoped, hidden from the localStorage tab,
 * survives soft cookie-clears) and migrates from the legacy
 * localStorage key on first read so existing enrollments aren't
 * orphaned.
 */
export type CredentialStore = {
	readonly get: () => Promise<VaultCredential | null>;
	readonly set: (credential: VaultCredential) => Promise<void>;
	readonly clear: () => Promise<void>;
};

export const credentialStore: CredentialStore = {
	async get(): Promise<VaultCredential | null> {
		const fromOpfs = await readVaultFile();
		if (fromOpfs) return fromOpfs;
		// One-shot migration from the legacy home. If the user has
		// both (shouldn't happen in normal use, but treat OPFS as
		// canonical), OPFS won above; only get here if OPFS is empty.
		const legacy = readLegacy();
		if (legacy) {
			try {
				await writeVaultFile(legacy);
				clearLegacy();
				return legacy;
			} catch {
				// If migration failed (OPFS unavailable, quota, …) return
				// the legacy value anyway so the user can still unlock.
				// `set()` on a successful enroll will retry the move.
				return legacy;
			}
		}
		return null;
	},
	async set(credential): Promise<void> {
		await writeVaultFile(credential);
		// Belt-and-suspenders: if the legacy entry is still hanging
		// around (e.g. migration didn't fire because the OPFS file
		// already existed), clear it on every successful write so
		// the localStorage tab stops showing it.
		clearLegacy();
	},
	async clear(): Promise<void> {
		await deleteVaultFile();
		clearLegacy();
	},
};
