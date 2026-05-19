"use client";

import type { Note, Repo } from "@opfs/storage";
import { useCallback, useEffect, useState } from "react";

/**
 * Subscribe to the notes list for a given repo. Reloads on mount and
 * on every `tx-applied` broadcast — the worker tells us when a write
 * lands and we re-page from disk rather than maintaining our own
 * mutation diff. Simpler, correct, and matches ADR 0009.
 */
export type NotesState =
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly notes: readonly Note[] }
	| { readonly status: "error"; readonly error: Error };

const PAGE_SIZE = 100;

export function useNotes(repo: Repo): {
	readonly state: NotesState;
	readonly reload: () => Promise<void>;
} {
	const [state, setState] = useState<NotesState>({ status: "loading" });

	const reload = useCallback(async () => {
		try {
			const page = await repo.listNotes({ limit: PAGE_SIZE });
			setState({ status: "ready", notes: page.notes });
		} catch (err) {
			setState({
				status: "error",
				error: err instanceof Error ? err : new Error(String(err)),
			});
		}
	}, [repo]);

	useEffect(() => {
		void reload();
		return repo.subscribeTxApplied(() => void reload());
	}, [repo, reload]);

	return { state, reload };
}
