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
	removeEventListener(
		type: "message",
		listener: (event: MessageEvent) => void,
	): void;
	postMessage(data: unknown): void;
	start?(): void;
	close?(): void;
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

	/**
	 * Detach this connection from its port and from the live-set so
	 * `broadcastTxApplied` stops iterating it. Called when the client
	 * sends `close`; SharedWorker has no port-disconnect event, so this
	 * cooperative signal is the only deterministic cleanup path.
	 */
	dispose(): void {
		this.#port.removeEventListener("message", this.#onMessage);
		this.#port.close?.();
		connections.delete(this);
	}

	#onMessage = (event: MessageEvent<ClientEnvelope>): void => {
		const { id, request } = event.data;
		this.#dispatch(request)
			.then((response) => {
				this.post(respond(id, response));
				if (request.kind === "close") this.dispose();
			})
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
