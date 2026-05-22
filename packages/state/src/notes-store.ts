/**
 * Zustand notes store (ADR 0009). One slice per repo, created by
 * `createNotesStore(repo)`. The store owns:
 *
 *   - the loaded note list (paged through to completion so we never
 *     silently truncate),
 *   - upsert / archive commands that go straight to the repo,
 *   - a `showArchived` flag that drives `includeArchived` on the
 *     `listNotes` call; toggling it triggers a reload,
 *   - a `tx-applied` subscription so other tabs' writes flow back in.
 *
 * Last-writer-wins reload guard: every reload bumps a monotonically
 * increasing `generation`. Only the latest invocation is allowed to
 * publish state, so a slow page-through over a large vault cannot
 * overwrite a freshly-reloaded list with stale data.
 */

import type { Note, NoteInput, Repo } from "@opfs/storage";
import { createStore, type StoreApi } from "zustand/vanilla";

const PAGE_SIZE = 200;
const MAX_PAGES = 200; // 200 × 200 = 40 000 notes safety net.

export type NotesState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly notes: readonly Note[] }
	| { readonly status: "error"; readonly error: Error };

export type NotesStoreSnapshot = {
	readonly state: NotesState;
	/** Whether archived notes are included in the loaded list. */
	readonly showArchived: boolean;
	readonly reload: () => Promise<void>;
	readonly upsert: (note: NoteInput) => Promise<Note>;
	readonly archive: (id: string) => Promise<void>;
	/**
	 * Hard-delete the note. Irreversible — the row is removed entirely.
	 * The repo's `tx-applied` broadcast triggers a reload that drops
	 * the id from the cached list. Mirrors `archive` so the UI can
	 * call either action through the same store surface.
	 */
	readonly delete: (id: string) => Promise<void>;
	/**
	 * Toggle the archived-visibility flag. Immediately triggers a
	 * reload so the new state is consistent with what's on disk.
	 */
	readonly setShowArchived: (show: boolean) => void;
};

/** Internal slice — `generation` is hidden from consumers. */
type Internal = NotesStoreSnapshot & {
	readonly generation: number;
};

export type NotesStore = StoreApi<NotesStoreSnapshot>;

async function loadAllNotes(
	repo: Repo,
	includeArchived: boolean,
): Promise<readonly Note[]> {
	const collected: Note[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < MAX_PAGES; i++) {
		const page = await repo.listNotes({
			limit: PAGE_SIZE,
			cursor,
			includeArchived,
		});
		collected.push(...page.notes);
		if (!page.nextCursor) return collected;
		cursor = page.nextCursor;
	}
	throw new Error(
		`refused to load past ${MAX_PAGES * PAGE_SIZE} notes; add a paged view`,
	);
}

/**
 * Build a notes store bound to `repo`. The returned store implements
 * the public `NotesStoreSnapshot` contract; the `generation` counter
 * is held in the internal slice but not exposed to consumers.
 *
 * Returns the store + an `unsubscribe` for the repo's tx-applied
 * channel. Callers (typically a React hook) must invoke it on
 * teardown, otherwise the broadcast subscription leaks.
 */
export function createNotesStore(repo: Repo): {
	readonly store: NotesStore;
	readonly unsubscribe: () => void;
} {
	const store = createStore<Internal>((set, get) => {
		const isLatest = (gen: number) => get().generation === gen;

		async function reload(): Promise<void> {
			const next = get().generation + 1;
			set({ generation: next });
			try {
				const notes = await loadAllNotes(repo, get().showArchived);
				if (isLatest(next)) {
					set({ state: { status: "ready", notes } });
				}
			} catch (err) {
				if (isLatest(next)) {
					set({
						state: {
							status: "error",
							error: err instanceof Error ? err : new Error(String(err)),
						},
					});
				}
			}
		}

		return {
			state: { status: "loading" },
			generation: 0,
			showArchived: false,
			reload,
			async upsert(note: NoteInput): Promise<Note> {
				const saved = await repo.upsertNote(note);
				// The repo's `tx-applied` broadcast will trigger a reload
				// for every connected tab — including this one — so we
				// don't need to optimistically splice here.
				return saved;
			},
			async archive(id: string): Promise<void> {
				await repo.archiveNote(id);
			},
			async delete(id: string): Promise<void> {
				// Hard delete. The dispatcher broadcasts `tx-applied`
				// with the id and the resulting reload removes the row
				// from `state.notes`. No optimistic splice — staying
				// consistent with `upsert`/`archive` keeps a single
				// source of truth.
				await repo.deleteNote(id);
			},
			setShowArchived(show: boolean): void {
				if (get().showArchived === show) return;
				set({ showArchived: show });
				void reload();
			},
		};
	});

	const unsubscribe = repo.subscribeTxApplied(() => {
		void store.getState().reload();
	});
	void store.getState().reload();

	return { store, unsubscribe };
}
