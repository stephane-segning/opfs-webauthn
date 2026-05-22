/**
 * Notes-store tests. We drive the store against an in-process fake
 * `Repo` so the assertions cover the orchestration: initial load,
 * tx-applied reload, upsert + archive delegation, showArchived toggle,
 * and the last-writer-wins generation guard.
 */

import type { ListPage, Note, NoteInput, Repo } from "@opfs/storage";
import { beforeEach, describe, expect, it } from "vitest";

import { createNotesStore } from "./notes-store.js";

type ListOpts = {
	limit?: number;
	cursor?: string | null;
	includeArchived?: boolean;
};

class FakeRepo {
	/** All notes, including archived ones. */
	#notes: Note[] = [];
	#listeners = new Set<(ids: readonly string[]) => void>();

	async listNotes(opts: ListOpts = {}): Promise<ListPage> {
		const visible = opts.includeArchived
			? this.#notes
			: this.#notes.filter((n) => !n.archived);
		const limit = opts.limit ?? visible.length;
		const cursor = opts.cursor ?? null;
		const start = cursor ? Number.parseInt(cursor, 10) : 0;
		const end = Math.min(start + limit, visible.length);
		const notes = visible.slice(start, end);
		const nextCursor = end < visible.length ? String(end) : null;
		return { notes, nextCursor };
	}

