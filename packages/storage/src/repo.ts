/**
 * Plaintext-facing repository. Orchestrates the page side of the
 * write path:
 *
 *   Note  ──RowCodec──▶  EncryptedNoteRow  ──WorkerClient──▶  worker
 *
 * and the read path in reverse. The worker never sees plaintext; the
 * codec is the only thing that holds the `CryptoVault`.
 *
 * `subscribeTxApplied` listens on the multi-tab
 * `BroadcastChannel` rather than the RPC port: every tab — including
 * the originating one — hears every successful write through the same
 * channel (ADR 0006). The Repo doesn't need to know which transport
 * (SharedWorker / DedicatedWorker) is underneath.
 */

import type { CryptoVault } from "@opfs/core-wasm";

import { generateRowId } from "./id.js";
import { subscribeTxApplied } from "./multi-tab.js";
import type { EncryptedNoteRow } from "./row.js";
import { RowCodec } from "./row-codec.js";
import type { WorkerClient } from "./rpc.js";

const SECONDS_PER_DAY = 86_400;
const TITLE_FIELD = "title";
const BODY_FIELD = "body";

const todayDayBucket = (): number =>
	Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);

/** Page-facing plaintext note. The vault never exposes ciphertext to the UI. */
export type Note = {
	readonly id: string;
	readonly title: string;
	readonly body: string;
	readonly updatedDay: number;
	readonly archived: boolean;
};

export type NoteInput = {
	readonly id?: string;
	readonly title: string;
	readonly body: string;
};

export type ListPage = {
	readonly notes: readonly Note[];
	readonly nextCursor: string | null;
};

export type ListOptions = {
	readonly limit?: number;
	readonly cursor?: string | null;
	readonly includeArchived?: boolean;
};

export class Repo {
	readonly #client: WorkerClient;
	readonly #codec: RowCodec;

	constructor(client: WorkerClient, vault: CryptoVault) {
		this.#client = client;
		this.#codec = new RowCodec(vault);
	}

	async bootstrap(): Promise<void> {
		await this.#client.send({ kind: "bootstrap" });
	}

	async listNotes(opts: ListOptions = {}): Promise<ListPage> {
		const res = await this.#client.send({
			kind: "listNotes",
			limit: opts.limit ?? 50,
			cursor: opts.cursor ?? null,
			includeArchived: opts.includeArchived ?? false,
		});
		return {
			notes: res.rows.map((row) => this.#decryptRow(row)),
			nextCursor: res.nextCursor,
		};
	}

	async upsertNote(input: NoteInput): Promise<Note> {
		const id = input.id ?? generateRowId();
		const updatedDay = todayDayBucket();
		const row = this.#encryptNote({ id, updatedDay, ...input });
		await this.#client.send({ kind: "upsertNote", row });
		return {
			id,
			title: input.title,
			body: input.body,
			updatedDay,
			archived: false,
		};
	}

	/**
	 * Fetch a single note by id. Returns `null` when no row matches
	 * (e.g. another tab archived-then-purged it between list + get).
	 * The plaintext fields are decrypted under this `Repo`'s vault —
	 * a mismatched vault throws an AEAD verification error from
	 * `CryptoVault.decrypt`, which is the right loud failure mode.
	 */
	async getNote(id: string): Promise<Note | null> {
		const res = await this.#client.send({ kind: "getNote", id });
		return res.row ? this.#decryptRow(res.row) : null;
	}

	async archiveNote(id: string): Promise<void> {
		await this.#client.send({ kind: "archiveNote", id });
	}

	/**
	 * Hard-delete a note. Irreversible — there is no undo. The UI is
	 * responsible for the confirmation step; this method just forwards
	 * to the worker, which removes the row and fans out `tx-applied`
	 * so every tab drops the id from its cached list on reload.
	 *
	 * A delete against a non-existent id (e.g. another tab deleted it
	 * first) is treated as success — the row is gone either way, which
	 * matches the user-facing semantics.
	 */
	async deleteNote(id: string): Promise<void> {
		await this.#client.send({ kind: "deleteNote", id });
	}

	async close(): Promise<void> {
		try {
			await this.#client.send({ kind: "close" });
		} finally {
			this.#client.terminate();
		}
	}

	/**
	 * Subscribe to `tx-applied` events fan-out by the worker over the
	 * shared `BroadcastChannel`. Returns an unsubscribe function. The
	 * originating tab also receives its own writes — the listener is
	 * the right place to invalidate a UI cache without manually
	 * propagating from each mutation site.
	 */
	subscribeTxApplied(listener: (ids: readonly string[]) => void): () => void {
		return subscribeTxApplied((notification) => {
			if (notification.kind === "tx-applied") listener(notification.ids);
		});
	}

	#encryptNote(input: {
		id: string;
		updatedDay: number;
		title: string;
		body: string;
	}): EncryptedNoteRow {
		const title = this.#codec.encryptField(input.id, TITLE_FIELD, input.title);
		const body = this.#codec.encryptField(input.id, BODY_FIELD, input.body);
		return {
			id: input.id,
			updatedDay: input.updatedDay,
			archived: false,
			titleNonce: title.nonce,
			titleCiphertext: title.ciphertext,
			bodyNonce: body.nonce,
			bodyCiphertext: body.ciphertext,
		};
	}

	#decryptRow(row: EncryptedNoteRow): Note {
		return {
			id: row.id,
			title: this.#codec.decryptField(row.id, TITLE_FIELD, {
				nonce: row.titleNonce,
				ciphertext: row.titleCiphertext,
			}),
			body: this.#codec.decryptField(row.id, BODY_FIELD, {
				nonce: row.bodyNonce,
				ciphertext: row.bodyCiphertext,
			}),
			updatedDay: row.updatedDay,
			archived: row.archived,
		};
	}
}
