/**
 * Typed request/response RPC between the page and the dedicated DB
 * worker. The page constructs a `WorkerClient` once per session; each
 * request carries a numeric `id` so concurrent calls don't race.
 *
 * Per ADR 0006 the worker is the sole writer. Reads also go through
 * it to keep a single coherent view. Fan-out notifications
 * (`tx-applied`) do **not** ride this channel — they go over a
 * `BroadcastChannel` (see `multi-tab.ts`). That keeps the RPC
 * envelope strictly request/response so per-tab `MessagePort`s never
 * have to filter notifications they don't need.
 */

import type { EncryptedNoteRow, NoteRowInput } from "./row.js";

/** Wire messages from the page to the worker. */
export type WorkerRequest =
	| { readonly kind: "bootstrap" }
	| { readonly kind: "ping" }
	| {
			readonly kind: "listNotes";
			readonly limit: number;
			readonly cursor: string | null;
			readonly includeArchived: boolean;
	  }
	| { readonly kind: "upsertNote"; readonly row: NoteRowInput }
	| { readonly kind: "getNote"; readonly id: string }
	| { readonly kind: "archiveNote"; readonly id: string }
	| { readonly kind: "close" };

/** Wire messages from the worker to the page (responses only). */
export type WorkerResponse =
	| { readonly kind: "bootstrap"; readonly schemaVersion: number }
	| { readonly kind: "ping"; readonly pong: true }
	| {
			readonly kind: "listNotes";
			readonly rows: readonly EncryptedNoteRow[];
			readonly nextCursor: string | null;
	  }
	| { readonly kind: "upsertNote"; readonly row: EncryptedNoteRow }
	| { readonly kind: "getNote"; readonly row: EncryptedNoteRow | null }
	| { readonly kind: "archiveNote" }
	| { readonly kind: "close" };

/**
 * Notifications the worker emits over the `BroadcastChannel`
 * declared in `multi-tab.ts`. They never appear on `ServerEnvelope`
 * — kept here so the producer (`worker-handlers.ts`) and the
 * consumer (`multi-tab.ts`) speak the same shape.
 */
export type WorkerNotification = {
	readonly kind: "tx-applied";
	readonly ids: readonly string[];
};

type ClientEnvelope<Req extends WorkerRequest = WorkerRequest> = {
	readonly id: number;
	readonly request: Req;
};

type ServerEnvelope =
	| {
			readonly kind: "response";
			readonly id: number;
			readonly response: WorkerResponse;
	  }
	| { readonly kind: "error"; readonly id: number; readonly message: string };

/** Build a success envelope for request `id`. */
export const respond = (
	id: number,
	response: WorkerResponse,
): ServerEnvelope => ({
	kind: "response",
	id,
	response,
});

/** Build a failure envelope. */
export const fail = (id: number, message: string): ServerEnvelope => ({
	kind: "error",
	id,
	message,
});

type Pending = {
	readonly resolve: (value: WorkerResponse) => void;
	readonly reject: (reason: Error) => void;
};

/**
 * Minimum surface the page side needs from a worker transport.
 * Satisfied by both a dedicated `Worker` and a `SharedWorker` (via
 * the adapters in `index.ts`), so `WorkerClient` doesn't care which
 * transport it owns. The `"error"` channel is required so a worker
 * load failure or crash rejects in-flight requests instead of
 * stranding `bootstrap()` forever.
 */
export interface WorkerLike {
	postMessage(data: unknown): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
	addEventListener(type: "error", listener: (event: Event) => void): void;
	removeEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
	removeEventListener(type: "error", listener: (event: Event) => void): void;
	close(): void;
}

/**
 * Page-side handle for the storage worker. Construct once after the
 * user unlocks the vault; tear down via `close()` on lock.
 */
export class WorkerClient {
	readonly #worker: WorkerLike;
	#pending = new Map<number, Pending>();
	#nextId = 1;

	constructor(worker: WorkerLike) {
		this.#worker = worker;
		this.#worker.addEventListener("message", this.#onMessage);
		this.#worker.addEventListener("error", this.#onError);
	}

	#onError = (_event: Event): void => {
		this.#rejectAll(new Error("storage worker error"));
	};

	#rejectAll(reason: Error): void {
		for (const pending of this.#pending.values()) pending.reject(reason);
		this.#pending.clear();
	}

	#onMessage = (event: MessageEvent<ServerEnvelope>): void => {
		const data = event.data;
		if (data.kind === "response") {
			const pending = this.#pending.get(data.id);
			if (pending) {
				this.#pending.delete(data.id);
				pending.resolve(data.response);
			}
			return;
		}
		if (data.kind === "error") {
			const pending = this.#pending.get(data.id);
			if (pending) {
				this.#pending.delete(data.id);
				pending.reject(new Error(data.message));
			}
		}
	};

	/**
	 * Send a request and resolve to the matching-kind response. Throws
	 * if the worker replies with a different kind (which would be a
	 * protocol bug). This is the only place the response-kind guard
	 * lives; callers get a fully-narrowed result.
	 */
	async send<R extends WorkerRequest>(
		request: R,
	): Promise<Extract<WorkerResponse, { kind: R["kind"] }>> {
		const id = this.#nextId++;
		const envelope: ClientEnvelope<R> = { id, request };
		const response = await new Promise<WorkerResponse>((resolve, reject) => {
			this.#pending.set(id, { resolve, reject });
			this.#worker.postMessage(envelope);
		});
		if (response.kind !== request.kind) {
			throw new Error(
				`storage worker replied with ${response.kind}, expected ${request.kind}`,
			);
		}
		return response as Extract<WorkerResponse, { kind: R["kind"] }>;
	}

	terminate(): void {
		// Best-effort: tell the worker we're going so it drops our
		// connection from its registry. We don't await the reply — the
		// transport teardown below would discard it anyway. For a
		// dedicated worker this is redundant (terminate kills it), but
		// for a SharedWorker port it's the only signal the worker gets
		// that this tab is leaving.
		try {
			const id = this.#nextId++;
			this.#worker.postMessage({ id, request: { kind: "close" } });
		} catch {
			// transport may already be dead — nothing to do
		}
		this.#worker.removeEventListener("message", this.#onMessage);
		this.#worker.removeEventListener("error", this.#onError);
		this.#worker.close();
		this.#rejectAll(new Error("storage worker terminated"));
	}
}

export type { ClientEnvelope, ServerEnvelope };
