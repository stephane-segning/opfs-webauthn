"use client";

import type { Note } from "@opfs/storage";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useModalDialog } from "../share/use-modal-dialog";

/**
 * Draft input local to the editor. `id` carries through on update;
 * absence means "new note", which the Repo turns into a fresh id.
 */
type Draft = { id?: string; title: string; body: string };

const EMPTY_DRAFT: Draft = { title: "", body: "" };

function fromNote(note: Note | null): Draft {
	return note
		? { id: note.id, title: note.title, body: note.body }
		: EMPTY_DRAFT;
}

export type NoteEditorProps = {
	/** The note being edited, or `null` to compose a new one. */
	readonly note: Note | null;
	readonly onCancel: () => void;
	readonly onSave: (draft: Draft) => Promise<void>;
	readonly onArchive?: (id: string) => Promise<void>;
	/**
	 * Hard-delete affordance. Distinct from `onArchive`: archive is
	 * recoverable, this one wipes the row entirely. The editor opens a
	 * confirmation dialog before invoking the handler — the prop is
	 * the post-confirmation action, not the user-facing button click.
	 * Wired through the store's `delete` action (not `repo.deleteNote`
	 * directly) so the optimistic reload + tx-applied wiring fires.
	 */
	readonly onDelete?: (id: string) => Promise<void>;
	/**
	 * Optional share affordance. Receives the *current* draft so the
	 * recipient sees what's on screen, not the stale persisted note —
	 * codex pointed out that capturing the parent's `selection.note`
	 * would silently send pre-edit content if the user tapped Share
	 * before tapping Save.
	 */
	readonly onShare?: (draft: { title: string; body: string }) => void;
};

export function NoteEditor({
	note,
	onCancel,
	onSave,
	onArchive,
	onDelete,
	onShare,
}: NoteEditorProps) {
	const t = useTranslations("notes");
	const [draft, setDraft] = useState<Draft>(fromNote(note));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [confirmingDelete, setConfirmingDelete] = useState(false);
	// A ref guards against double-submission within the same tick;
	// React's `setBusy(true)` only disables the button on the next
	// render, so the second click of a rapid pair would otherwise
	// race past the disabled prop and produce a duplicate note.
	const inflight = useRef(false);

	// If the parent swaps the active note while we're open, sync.
	useEffect(() => {
		setDraft(fromNote(note));
		setError(null);
	}, [note]);

	const dirty = note
		? draft.title !== note.title || draft.body !== note.body
		: draft.title.length > 0 || draft.body.length > 0;

	async function runGuarded(action: () => Promise<void>): Promise<void> {
		if (inflight.current) return;
		inflight.current = true;
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			inflight.current = false;
			setBusy(false);
		}
	}

	const handleSave = () => runGuarded(() => onSave(draft));
	const handleArchive = () => {
		if (!note || !onArchive) return Promise.resolve();
		return runGuarded(() => onArchive(note.id));
	};
	const handleConfirmDelete = () => {
		if (!note || !onDelete) return Promise.resolve();
		return runGuarded(async () => {
			await onDelete(note.id);
			// The parent closes the editor via its `onSave`/`onArchive`
			// flow; mirror that here so the confirmation overlay tears
			// down even if the parent decides to keep the editor open.
			setConfirmingDelete(false);
		});
	};

	return (
		<section aria-label={t("editor.region")} className="note-editor">
			<header className="note-editor-bar">
				<button
					className="auth-link"
					disabled={busy}
					onClick={onCancel}
					type="button"
				>
					{t("editor.cancel")}
				</button>
				<button
					className="auth-cta auth-cta-compact"
					disabled={busy || !dirty}
					onClick={handleSave}
					type="button"
				>
					{t("editor.save")}
				</button>
			</header>
			{error ? (
				<p className="auth-error" role="alert">
					{error}
				</p>
			) : null}
			<input
				aria-label={t("editor.titleLabel")}
				className="note-editor-title"
				disabled={busy}
				onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
				placeholder={t("editor.titlePlaceholder")}
				type="text"
				value={draft.title}
			/>
			<textarea
				aria-label={t("editor.bodyLabel")}
				className="note-editor-body"
				disabled={busy}
				onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
				placeholder={t("editor.bodyPlaceholder")}
				value={draft.body}
			/>
			<div className="note-editor-foot">
				{note && onShare ? (
					<button
						className="auth-link"
						disabled={busy}
						onClick={() => onShare({ title: draft.title, body: draft.body })}
						type="button"
					>
						{t("editor.share")}
					</button>
				) : null}
				{note && onArchive ? (
					<button
						className="auth-link note-editor-archive"
						disabled={busy}
						onClick={handleArchive}
						type="button"
					>
						{t("editor.archive")}
					</button>
				) : null}
				{note && onDelete ? (
					<button
						className="auth-link note-editor-delete"
						disabled={busy}
						onClick={() => setConfirmingDelete(true)}
						type="button"
					>
						{t("editor.delete")}
					</button>
				) : null}
			</div>
			{confirmingDelete && note && onDelete ? (
				<DeleteConfirmDialog
					busy={busy}
					onCancel={() => setConfirmingDelete(false)}
					onConfirm={handleConfirmDelete}
				/>
			) : null}
		</section>
	);
}

/**
 * Confirmation dialog for the irreversible hard-delete action.
 * Wrapped in a `<dialog>` so the browser handles focus-trap +
 * Esc-to-cancel (see `useModalDialog`). Mandatory per the project
 * brief — no `window.confirm` is allowed since native popups can't
 * be themed and don't carry our i18n strings.
 */
function DeleteConfirmDialog({
	busy,
	onCancel,
	onConfirm,
}: {
	readonly busy: boolean;
	readonly onCancel: () => void;
	readonly onConfirm: () => void;
}) {
	const t = useTranslations("notes.deleteDialog");
	const ref = useModalDialog(onCancel);
	return (
		<dialog
			aria-label={t("region")}
			className="share-dialog delete-confirm-dialog"
			ref={ref}
		>
			<header className="share-dialog-header">
				<h2>{t("title")}</h2>
			</header>
			<div className="share-dialog-body">
				<p className="share-blurb">{t("blurb")}</p>
				<div className="delete-confirm-actions">
					<button
						className="auth-link"
						disabled={busy}
						onClick={onCancel}
						type="button"
					>
						{t("cancel")}
					</button>
					<button
						className="auth-cta auth-cta-compact auth-cta-danger"
						disabled={busy}
						onClick={onConfirm}
						type="button"
					>
						{t("confirm")}
					</button>
				</div>
			</div>
		</dialog>
	);
}
