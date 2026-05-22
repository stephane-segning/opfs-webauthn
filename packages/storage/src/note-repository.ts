/**
 * Encrypted-row repository on the worker side. The page-side `Repo`
 * is the plaintext-aware twin; this one is intentionally key-blind —
 * it never touches `CryptoVault` and only ever shuffles ciphertext +
 * indexable metadata in and out of SQLite.
 *
 * Single-responsibility: SQL parameter binding + row encoding /
 * decoding. The `Database` interface is the only thing it depends on,
 * so this file is host-testable behind a mock without sqlite-wasm.
 */

import type { Database } from "./database.js";
import { decodeRowId, encodeRowId } from "./id.js";
import type { EncryptedNoteRow, NoteRowInput } from "./row.js";

const NOTE_COLUMNS = [
	"id",
	"updated_day",
	"archived",
	"title_nonce",
	"title_ciphertext",
	"body_nonce",
	"body_ciphertext",
] as const;

const SELECT_NOTE_COLS = NOTE_COLUMNS.join(", ");

const UPSERT_SQL = `
INSERT INTO notes(${SELECT_NOTE_COLS})
VALUES(?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  updated_day = excluded.updated_day,
  archived = excluded.archived,
  title_nonce = excluded.title_nonce,
  title_ciphertext = excluded.title_ciphertext,
  body_nonce = excluded.body_nonce,
  body_ciphertext = excluded.body_ciphertext`;

const ARCHIVE_SQL = "UPDATE notes SET archived = 1 WHERE id = ?";

// Hard delete — the row is gone, no tombstone. Archive is the
// recoverable path; this one is irreversible by design (PRD §Notes:
// "Create, read, update, delete notes"). The dispatcher still
// fans out `tx-applied` with the id so connected tabs drop it from
// their cached list on the next reload.
const DELETE_SQL = "DELETE FROM notes WHERE id = ?";

const SELECT_BY_ID_SQL = `
SELECT ${SELECT_NOTE_COLS}
FROM notes
WHERE id = ?`;

export type ListPageInput = {
	readonly limit: number;
	readonly cursor: string | null;
	readonly includeArchived: boolean;
};

export type ListPageOutput = {
	readonly rows: readonly EncryptedNoteRow[];
	readonly nextCursor: string | null;
};

const LIST_LIMIT_MIN = 1;
const LIST_LIMIT_MAX = 200;

/**
 * Parse a `"day:id"` cursor into the WHERE-clause fragments + binds
 * that keep `(updated_day DESC, id DESC)` paging deterministic.
 */
function cursorWhere(cursor: string | null): {
	clause: string;
	binds: ReadonlyArray<number | Uint8Array>;
} {
	if (!cursor) return { clause: "", binds: [] };
	const [dayStr, lastId] = cursor.split(":");
	if (!dayStr || !lastId) {
		throw new Error(`malformed cursor: ${cursor}`);
	}
	const day = Number.parseInt(dayStr, 10);
	return {
		clause: "AND (updated_day < ? OR (updated_day = ? AND id < ?))",
		binds: [day, day, decodeRowId(lastId)],
	};
}

function decodeRow(values: ReadonlyArray<unknown>): EncryptedNoteRow {
	const [
		idBytes,
		updatedDay,
		archived,
		titleNonce,
		titleCiphertext,
		bodyNonce,
		bodyCiphertext,
	] = values;
	return {
		id: encodeRowId(idBytes as Uint8Array),
		updatedDay: updatedDay as number,
		archived: (archived as number) === 1,
		titleNonce: titleNonce as Uint8Array,
		titleCiphertext: titleCiphertext as Uint8Array,
		bodyNonce: bodyNonce as Uint8Array,
		bodyCiphertext: bodyCiphertext as Uint8Array,
	};
}

export class NoteRepositorySql {
	readonly #db: Database;
	constructor(db: Database) {
		this.#db = db;
	}

	list(input: ListPageInput): ListPageOutput {
		const limit = Math.max(
			LIST_LIMIT_MIN,
			Math.min(input.limit, LIST_LIMIT_MAX),
		);
		const archived = input.includeArchived ? "" : "AND archived = 0";
		const { clause: cursor, binds: cursorBinds } = cursorWhere(input.cursor);
		const sql = `
SELECT ${SELECT_NOTE_COLS}
FROM notes
WHERE 1 = 1 ${archived} ${cursor}
ORDER BY updated_day DESC, id DESC
LIMIT ?`;

		const raw = this.#db.query(sql, [...cursorBinds, limit + 1]);
		const rows = raw.slice(0, limit).map(decodeRow);
		const overflow = raw.length > limit;
		const last = rows[rows.length - 1];
		const nextCursor =
			overflow && last ? `${last.updatedDay}:${last.id}` : null;
		return { rows, nextCursor };
	}

	upsert(input: NoteRowInput): EncryptedNoteRow {
		this.#db.exec(UPSERT_SQL, [
			decodeRowId(input.id),
			input.updatedDay,
			input.archived ? 1 : 0,
			input.titleNonce,
			input.titleCiphertext,
			input.bodyNonce,
			input.bodyCiphertext,
		]);
		return input;
	}

	archive(id: string): void {
		this.#db.exec(ARCHIVE_SQL, [decodeRowId(id)]);
	}

	/**
	 * Hard-delete a note. Irreversible — the row is removed entirely
	 * rather than flipping the `archived` flag. A `DELETE` against a
	 * non-existent id is a silent no-op at the SQL layer; we don't
	 * surface "row missing" because the page-side flow can't tell the
	 * difference between "already deleted by another tab" and "never
	 * existed", and either outcome is the same from the user's POV.
	 */
	delete(id: string): void {
		this.#db.exec(DELETE_SQL, [decodeRowId(id)]);
	}

	/**
	 * Fetch a single encrypted row by id. Returns `null` when no row
	 * matches — the page layer surfaces that as "note doesn't exist"
	 * without an exception, which the UI's edit-then-archive flow can
	 * encounter when two tabs race on the same id.
	 */
	get(id: string): EncryptedNoteRow | null {
		const rows = this.#db.query(SELECT_BY_ID_SQL, [decodeRowId(id)]);
		const first = rows[0];
		return first ? decodeRow(first) : null;
	}
}
