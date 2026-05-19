/**
 * Plaintext-facing repository. Orchestrates the page side of the
 * write path:
 *
 *   Note  ──RowCodec──▶  EncryptedNoteRow  ──WorkerClient──▶  worker
 *
 * and the read path in reverse. The worker never sees plaintext; the
 * codec is the only thing that holds the `CryptoVault`.
 */

import type { CryptoVault } from "@opfs/core-wasm";

import { generateRowId } from "./id.js";
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

	async archiveNote(id: string): Promise<void> {
		await this.#client.send({ kind: "archiveNote", id });
	}

	async close(): Promise<void> {
		try {
			await this.#client.send({ kind: "close" });
		} finally {
			this.#client.terminate();
		}
	}

	subscribeTxApplied(listener: (ids: readonly string[]) => void): () => void {
		return this.#client.on("tx-applied", (event) => listener(event.ids));
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
