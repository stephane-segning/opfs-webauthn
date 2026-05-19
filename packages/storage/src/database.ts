/**
 * Wraps a `@sqlite.org/sqlite-wasm` OPFS-SAHPool database. Owns the
 * lifecycle (open → migrate → close); the rest of the worker only
 * sees the strict `exec` / `query` surface defined here.
 *
 * Single-responsibility: this file is the only place that talks to
 * sqlite-wasm directly. Worker handlers and repositories depend on
 * the `Database` interface, not the concrete sqlite type.
 */

import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

type SqliteApi = Awaited<ReturnType<typeof sqlite3InitModule>>;
type SAHPoolUtil = Awaited<ReturnType<SqliteApi["installOpfsSAHPoolVfs"]>>;
type OpfsDb = InstanceType<SAHPoolUtil["OpfsSAHPoolDb"]>;

type BindValue = number | string | Uint8Array | null;

export interface Database {
	exec(sql: string, bind?: readonly BindValue[]): void;
	query(sql: string, bind?: readonly BindValue[]): unknown[][];
	close(): void;
}

class OpfsDatabase implements Database {
	readonly #handle: OpfsDb;
	constructor(handle: OpfsDb) {
		this.#handle = handle;
	}
	exec(sql: string, bind: readonly BindValue[] = []): void {
		this.#handle.exec({ sql, bind: bind as BindValue[] });
	}
	query(sql: string, bind: readonly BindValue[] = []): unknown[][] {
		const rows: unknown[][] = [];
		this.#handle.exec({
			sql,
			bind: bind as BindValue[],
			rowMode: "array",
			resultRows: rows as unknown as never,
		});
		return rows;
	}
	close(): void {
		this.#handle.close();
	}
}

/**
 * Open the notes database, install the OPFS SAH-pool VFS once per
 * worker, run the canonical schema, and stamp the version in
 * `schema_meta`. Subsequent calls return the same handle.
 */
export async function openNotesDatabase(filename: string): Promise<Database> {
	const sqlite3 = await sqlite3InitModule();
	const pool = await sqlite3.installOpfsSAHPoolVfs({});
	const handle = new pool.OpfsSAHPoolDb(`/${filename}`);
	const db = new OpfsDatabase(handle);
	db.exec(SCHEMA_SQL);
	db.exec(
		"INSERT INTO schema_meta(key, value) VALUES('version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
		[String(SCHEMA_VERSION)],
	);
	return db;
}
