/**
 * `@opfs/ui` — React components for opfs-webauthn.
 *
 * Stub: only re-exports the type-level handles dependents need. The
 * actual `<AuthScreen>`, `<NotesShell>`, and primitive components land
 * with the UI implementation PR.
 */

export type AuthScreenProps = {
	readonly state: "locked" | "unlocking" | "enrolling" | "unsupported";
	readonly onEnroll: () => void;
	readonly onUnlock: () => void;
};

export type NotesShellProps = {
	readonly theme: "light" | "dark" | "system";
	readonly onThemeChange: (theme: NotesShellProps["theme"]) => void;
};
