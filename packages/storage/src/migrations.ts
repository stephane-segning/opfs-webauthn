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
 *
 * Throws (not coerces) on anything other than a non-negative
 * integer literal in the `value` column. `Number.parseInt` happily
 * eats trailing garbage (`"1corrupt"` → `1`), which would let a
 * scrambled metadata row sneak past the migration runner and trigger
 * the wrong migration path once non-idempotent migrations land. The
 * caller is expected to surface the error as "DB unreadable / refuse
 * to write" — codex flagged this on PR #43.
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
	if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
		return value;
	}
	if (typeof value === "bigint" && value >= 0n) return Number(value);
	if (typeof value === "string" && /^\d+$/.test(value)) {
		return Number(value);
	}
	const repr =
		typeof value === "string" ? JSON.stringify(value) : String(value);
	throw new Error(
		`opfs-storage: corrupt schema_meta.version (got ${repr}); refusing to migrate`,
	);
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
 *
 * Each `Migration` entry the wasm side hands back is a proxy onto
 * Rust-owned memory and must be `.free()`d. We do that in an outer
 * `finally` so a mid-loop migration failure still releases every
 * remaining entry in the list (gemini flagged the prior per-step
 * `finally` on PR #43 — it leaked the tail of the array on the
 * first throwing migration).
 */
export function applyMigrations(db: Database): void {
	const installed = readInstalledVersion(db);
	const pending = getWasm().pendingMigrations(installed);
	try {
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
			}
		}
	} finally {
		for (const migration of pending) migration.free();
	}
}
