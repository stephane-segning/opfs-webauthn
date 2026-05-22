"use client";

import type { CryptoVault } from "@opfs/core-wasm";
import type { Note, Repo } from "@opfs/storage";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useIdleVaultLock } from "../app/use-idle-vault-lock";
import type { SharedNote } from "../share/note-codec";
import { ReceiveShareDialog } from "../share/receive-dialog";
import { SendShareDialog } from "../share/send-dialog";
import { getShareConfig } from "../share/share-config";
import { NoteEditor } from "./note-editor";
import { NotesList } from "./notes-list";
import { useNotes } from "./use-notes";
import { useNotesRepo } from "./use-notes-repo";

/**
 * `selection` is the editor's view-model:
 *   none      — list visible, no editor
 *   { new }   — list visible, editor open for a new note
 *   { note }  — list visible, editor open for `note`
 *
 * Keeping the editor as a peer of the list lets each render
 * independently — single responsibility, no shared mutable state.
 */
type Selection =
	| { readonly kind: "none" }
	| { readonly kind: "draft"; readonly note: Note | null };

const NO_SELECTION: Selection = { kind: "none" };

export type NotesShellProps = {
	readonly vault: CryptoVault;
	readonly onLock: () => void;
};

export function NotesShell({ vault, onLock }: NotesShellProps) {
	const t = useTranslations("notes");
	// Idle auto-lock (ADR 0005): lock after 5 minutes of inactivity
	// across ALL tabs. The hook is active for the entire lifetime of
	// NotesShell (i.e. while the vault is open) and cleans up on unmount.
	useIdleVaultLock(onLock);
	const repoState = useNotesRepo(vault);

	if (repoState.status === "loading" || repoState.status === "idle") {
		return <ShellChrome onLock={onLock}>{<LoadingBody />}</ShellChrome>;
	}
	if (repoState.status === "error") {
		return (
			<ShellChrome onLock={onLock}>
				<p className="auth-error" role="alert">
					{repoState.error.message}
				</p>
			</ShellChrome>
		);
	}
	return (
		<ShellChrome onLock={onLock}>
			<NotesView onLock={onLock} repo={repoState.repo} t={t} />
		</ShellChrome>
	);
}

function ShellChrome({
	children,
	onLock,
}: {
	readonly children: React.ReactNode;
	readonly onLock: () => void;
}) {
	const t = useTranslations("notes");
	return (
		<main className="notes-shell">
			<header className="notes-header">
				<h1 className="notes-title">{t("shell.title")}</h1>
				<button className="auth-link" onClick={onLock} type="button">
					{t("shell.lock")}
				</button>
			</header>
			<div className="notes-body">{children}</div>
		</main>
	);
}

function LoadingBody() {
	const t = useTranslations("notes");
	return (
		<div className="notes-loading" role="status">
			<div className="auth-spinner" />
			<p>{t("shell.loading")}</p>
		</div>
	);
}

/** Dialog overlay state, peer to `Selection`. */
type ShareDialog =
	| { readonly kind: "none" }
	| { readonly kind: "receive" }
	| { readonly kind: "send"; readonly payload: SharedNote };

const NO_DIALOG: ShareDialog = { kind: "none" };

/**
 * Filter `notes` by a free-text query over title + body.
 * Empty/whitespace query returns the full list unchanged (reference-
 * stable so React skips re-renders of the child list component).
 */
function applySearch(notes: readonly Note[], query: string): readonly Note[] {
	const q = query.trim().toLowerCase();
	if (!q) return notes;
	return notes.filter(
		(n) =>
			n.title.toLowerCase().includes(q) || n.body.toLowerCase().includes(q),
	);
}

function NotesView({
	repo,
	t,
}: {
	readonly repo: Repo;
	readonly onLock: () => void;
	readonly t: ReturnType<typeof useTranslations>;
}) {
	const { state, snapshot } = useNotes(repo);
	const [selection, setSelection] = useState<Selection>(NO_SELECTION);
	const [share, setShare] = useState<ShareDialog>(NO_DIALOG);
	const [query, setQuery] = useState("");
	const shareConfig = getShareConfig();

	const { showArchived, setShowArchived } = snapshot;

	// All hooks must run unconditionally before any early returns.
	const allNotes = state.status === "ready" ? state.notes : [];
	const visibleNotes = useMemo(
		() => applySearch(allNotes, query),
		// applySearch is a stable reference outside the component;
		// the only inputs that matter are allNotes and query.
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[allNotes, query],
	);

	async function saveDraft(draft: {
		id?: string;
		title: string;
		body: string;
	}) {
		await repo.upsertNote(draft);
		setSelection(NO_SELECTION);
	}

	async function archive(id: string) {
		await repo.archiveNote(id);
		setSelection(NO_SELECTION);
	}

	async function destroy(id: string) {
		// Hard delete goes through the store's `delete` action — not
		// `repo.deleteNote` directly — so the optimistic reload +
		// tx-applied wiring fires through the same path archive uses.
		await snapshot.delete(id);
		setSelection(NO_SELECTION);
	}

	function onReceived(note: Note) {
		// Surfacing the received note as the next edit target lets the
		// recipient verify what landed before going back to the list.
		setShare(NO_DIALOG);
		setSelection({ kind: "draft", note });
	}

	if (selection.kind === "draft") {
		return (
			<>
				<NoteEditor
					note={selection.note}
					onArchive={selection.note ? archive : undefined}
					onCancel={() => setSelection(NO_SELECTION)}
					onDelete={selection.note ? destroy : undefined}
					onSave={saveDraft}
					onShare={
						shareConfig.enabled && selection.note
							? (draft) =>
									setShare({
										kind: "send",
										payload: { title: draft.title, body: draft.body },
									})
							: undefined
					}
				/>
				{share.kind === "send" && shareConfig.enabled ? (
					<SendShareDialog
						client={shareConfig.client}
						onClose={() => setShare(NO_DIALOG)}
						payload={share.payload}
					/>
				) : null}
			</>
		);
	}

	return (
		<>
			<div className="notes-toolbar">
				<button
					className="auth-cta auth-cta-compact"
					onClick={() => setSelection({ kind: "draft", note: null })}
					type="button"
				>
					{t("shell.new")}
				</button>
				{shareConfig.enabled ? (
					<button
						className="auth-link notes-toolbar-receive"
						onClick={() => setShare({ kind: "receive" })}
						type="button"
					>
						{t("shell.receive")}
					</button>
				) : null}
				<button
					aria-pressed={showArchived}
					className="auth-link notes-toolbar-archived"
					onClick={() => setShowArchived(!showArchived)}
					type="button"
				>
					{showArchived ? t("shell.hideArchived") : t("shell.showArchived")}
				</button>
			</div>
			<div className="notes-search-row">
				<input
					aria-label={t("shell.searchLabel")}
					className="notes-search"
					onChange={(e) => setQuery(e.target.value)}
					placeholder={t("shell.searchPlaceholder")}
					type="search"
					value={query}
				/>
			</div>
			{state.status === "loading" ? (
				<LoadingBody />
			) : state.status === "error" ? (
				<p className="auth-error" role="alert">
					{state.error.message}
				</p>
			) : (
				<NotesList
					notes={visibleNotes}
					onOpen={(note) => setSelection({ kind: "draft", note })}
				/>
			)}
			{share.kind === "receive" && shareConfig.enabled ? (
				<ReceiveShareDialog
					client={shareConfig.client}
					onClose={() => setShare(NO_DIALOG)}
					onReceived={onReceived}
					repo={repo}
				/>
			) : null}
		</>
	);
}
