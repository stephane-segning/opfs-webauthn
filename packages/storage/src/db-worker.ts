/**
 * Dedicated-worker entry. One `Connection` wraps `self`. Used as the
 * fallback transport when `SharedWorker` is unavailable (notably on
 * older iOS Safari). Per ADR 0006 a multi-tab setup would prefer the
 * `db-shared-worker.ts` peer.
 */

/// <reference lib="webworker" />

import { Connection, type PortLike } from "./connection.js";
import { dispatch } from "./worker-handlers.js";

declare const self: DedicatedWorkerGlobalScope;

new Connection(self as unknown as PortLike, dispatch);
