import type { CryptoVault } from "@opfs/core-wasm";
import { AES_GCM_NONCE_LEN } from "@opfs/core-wasm";

import { generateRowId } from "./id.js";
import type { EncryptedNoteRow } from "./row.js";
import type { WorkerClient } from "./rpc.js";
import { ROW_AAD } from "./schema.js";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const SECONDS_PER_DAY = 86_400;

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

function randomNonce(): Uint8Array {
	const buf = new Uint8Array(AES_GCM_NONCE_LEN);
	crypto.getRandomValues(buf);
	return buf;
}

function todayDayBucket(): number {
	return Math.floor(Date.now() / 1000 / SECONDS_PER_DAY);
}

function aad(field: "title" | "body", noteId: string): Uint8Array {
	return ENCODER.encode(`${ROW_AAD}/${field}/${noteId}`);
}

function encodePlaintext(text: string): Uint8Array {
	return ENCODER.encode(text);
}

function decodePlaintext(bytes: Uint8Array): string {
	return DECODER.decode(bytes);
}

/**
 * Plaintext-facing wrapper around the dedicated worker. Holds the
 * `CryptoVault` so encryption/decryption happens on the page side —
 * the worker only ever sees ciphertext + nonces.
 */
export class Repo {
	#client: WorkerClient;
	#vault: CryptoVault;

	constructor(client: WorkerClient, vault: CryptoVault) {
		this.#client = client;
		this.#vault = vault;
	}

	async bootstrap(): Promise<void> {
		const res = await this.#client.send({ kind: "bootstrap" });
		if (res.kind !== "bootstrap") {
			throw new Error(`unexpected response: ${res.kind}`);
		}
	}

	async listNotes(opts?: {
		readonly limit?: number;
		readonly cursor?: string | null;
		readonly includeArchived?: boolean;
	}): Promise<ListPage> {
		const res = await this.#client.send({
			kind: "listNotes",
			limit: opts?.limit ?? 50,
			cursor: opts?.cursor ?? null,
			includeArchived: opts?.includeArchived ?? false,
		});
		if (res.kind !== "listNotes") {
			throw new Error(`unexpected response: ${res.kind}`);
		}
		return {
			notes: res.rows.map((row) => this.#decryptRow(row)),
			nextCursor: res.nextCursor,
		};
	}

	async upsertNote(input: NoteInput): Promise<Note> {
		const id = input.id ?? generateRowId();
		const updatedDay = todayDayBucket();
		const titleNonce = randomNonce();
		const bodyNonce = randomNonce();
		const titleCiphertext = this.#vault.encrypt(
			titleNonce,
			aad("title", id),
			encodePlaintext(input.title),
		);
		const bodyCiphertext = this.#vault.encrypt(
			bodyNonce,
			aad("body", id),
			encodePlaintext(input.body),
		);
		const row: EncryptedNoteRow = {
			id,
			updatedDay,
			archived: false,
			titleNonce,
			titleCiphertext,
			bodyNonce,
			bodyCiphertext,
		};
		const res = await this.#client.send({ kind: "upsertNote", row });
		if (res.kind !== "upsertNote") {
			throw new Error(`unexpected response: ${res.kind}`);
		}
		return {
			id,
			title: input.title,
			body: input.body,
			updatedDay,
			archived: false,
		};
	}

	async archiveNote(id: string): Promise<void> {
		const res = await this.#client.send({ kind: "archiveNote", id });
		if (res.kind !== "archiveNote") {
			throw new Error(`unexpected response: ${res.kind}`);
		}
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

	#decryptRow(row: EncryptedNoteRow): Note {
		const titleBytes = this.#vault.decrypt(
			row.titleNonce,
			aad("title", row.id),
			row.titleCiphertext,
		);
		const bodyBytes = this.#vault.decrypt(
			row.bodyNonce,
			aad("body", row.id),
			row.bodyCiphertext,
		);
		return {
			id: row.id,
			title: decodePlaintext(titleBytes),
			body: decodePlaintext(bodyBytes),
			updatedDay: row.updatedDay,
			archived: row.archived,
		};
	}
}