	async upsertNote(input: NoteInput): Promise<Note> {
		const id = input.id ?? `id-${this.#notes.length + 1}`;
		const existingIdx = this.#notes.findIndex((n) => n.id === id);
		const note: Note = {
			id,
			title: input.title,
			body: input.body,
			updatedDay: 0,
			archived: false,
		};
		if (existingIdx >= 0) this.#notes.splice(existingIdx, 1, note);
		else this.#notes.push(note);
		queueMicrotask(() => this.#fire([id]));
		return note;
	}

	async archiveNote(id: string): Promise<void> {
		this.#notes = this.#notes.map((n) =>
			n.id === id ? { ...n, archived: true } : n,
		);
		queueMicrotask(() => this.#fire([id]));
	}

	async deleteNote(id: string): Promise<void> {
		this.#notes = this.#notes.filter((n) => n.id !== id);
		queueMicrotask(() => this.#fire([id]));
	}

	subscribeTxApplied(listener: (ids: readonly string[]) => void): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	#fire(ids: readonly string[]): void {
		for (const l of this.#listeners) l(ids);
	}
}

const asRepo = (fake: FakeRepo): Repo => fake as unknown as Repo;

/** Drain pending microtasks so the test reads steady state. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe("createNotesStore", () => {
	let fake: FakeRepo;

	beforeEach(() => {
		fake = new FakeRepo();
	});

	it("starts in loading and transitions to ready after the initial load", async () => {
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		expect(store.getState().state.status).toBe("loading");
		await settle();
		const ready = store.getState().state;
		expect(ready.status).toBe("ready");
		if (ready.status === "ready") expect(ready.notes).toHaveLength(0);
		unsubscribe();
	});

	it("showArchived defaults to false", async () => {
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();
		expect(store.getState().showArchived).toBe(false);
		unsubscribe();
	});

	it("setShowArchived true reveals archived notes", async () => {
		await fake.upsertNote({ title: "visible", body: "" });
		await fake.upsertNote({ title: "archived", body: "" });
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();
		// Archive the second note.
		await store.getState().archive("id-2");
		await settle();

		// Default: archived note is hidden.
		let state = store.getState().state;
		expect(state.status).toBe("ready");
		if (state.status === "ready") {
			expect(state.notes.map((n) => n.title)).toEqual(["visible"]);
		}

		// Toggle on — reload includes archived.
		store.getState().setShowArchived(true);
		await settle();
		state = store.getState().state;
		expect(state.status).toBe("ready");
		if (state.status === "ready") {
			const titles = state.notes.map((n) => n.title);
			expect(titles).toContain("visible");
			expect(titles).toContain("archived");
		}

		// Toggle off — archived note disappears again.
		store.getState().setShowArchived(false);
		await settle();
		state = store.getState().state;
		if (state.status === "ready") {
			expect(state.notes.map((n) => n.title)).toEqual(["visible"]);
		}
		unsubscribe();
	});

	it("setShowArchived with the same value is a no-op (no extra reload)", async () => {
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();
		let listCallCount = 0;
		const original = fake.listNotes.bind(fake);
		fake.listNotes = async (opts) => {
			listCallCount += 1;
			return original(opts);
		};
		store.getState().setShowArchived(false); // already false
		await settle();
		expect(listCallCount).toBe(0);
		unsubscribe();
	});

	it("upsert delegates to the repo and tx-applied triggers a reload", async () => {
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();
		await store.getState().upsert({ title: "t1", body: "b1" });
		// Reload runs on the broadcast — give it a tick.
		await settle();
		const ready = store.getState().state;
		expect(ready.status).toBe("ready");
		if (ready.status === "ready") {
			expect(ready.notes.map((n) => n.title)).toEqual(["t1"]);
		}
		unsubscribe();
	});

	it("archive hides the note from the default (showArchived=false) view", async () => {
		await fake.upsertNote({ title: "doomed", body: "" });
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();
		await store.getState().archive("id-1");
		await settle();
		const ready = store.getState().state;
		expect(ready.status).toBe("ready");
		if (ready.status === "ready") expect(ready.notes).toHaveLength(0);
		unsubscribe();
	});

	it("delete removes the note from the list even when archived is visible", async () => {
		// Hard delete differs from archive: even with showArchived=true
		// the row is gone, because the underlying repo dropped it.
		await fake.upsertNote({ title: "doomed", body: "" });
		await fake.upsertNote({ title: "kept", body: "" });
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();
		store.getState().setShowArchived(true);
		await settle();

		await store.getState().delete("id-1");
		await settle();

		const ready = store.getState().state;
		expect(ready.status).toBe("ready");
		if (ready.status === "ready") {
			expect(ready.notes.map((n) => n.title)).toEqual(["kept"]);
		}
		unsubscribe();
	});

	it("delete tx-applied reload drops the id from the cached list", async () => {
		// Mirrors the archive flow: the delete action does not splice
		// optimistically, it relies on the broadcast-driven reload.
		await fake.upsertNote({ title: "doomed", body: "" });
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();

		await store.getState().delete("id-1");
		await settle();

		const ready = store.getState().state;
		expect(ready.status).toBe("ready");
		if (ready.status === "ready") expect(ready.notes).toHaveLength(0);
		unsubscribe();
	});

	it("surfaces a listNotes error as state: error", async () => {
		fake.listNotes = async () => {
			throw new Error("boom");
		};
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();
		const errored = store.getState().state;
		expect(errored.status).toBe("error");
		if (errored.status === "error") expect(errored.error.message).toBe("boom");
		unsubscribe();
	});

	it("last-writer-wins: a stale reload cannot overwrite a fresh one", async () => {
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();

		// Replace listNotes with a sequence-aware fake — the first
		// call (slow) stalls until we release it; the second call
		// (fast) stalls on its own gate and gets released first. The
		// store must publish call-2's result and discard call-1's.
		let releaseSlow: () => void = () => {};
		let releaseFast: () => void = () => {};
		const slowGate = new Promise<void>((r) => {
			releaseSlow = r;
		});
		const fastGate = new Promise<void>((r) => {
			releaseFast = r;
		});
		let call = 0;
		const noteFor = (title: string): Note => ({
			id: `id-${title}`,
			title,
			body: "",
			updatedDay: 0,
			archived: false,
		});
		fake.listNotes = async (): Promise<ListPage> => {
			// Capture the sequence number *before* awaiting the gate.
			// Codex caught that reading `call` after the await would
			// let the slow call also return "call-2", which would make
			// the assertion pass even if the LWW guard misfired.
			call += 1;
			const ordinal = call;
			if (ordinal === 1) await slowGate;
			else await fastGate;
			return { notes: [noteFor(`call-${ordinal}`)], nextCursor: null };
		};

		const slow = store.getState().reload();
		const fast = store.getState().reload();

		// Fast finishes first — the store publishes call-2.
		releaseFast();
		await fast;
		await settle();
		const afterFast = store.getState().state;
		expect(afterFast.status).toBe("ready");
		if (afterFast.status === "ready") {
			expect(afterFast.notes.map((n) => n.title)).toEqual(["call-2"]);
		}

		// Now release the slow one — its publish path must short-circuit
		// on the generation check, leaving call-2 intact.
		releaseSlow();
		await slow;
		await settle();
		const final = store.getState().state;
		expect(final.status).toBe("ready");
		if (final.status === "ready") {
			expect(final.notes.map((n) => n.title)).toEqual(["call-2"]);
		}
		unsubscribe();
	});

	it("unsubscribe detaches the tx-applied listener", async () => {
		const { store, unsubscribe } = createNotesStore(asRepo(fake));
		await settle();
		unsubscribe();
		await fake.upsertNote({ title: "after-teardown", body: "" });
		await settle();
		// The store should still show its last-known state because the
		// broadcast no longer triggers a reload.
		const ready = store.getState().state;
		expect(ready.status).toBe("ready");
		if (ready.status === "ready") expect(ready.notes).toHaveLength(0);
	});
});
