"use client";

import type { CryptoVault } from "@opfs/core-wasm";
import type { Note, Repo } from "@opfs/storage";
import { useTranslations } from "next-intl";
import { useState } from "react";

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

function NotesView({
	repo,
	t,
}: {
	readonly repo: Repo;
	readonly onLock: () => void;
	readonly t: ReturnType<typeof useTranslations>;
}) {
	const { state } = useNotes(repo);
	const [selection, setSelection] = useState<Selection>(NO_SELECTION);

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

	if (selection.kind === "draft") {
		return (
			<NoteEditor
				note={selection.note}
				onArchive={selection.note ? archive : undefined}
				onCancel={() => setSelection(NO_SELECTION)}
				onSave={saveDraft}
			/>
		);
	}

	const notes = state.status === "ready" ? state.notes : [];
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
			</div>
			{state.status === "loading" ? (
				<LoadingBody />
			) : state.status === "error" ? (
				<p className="auth-error" role="alert">
					{state.error.message}
				</p>
			) : (
				<NotesList
					notes={notes}
					onOpen={(note) => setSelection({ kind: "draft", note })}
				/>
			)}
		</>
	);
}
