/**
 * HTTP transport for the rendezvous backend. Pure I/O — no crypto
 * here. Tests inject a `fetch` stub via `RendezvousClientOptions`,
 * production uses the global `fetch`.
 */

import { ShareError, shareErrorForStatus } from "./errors.js";

export type FetchLike = typeof globalThis.fetch;

export type RendezvousClientOptions = {
	readonly baseUrl: string;
	/** Optional `fetch` override; default uses the global. */
	readonly fetch?: FetchLike;
};

export type RendezvousMint = {
	readonly code: string;
	readonly expiresAt: number;
};

const APP_OCTET_STREAM = "application/octet-stream";
const APP_JSON = "application/json";

/**
 * `fetch`'s DOM-lib `BodyInit` doesn't accept the generic
 * `Uint8Array<ArrayBufferLike>` shape TS 5.7+ infers for arrays that
 * round-tripped through `arrayBuffer()`, even though the runtime
 * accepts them everywhere. We narrow back to `BodyInit` at the
 * single call site rather than littering casts through the handlers.
 */
const asBody = (bytes: Uint8Array): BodyInit => bytes as unknown as BodyInit;

async function networkSafe<T>(
	op: () => Promise<T>,
	message: string,
): Promise<T> {
	try {
		return await op();
	} catch (err) {
		if (err instanceof ShareError) throw err;
		const cause = err instanceof Error ? `: ${err.message}` : "";
		throw new ShareError("network", `${message}${cause}`);
	}
}

/**
 * Page-side HTTP client for the share backend. One instance per
 * configured `baseUrl`; methods are stateless so the same client
 * can serve both recipient and sender roles concurrently.
 */
export class RendezvousClient {
	readonly #baseUrl: string;
	readonly #fetch: FetchLike;

	constructor(options: RendezvousClientOptions) {
		// Strip trailing slash so callers don't have to coordinate.
		this.#baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	}

	/**
	 * `POST /rendezvous` — recipient mints a rendezvous. The optional
	 * `signal` lets the caller abort the in-flight fetch (and free
	 * the wasm `RecipientHandle` early) if the dialog is closed
	 * before the backend responds.
	 */
	async mint(
		epk: Uint8Array,
		options: { readonly signal?: AbortSignal } = {},
	): Promise<RendezvousMint> {
		const response = await networkSafe(
			() =>
				this.#fetch(`${this.#baseUrl}/rendezvous`, {
					method: "POST",
					headers: { "content-type": APP_OCTET_STREAM },
					body: asBody(epk),
					signal: options.signal,
				}),
			"mint request failed",
		);
		if (!response.ok) throw shareErrorForStatus(response.status, "mint");
		// A malformed JSON body would otherwise surface as a raw
		// `SyntaxError`; wrap it as a typed `protocol` error so
		// callers branch on `kind` like every other failure path.
		let json: { code?: unknown; expiresAt?: unknown };
		try {
			json = (await response.json()) as typeof json;
		} catch (err) {
			const cause = err instanceof Error ? `: ${err.message}` : "";
			throw new ShareError(
				"protocol",
				`mint response was not valid JSON${cause}`,
			);
		}
		if (typeof json.code !== "string" || typeof json.expiresAt !== "number") {
			throw new ShareError(
				"protocol",
				"mint response missing `code` or `expiresAt`",
			);
		}
		return { code: json.code, expiresAt: json.expiresAt };
	}

	/** `GET /rendezvous/:code` — sender fetches the recipient's epk. */
	async fetchEpk(code: string): Promise<Uint8Array> {
		const response = await networkSafe(
			() =>
				this.#fetch(`${this.#baseUrl}/rendezvous/${encodeURIComponent(code)}`),
			"fetchEpk request failed",
		);
		if (!response.ok)
			throw shareErrorForStatus(response.status, "fetchRendezvous");
		return new Uint8Array(await response.arrayBuffer());
	}

	/** `POST /rendezvous/:code/blob` — sender uploads the encrypted blob. */
	async uploadBlob(code: string, blob: Uint8Array): Promise<void> {
		const response = await networkSafe(
			() =>
				this.#fetch(
					`${this.#baseUrl}/rendezvous/${encodeURIComponent(code)}/blob`,
					{
						method: "POST",
						headers: { "content-type": APP_OCTET_STREAM },
						body: asBody(blob),
					},
				),
			"uploadBlob request failed",
		);
		if (!response.ok) throw shareErrorForStatus(response.status, "uploadBlob");
	}

	/**
	 * `GET /rendezvous/:code/blob` — recipient picks up the blob.
	 * Returns `null` if the blob is not (yet) available so the poller
	 * can distinguish "still waiting" from a fatal failure.
	 */
	async tryDownloadBlob(code: string): Promise<Uint8Array | null> {
		const response = await networkSafe(
			() =>
				this.#fetch(
					`${this.#baseUrl}/rendezvous/${encodeURIComponent(code)}/blob`,
				),
			"downloadBlob request failed",
		);
		if (response.ok) return new Uint8Array(await response.arrayBuffer());
		if (response.status === 404) return null;
		throw shareErrorForStatus(response.status, "downloadBlob");
	}

	// Surface for tests — exposed so callers can build their own URL
	// for diagnostic purposes without re-implementing the prefix logic.
	get baseUrl(): string {
		return this.#baseUrl;
	}
}

export { APP_JSON, APP_OCTET_STREAM };
