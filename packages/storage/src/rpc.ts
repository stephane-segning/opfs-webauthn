/**
 * Typed request/response RPC between the page and the dedicated DB
 * worker. The page constructs a `WorkerClient` once per session; each
 * request carries a numeric `id` so concurrent calls don't race.
 *
 * Per ADR 0006 the worker is the sole writer. Reads also go through it
 * to keep a single coherent view.
 */

import type {
	EncryptedNoteRow,
	NoteRowInput,
	StorageEventName,
} from "./row.js";

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
	| { readonly kind: "archiveNote" }
	| { readonly kind: "close" };

/** Worker-emitted notifications. Broadcast, not request-scoped. */
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
	| { readonly kind: "error"; readonly id: number; readonly message: string }
	| {
			readonly kind: "notification";
			readonly notification: WorkerNotification;
	  };

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

/** Build a broadcast notification envelope (no `id`). */
export const notify = (notification: WorkerNotification): ServerEnvelope => ({
	kind: "notification",
	notification,
});

type Pending = {
	readonly resolve: (value: WorkerResponse) => void;
	readonly reject: (reason: Error) => void;
};

/**
 * Minimum surface the page side needs from a worker transport.
 * Satisfied by both a dedicated `Worker` and a `SharedWorker.port`
 * (via the adapters in `index.ts`), so `WorkerClient` doesn't care
 * which transport it owns.
 */
export type WorkerLike = {
	postMessage(data: unknown): void;
	addEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
	removeEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
	close(): void;
};

/**
 * Page-side handle for the storage worker. Construct once after the
 * user unlocks the vault; tear down via `close()` on lock.
 */
export class WorkerClient {
	readonly #worker: WorkerLike;
	#pending = new Map<number, Pending>();
	#nextId = 1;
	#listeners = new Map<StorageEventName, Set<(payload: unknown) => void>>();

	constructor(worker: WorkerLike) {
		this.#worker = worker;
		this.#worker.addEventListener("message", this.#onMessage);
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
			return;
		}
		if (data.kind === "notification") {
			const listeners = this.#listeners.get(data.notification.kind);
			if (listeners) {
				for (const fn of listeners) fn(data.notification);
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

	on<K extends StorageEventName>(
		kind: K,
		listener: (event: WorkerNotification & { readonly kind: K }) => void,
	): () => void {
		let set = this.#listeners.get(kind);
		if (!set) {
			set = new Set();
			this.#listeners.set(kind, set);
		}
		set.add(listener as (payload: unknown) => void);
		return () => {
			set?.delete(listener as (payload: unknown) => void);
		};
	}

	terminate(): void {
		this.#worker.removeEventListener("message", this.#onMessage);
		this.#worker.close();
		const err = new Error("storage worker terminated");
		for (const pending of this.#pending.values()) pending.reject(err);
		this.#pending.clear();
	}
}

export type { ClientEnvelope, ServerEnvelope };
