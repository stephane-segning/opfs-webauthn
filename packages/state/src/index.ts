/**
 * `@opfs/state` — Zustand stores for opfs-webauthn (ADR 0009).
 *
 * Each store is one bounded concern. Commands mutate the slice and
 * delegate persistence to the `Repo`; selectors are plain functions
 * over the slice the UI subscribes to via `useStore`.
 *
 * The notes store is bound to a single `Repo` instance — one store
 * per opened vault. Future slices (vault auth state, share session,
 * UI theme) will follow the same pattern and land alongside.
 */

export {
	createNotesStore,
	type NotesState,
	type NotesStore,
	type NotesStoreSnapshot,
} from "./notes-store.js";
