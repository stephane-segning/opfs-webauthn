/**
 * High-level share orchestration. Composes the WASM crypto bindings
 * with the HTTP transport so the UI deals in three verbs:
 *
 *   - `prepareReceive` — recipient mints a rendezvous, gets the code
 *     to show the sender.
 *   - `pollAndDecrypt` — recipient waits for the sender's upload and
 *     returns the plaintext.
 *   - `sendShare` — sender enters a code, verifies the commitment
 *     locally, and uploads the encrypted blob.
 *
 * Splitting orchestration from transport means tests can drive these
 * with an in-memory backend (see `share.test.ts`).
 */

import { RecipientHandle, sealShare, verifyCode } from "@opfs/core-wasm";

import { decodeShareBlob, encodeShareBlob } from "./blob.js";
import { ShareError } from "./errors.js";
import type { RendezvousClient } from "./transport.js";

/** Pickup-code length in Crockford-base32 characters (mirrors WASM). */
const CODE_LEN = 12;

export type RecipientSession = {
	/** Human-readable pickup code; share with the sender out of band. */
	readonly code: string;
	/** Unix seconds at which the rendezvous expires. */
	readonly expiresAt: number;
	/** Opaque handle that holds the X25519 secret inside wasm memory. */
	readonly handle: RecipientHandle;
};

export type PollOptions = {
	/** Milliseconds between blob-availability polls. */
	readonly intervalMs?: number;
	/** Hard cap on total wait time. Defaults to the 5-minute TTL. */
	readonly timeoutMs?: number;
	/** Abort signal — flips polling to a typed `network` error. */
	readonly signal?: AbortSignal;
};

const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_POLL_TIMEOUT_MS = 300_000;

/**
 * Recipient: mint a rendezvous. The returned `handle` must be kept
 * alive until `pollAndDecrypt` (or its WASM resources freed via
 * `handle.free()` if the user cancels).
 */
export async function prepareReceive(
	client: RendezvousClient,
): Promise<RecipientSession> {
	const handle = RecipientHandle.prepare();
	try {
		const { code, expiresAt } = await client.mint(handle.pubkey);
		return { code, expiresAt, handle };
	} catch (err) {
		// Don't leak the wasm allocation if the network call fails.
		handle.free();
		throw err;
	}
}

/**
 * Recipient: poll the backend until the sender's blob arrives, then
 * decrypt it with the session handle. The handle is freed on the
 * way out — success or failure — so callers don't have to.
 */
export async function pollAndDecrypt(
	client: RendezvousClient,
	session: RecipientSession,
	options: PollOptions = {},
): Promise<Uint8Array> {
	const intervalMs = options.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
	const timeoutMs = options.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
	const deadline = Date.now() + timeoutMs;
	try {
		while (true) {
			throwIfAborted(options.signal);
			const blob = await client.tryDownloadBlob(session.code);
			if (blob !== null) return openSealedBlob(session.handle, blob);
			if (Date.now() >= deadline) {
				throw new ShareError(
					"rendezvousExpired",
					"timed out waiting for the sender",
				);
			}
			await sleep(intervalMs, options.signal);
		}
	} finally {
		session.handle.free();
	}
}

/**
 * Sender: enter the code from the recipient, verify the commitment
 * locally, encrypt the payload, and upload. Throws
 * `commitmentMismatch` if the backend hands us a pubkey that doesn't
 * match the code the user typed — that's the load-bearing check
 * against a hostile relay (ADR 0007).
 */
export async function sendShare(
	client: RendezvousClient,
	code: string,
	plaintext: Uint8Array,
): Promise<void> {
	if (code.length !== CODE_LEN) {
		throw new ShareError("protocol", `code must be ${CODE_LEN} characters`);
	}
	const recipientPubkey = await client.fetchEpk(code);
	if (!verifyCode(code, recipientPubkey)) {
		throw new ShareError(
			"commitmentMismatch",
			"rendezvous pubkey does not match the code",
		);
	}
	const sealed = sealShare(recipientPubkey, plaintext);
	const blob = encodeShareBlob({
		senderPubkey: sealed.senderPubkey,
		nonce: sealed.nonce,
		ciphertext: sealed.ciphertext,
	});
	// Free wasm-side allocations before the await so we don't sit on
	// them while the network call is in flight.
	sealed.free();
	await client.uploadBlob(code, blob);
}

function openSealedBlob(handle: RecipientHandle, blob: Uint8Array): Uint8Array {
	const parts = decodeShareBlob(blob);
	try {
		return handle.openShare(parts.senderPubkey, parts.nonce, parts.ciphertext);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new ShareError("protocol", `share decryption failed: ${message}`);
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new ShareError("network", "share polling aborted by caller");
	}
}

/**
 * Sleep that resolves early on `signal` abort. Promise-based so the
 * polling loop reads top-to-bottom without nested callbacks.
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new ShareError("network", "share polling aborted by caller"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
