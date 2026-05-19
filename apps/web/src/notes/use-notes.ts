"use client";

import type { Note, Repo } from "@opfs/storage";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Subscribe to the notes list for a given repo. Reloads on mount and
 * on every `tx-applied` broadcast — the worker tells us when a write
 * lands and we re-page from disk rather than maintaining a client-side
 * diff. Simpler, correct, matches ADR 0009.
 *
 * Pages through to completion so we never silently truncate the list.
 * For very large vaults this is O(notes) per reload; when that
 * matters we can swap in virtualised pagination behind the same hook
 * signature.
 *
 * Reloads are last-writer-wins: a monotonically increasing generation
 * counter marks each invocation, and only the latest one is allowed
 * to publish state. This kills the race where a slow page-through
 * over a large vault completes after a newer `tx-applied` reload and
 * would otherwise overwrite fresh data with stale.
 */
export type NotesState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly notes: readonly Note[] }
	| { readonly status: "error"; readonly error: Error };

const PAGE_SIZE = 200;
const MAX_PAGES = 200; // 200 × 200 = 40 000 — generous safety net.

async function loadAllNotes(repo: Repo): Promise<readonly Note[]> {
	const collected: Note[] = [];
	let cursor: string | null = null;
	for (let i = 0; i < MAX_PAGES; i++) {
		const page = await repo.listNotes({ limit: PAGE_SIZE, cursor });
		collected.push(...page.notes);
		if (!page.nextCursor) return collected;
		cursor = page.nextCursor;
	}
	throw new Error(
		`refused to load past ${MAX_PAGES * PAGE_SIZE} notes; add a paged view`,
	);
}

export function useNotes(repo: Repo): {
	readonly state: NotesState;
	readonly reload: () => Promise<void>;
} {
	const [state, setState] = useState<NotesState>({ status: "loading" });
	const generationRef = useRef(0);

	const reload = useCallback(async () => {
		const generation = ++generationRef.current;
		const isLatest = () => generationRef.current === generation;
		try {
			const notes = await loadAllNotes(repo);
			if (isLatest()) setState({ status: "ready", notes });
		} catch (err) {
			if (isLatest()) {
				setState({
					status: "error",
					error: err instanceof Error ? err : new Error(String(err)),
				});
			}
		}
	}, [repo]);

	useEffect(() => {
		void reload();
		return repo.subscribeTxApplied(() => void reload());
	}, [repo, reload]);

	return { state, reload };
}
