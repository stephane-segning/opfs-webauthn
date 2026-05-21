/**
 * Wraps a `@sqlite.org/sqlite-wasm` database. Owns the
 * lifecycle (open → migrate → close); the rest of the worker only
 * sees the strict `exec` / `query` surface defined here.
 *
 * Single-responsibility: this file is the only place that talks to
 * sqlite-wasm directly. Worker handlers and repositories depend on
 * the `Database` interface, not the concrete sqlite type.
 *
 * Two openers are exported:
 *  - `openOpfsDatabase(filename)` — production. Installs the
 *    OPFS-SAH pool VFS (requires a DedicatedWorker host on browsers
 *    that gate `createSyncAccessHandle` to dedicated workers).
 *  - `openInMemoryDatabase()` — test/host. `:memory:` VFS; works
 *    under Node/vitest where the OPFS-SAH path isn't available.
 *
 * Both run `applyMigrations(db)` before returning so callers get a
 * DB already at the binary's current schema version.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { applyMigrations } from "./migrations.js";
import { ensureWasm } from "./wasm.js";

type SqliteApi = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SAHPoolUtil = Awaited<ReturnType<SqliteApi["installOpfsSAHPoolVfs"]>>;
type OpfsDb = InstanceType<SAHPoolUtil["OpfsSAHPoolDb"]>;
type MemoryDb = InstanceType<SqliteApi["oo1"]["DB"]>;

/**
 * Values we bind into SQL placeholders. sqlite-wasm accepts more,
 * but the storage layer only ever needs these — keeping the type
 * narrow makes invalid binds (e.g. `Date`, `boolean`) a compile
 * error rather than a runtime surprise.
 */
type BindValue = number | string | Uint8Array | null;

/** Anything sqlite-wasm hands back for a column. */
type SqlValue = number | bigint | string | Uint8Array | null;

/**
 * Minimum surface the storage layer needs from a SQLite handle.
 * Anything that satisfies this interface — including the in-memory
 * adapter used by tests — slots into `NoteRepositorySql` and the
 * migration runner without changes.
 */
export interface Database {
	exec(sql: string, bind?: readonly BindValue[]): void;
	query(sql: string, bind?: readonly BindValue[]): SqlValue[][];
	close(): void;
}

/**
 * Shape both `OpfsSAHPoolDb` and the generic `oo1.DB` satisfy. We
 * deliberately don't type the option object — sqlite-wasm has a
 * complex overload set we'd be re-implementing — and instead trust
 * the wrapper to pass only the modes it actually uses.
 */
type Sqlite3Handle = {
	exec(opts: {
		sql: string;
		bind?: readonly BindValue[];
		rowMode?: "array";
		resultRows?: unknown;
	}): unknown;
	close(): void;
};

class SqliteDatabase implements Database {
	readonly #handle: Sqlite3Handle;
	constructor(handle: Sqlite3Handle) {
		this.#handle = handle;
	}
	exec(sql: string, bind: readonly BindValue[] = []): void {
		this.#handle.exec({ sql, bind });
	}
	query(sql: string, bind: readonly BindValue[] = []): SqlValue[][] {
		const rows: SqlValue[][] = [];
		this.#handle.exec({
			sql,
			bind,
			rowMode: "array",
			resultRows: rows,
		});
		return rows;
	}
	close(): void {
		this.#handle.close();
	}
}

/**
 * Open the notes database on OPFS, install the OPFS SAH-pool VFS
 * once per worker, and run pending migrations. Must be called from
 * a DedicatedWorker on browsers (notably Firefox) that gate
 * `createSyncAccessHandle` to dedicated workers.
 */
export async function openOpfsDatabase(filename: string): Promise<Database> {
	await ensureWasm();
	const sqlite3 = await sqlite3InitModule();
	const pool = await sqlite3.installOpfsSAHPoolVfs({});
	const handle: OpfsDb = new pool.OpfsSAHPoolDb(`/${filename}`);
	const db = new SqliteDatabase(handle as unknown as Sqlite3Handle);
	applyMigrations(db);
	return db;
}

/**
 * Open an in-memory SQLite handle and run migrations. Used by
 * vitest/host tests so they can exercise the real SQL path without
 * the OPFS-SAH constraints. `close()` discards the contents.
 */
export async function openInMemoryDatabase(): Promise<Database> {
	await ensureWasm();
	const sqlite3 = await sqlite3InitModule();
	const handle: MemoryDb = new sqlite3.oo1.DB(":memory:", "c");
	const db = new SqliteDatabase(handle as unknown as Sqlite3Handle);
	applyMigrations(db);
	return db;
}
