/**
 * `@opfs/state` — Zustand store contracts (ADR 0009).
 *
 * Each slice is one bounded concern. Stores expose commands (perform
 * an action, optimistically update local state) and selectors (small
 * functions the UI subscribes to). The storage worker dispatches into
 * these stores from outside React via `useNotesStore.getState()`.
 *
 * The actual `create()` calls live in their per-slice files alongside
 * the eventual reducer-like cores; this stub declares the slice shape
 * so dependent packages can type-check.
 */

import type { Note } from "@opfs/storage";

export type VaultState =
	| { readonly status: "unsupported" }
	| { readonly status: "locked" }
	| { readonly status: "unlocking" }
	| { readonly status: "unlocked" }
	| { readonly status: "enrolling" };

export type NotesSlice = {
	readonly notes: readonly Note[];
	readonly loaded: boolean;
	readonly load: () => Promise<void>;
	readonly upsert: (note: Pick<Note, "id" | "title" | "body">) => Promise<void>;
	readonly archive: (id: string) => Promise<void>;
	readonly applyTxApplied: (ids: readonly string[]) => void;
};

export type UiSlice = {
	readonly theme: "light" | "dark" | "system";
	readonly sidebarCollapsed: boolean;
	readonly setTheme: (theme: UiSlice["theme"]) => void;
	readonly toggleSidebar: () => void;
};
