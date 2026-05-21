/**
 * Dedicated-worker entry. One `Connection` wraps `self`. Used as the
 * fallback transport when `SharedWorker` is unavailable (notably on
 * older iOS Safari) or when `createSyncAccessHandle` is gated to
 * dedicated workers (Firefox). Per ADR 0006 a multi-tab setup would
 * prefer the `db-shared-worker.ts` peer; in the dedicated fallback
 * case each tab gets its own writer, but they still all subscribe to
 * the same `opfs-storage-tx` `BroadcastChannel`, so every tab still
 * sees other tabs' writes.
 */

/// <reference lib="webworker" />

import { Connection, type PortLike } from "./connection.js";
import { openOpfsDatabase } from "./database.js";
import { makeTxBroadcaster } from "./multi-tab.js";
import { createDispatcher } from "./worker-handlers.js";

declare const self: DedicatedWorkerGlobalScope;

const DB_FILENAME = "opfs-webauthn-notes.sqlite";

// `makeTxBroadcaster` feature-detects `BroadcastChannel`; on
// environments without it (older iOS Safari WebView, the exact
// fallback the dedicated worker is here for) it returns a no-op so
// bootstrap still succeeds. Cross-tab fan-out is then unavailable —
// the app keeps working per-tab.
const tx = makeTxBroadcaster();

const dispatch = createDispatcher({
	openDatabase: () => openOpfsDatabase(DB_FILENAME),
	broadcast: tx.broadcast,
});

new Connection(self as unknown as PortLike, dispatch);
