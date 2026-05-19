/**
 * `@opfs/share-client` — page-side client for the recipient-first
 * share rendezvous (ADR 0007). Wraps the HTTP transport and the
 * WASM seal/open bindings into a small three-verb surface:
 *
 *   - {@link prepareReceive} — recipient mints a rendezvous.
 *   - {@link pollAndDecrypt} — recipient waits for the blob.
 *   - {@link sendShare} — sender encrypts and uploads under a code.
 *
 * The Worker is treated as untrusted: every transferred public key
 * is verified locally against the human-typed code before any
 * encryption happens.
 */

export {
	decodeShareBlob,
	encodeShareBlob,
	SHARE_BLOB_HEADER_LEN,
	type ShareBlobParts,
} from "./blob.js";
export { CODE_LEN, normalizeCode } from "./code.js";
export { ShareError, type ShareErrorKind } from "./errors.js";
export {
	type PollOptions,
	pollAndDecrypt,
	prepareReceive,
	type RecipientSession,
	sendShare,
} from "./share.js";
export {
	type FetchLike,
	RendezvousClient,
	type RendezvousClientOptions,
	type RendezvousMint,
} from "./transport.js";
