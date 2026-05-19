"use client";

import {
	createNotesStore,
	type NotesState,
	type NotesStore,
} from "@opfs/state";
import type { Repo } from "@opfs/storage";
import { useEffect, useState, useSyncExternalStore } from "react";

/**
 * React adapter over the `@opfs/state` Zustand notes store (ADR 0009).
 *
 * The store owns the load-page-through, the tx-applied subscription,
 * and the last-writer-wins reload guard. This hook is just the
 * `useSyncExternalStore` glue — one store per `Repo`, recreated when
 * the vault swaps. Splitting framework wiring from the store means
 * the store is unit-testable without React and the hook stays
 * boring.
 */
export type { NotesState } from "@opfs/state";

export function useNotes(repo: Repo): {
	readonly state: NotesState;
	readonly reload: () => Promise<void>;
} {
	const [bundle, setBundle] = useState<{
		readonly store: NotesStore;
		readonly unsubscribe: () => void;
	} | null>(null);

	useEffect(() => {
		const created = createNotesStore(repo);
		setBundle(created);
		return () => {
			created.unsubscribe();
		};
	}, [repo]);

	const state = useSyncExternalStore(
		(listener) => bundle?.store.subscribe(listener) ?? (() => {}),
		() => bundle?.store.getState().state ?? loadingState,
		() => loadingState,
	);

	const reload = async (): Promise<void> => {
		await bundle?.store.getState().reload();
	};

	return { state, reload };
}

/**
 * Stable loading-state singleton — `useSyncExternalStore` requires a
 * referentially-stable snapshot when the store hasn't mounted yet,
 * otherwise React warns about infinite re-renders.
 */
const loadingState: NotesState = { status: "loading" };
