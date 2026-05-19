/**
 * Worker-side connection abstraction. One `Connection` wraps one
 * `MessagePort`-like endpoint (either the dedicated worker's `self`
 * or a single client port of a `SharedWorker`).
 *
 * Single-responsibility: own the message loop for one client. The
 * handlers know nothing about transports; the broadcast registry
 * iterates connections, not ports.
 */

import type {
	ClientEnvelope,
	ServerEnvelope,
	WorkerRequest,
	WorkerResponse,
} from "./rpc.js";
import { fail, respond } from "./rpc.js";

/** Minimum surface we need from a worker-side endpoint. */
export type PortLike = {
	addEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
	postMessage(data: unknown): void;
	start?(): void;
};

export type Dispatch = (request: WorkerRequest) => Promise<WorkerResponse>;

/** All live connections in this worker process. */
const connections = new Set<Connection>();

export class Connection {
	readonly #port: PortLike;
	readonly #dispatch: Dispatch;

	constructor(port: PortLike, dispatch: Dispatch) {
		this.#port = port;
		this.#dispatch = dispatch;
		port.addEventListener("message", this.#onMessage);
		port.start?.();
		connections.add(this);
	}

	post(envelope: ServerEnvelope): void {
		this.#port.postMessage(envelope);
	}

	#onMessage = (event: MessageEvent<ClientEnvelope>): void => {
		const { id, request } = event.data;
		this.#dispatch(request)
			.then((response) => this.post(respond(id, response)))
			.catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				this.post(fail(id, message));
			});
	};
}

/** Iterate all connections — used by the handlers to broadcast events. */
export function eachConnection(fn: (connection: Connection) => void): void {
	for (const c of connections) fn(c);
}
