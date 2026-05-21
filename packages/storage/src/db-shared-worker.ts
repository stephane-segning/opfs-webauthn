/**
 * SharedWorker entry. One `Connection` per connecting tab. The DB
 * + handlers live in one shared address space, satisfying ADR 0006's
 * "single writer across tabs" requirement. The browser tears the
 * worker down when the last tab closes.
 *
 * `tx-applied` rides a `BroadcastChannel` rather than fanning out
 * per-port: the BC carries the message to every tab's page-side
 * channel (including the originator), so the page never has to
 * route notifications back through the RPC layer.
 */

/// <reference lib="webworker" />

import { Connection, type PortLike } from "./connection.js";
import { openOpfsDatabase } from "./database.js";
import { makeTxBroadcaster } from "./multi-tab.js";
import { createDispatcher } from "./worker-handlers.js";

declare const self: SharedWorkerGlobalScope;

const DB_FILENAME = "opfs-webauthn-notes.sqlite";

// `makeTxBroadcaster` feature-detects `BroadcastChannel`; the
// SharedWorker still answers RPC if BC is missing — cross-tab
// `tx-applied` fan-out simply doesn't fire on those targets.
const tx = makeTxBroadcaster();

const dispatch = createDispatcher({
	openDatabase: () => openOpfsDatabase(DB_FILENAME),
	broadcast: tx.broadcast,
});

self.addEventListener("connect", (event) => {
	const connectEvent = event as MessageEvent;
	const port = connectEvent.ports[0];
	if (!port) return;
	new Connection(port as PortLike, dispatch);
});
