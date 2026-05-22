"use client";

import {
	createNotesStore,
	type NotesState,
	type NotesStore,
	type NotesStoreSnapshot,
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
 *
 * Callers that need to dispatch actions (e.g. `setShowArchived`) can
 * use the `store` handle directly; it is stable for the lifetime of
 * the bound `Repo`.
 */
export type { NotesState } from "@opfs/state";

export function useNotes(repo: Repo): {
	readonly state: NotesState;
	readonly snapshot: NotesStoreSnapshot;
	readonly reload: () => Promise<void>;
	/** The underlying Zustand store — stable per Repo lifetime. */
	readonly store: NotesStore | null;
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

	const snapshot = useSyncExternalStore(
		(listener) => bundle?.store.subscribe(listener) ?? (() => {}),
		() => bundle?.store.getState() ?? emptySnapshot,
		() => emptySnapshot,
	);

	const reload = async (): Promise<void> => {
		await bundle?.store.getState().reload();
	};

	return {
		state: snapshot.state,
		snapshot,
		reload,
		store: bundle?.store ?? null,
	};
}

/**
 * Stable snapshot when the store hasn't mounted yet.
 * `useSyncExternalStore` requires referential stability for the
 * server / pre-mount case, otherwise React warns about tearing.
 */
const emptySnapshot: NotesStoreSnapshot = {
	state: { status: "loading" },
	showArchived: false,
	reload: async () => {},
	upsert: async () => {
		throw new Error("store not mounted");
	},
	archive: async () => {},
	setShowArchived: () => {},
};
