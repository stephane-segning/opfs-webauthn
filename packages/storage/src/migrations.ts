/**
 * Forward-only schema migration runner.
 *
 * The migration list lives in Rust (`crates/repo/src/migrations.rs`)
 * and is reached through wasm-bindgen via `@opfs/core-wasm`'s
 * `pendingMigrations(currentVersion)`. This module is the thin JS
 * driver that:
 *
 *  1. Reads the installed version from `schema_meta` (treating an
 *     absent table as version 0).
 *  2. Asks Rust which migrations to run, in order.
 *  3. Wraps each migration's `upSql` in a transaction, executes it,
 *     and stamps `schema_meta.version = toVersion` before moving on.
 *
 * The split (Rust owns the list, JS owns the runner) keeps the
 * schema source-of-truth in one place; the JS side only carries the
 * driver-specific bits (transaction boundaries, the `schema_meta`
 * lookup query).
 *
 * Callers must `await ensureWasm()` before invoking — the wasm
 * bindings are reached synchronously by this module.
 */

import type { Database } from "./database.js";
import { getWasm } from "./wasm.js";

/**
 * Read the current schema version from `schema_meta`. Returns `0`
 * when the table doesn't exist yet (cold-start case) or has no
 * `version` row.
 *
 * The "table missing" probe uses `sqlite_master` rather than a
 * try/catch around `SELECT FROM schema_meta` because the latter
 * leaves a misleading error trail in any sqlite logger the host
 * has plumbed in.
 */
function readInstalledVersion(db: Database): number {
	const exists = db.query(
		"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'",
	);
	if (exists.length === 0) return 0;
	const rows = db.query("SELECT value FROM schema_meta WHERE key = 'version'");
	const first = rows[0];
	if (!first) return 0;
	const value = first[0];
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		return Number.isFinite(parsed) ? parsed : 0;
	}
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "bigint") return Number(value);
	return 0;
}

const STAMP_SQL = `
INSERT INTO schema_meta(key, value) VALUES('version', ?)
ON CONFLICT(key) DO UPDATE SET value = excluded.value`;

/**
 * Bring `db` up to the binary's current schema version. Each pending
 * migration runs inside its own `BEGIN ... COMMIT` so a half-applied
 * step won't leave the DB in a torn state. On any failure the
 * transaction is rolled back and the exception propagates so the
 * caller can surface it.
 */
export function applyMigrations(db: Database): void {
	const installed = readInstalledVersion(db);
	const pending = getWasm().pendingMigrations(installed);
	for (const migration of pending) {
		db.exec("BEGIN");
		try {
			db.exec(migration.upSql);
			db.exec(STAMP_SQL, [String(migration.toVersion)]);
			db.exec("COMMIT");
		} catch (err) {
			// Best-effort rollback. If `COMMIT` itself threw the txn is
			// already closed; the `ROLLBACK` will fail harmlessly.
			try {
				db.exec("ROLLBACK");
			} catch {
				/* swallow */
			}
			throw err;
		} finally {
			migration.free();
		}
	}
}
