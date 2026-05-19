/**
 * Plaintext wire codec for shared notes. Sender encodes `{title, body}`
 * to JSON-UTF8 bytes; receiver decodes back to the same shape and
 * hands it to `repo.upsertNote`. Kept tiny — the AEAD layer above
 * already authenticates this payload, so we just need a stable shape.
 */

import type { NoteInput } from "@opfs/storage";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export type SharedNote = Pick<NoteInput, "title" | "body">;

export function encodeSharedNote(note: SharedNote): Uint8Array {
	const json = JSON.stringify({ title: note.title, body: note.body });
	return encoder.encode(json);
}

export function decodeSharedNote(bytes: Uint8Array): SharedNote {
	const text = decoder.decode(bytes);
	const parsed = JSON.parse(text) as { title?: unknown; body?: unknown };
	if (typeof parsed.title !== "string" || typeof parsed.body !== "string") {
		throw new Error("shared note missing `title` or `body`");
	}
	return { title: parsed.title, body: parsed.body };
}
