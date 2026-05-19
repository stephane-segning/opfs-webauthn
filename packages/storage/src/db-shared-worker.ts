/**
 * SharedWorker entry. One `Connection` per connecting tab. The DB
 * + handlers live in one shared address space, satisfying ADR 0006's
 * "single writer across tabs" requirement. The browser tears the
 * worker down when the last tab closes.
 */

/// <reference lib="webworker" />

import { Connection, type PortLike } from "./connection.js";
import { dispatch } from "./worker-handlers.js";

declare const self: SharedWorkerGlobalScope;

self.addEventListener("connect", (event) => {
	const connectEvent = event as MessageEvent;
	const port = connectEvent.ports[0];
	if (!port) return;
	new Connection(port as PortLike, dispatch);
});
