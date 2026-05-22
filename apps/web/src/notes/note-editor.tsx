"use client";

import type { Note } from "@opfs/storage";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { useModalDialog } from "../share/use-modal-dialog";

import { NoteMarkdown } from "./markdown";

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
	// View mode picks between rendered-markdown ("preview") and the raw
	// textarea ("edit"). We default to "preview" when opening an existing
	// note — the PRD §Notes call for Markdown rendering — and to "edit"
	// for a brand-new note where there's nothing to render. The toolbar
	// exposes an explicit toggle button; the preview body itself is *not*
	// clickable. Two reasons:
	//   1. The preview contains flow content (h1, ul, p, a). HTML forbids
	//      a `<button>` from containing flow content or other interactive
	//      descendants — wrapping the preview in a button produced an
	//      invalid DOM and an inconsistent a11y tree across browsers
	//      (gemini, codex on PR #48).
	//   2. Markdown links inside the preview must navigate. With a
	//      clickable preview the link click bubbled to the wrapper and
	//      flipped into edit mode instead of following the link. An
	//      explicit toggle keeps the click target out of the body so
	//      links behave like links.
	// The textarea remains the source of truth for `draft.body` either
	// way; "preview" is render-only.
	const [mode, setMode] = useState<"preview" | "edit">(
		note ? "preview" : "edit",
	);
	const bodyRef = useRef<HTMLTextAreaElement | null>(null);
	// A ref guards against double-submission within the same tick;
	// React's `setBusy(true)` only disables the button on the next
	// render, so the second click of a rapid pair would otherwise
	// race past the disabled prop and produce a duplicate note.
	const inflight = useRef(false);

	// If the parent swaps the active note while we're open, sync.
	useEffect(() => {
		setDraft(fromNote(note));
		setError(null);
		setMode(note ? "preview" : "edit");
	}, [note]);

	// When the user opts into editing, drop them into the textarea so
	// they don't have to tap a second time to start typing.
	useEffect(() => {
		if (mode === "edit") bodyRef.current?.focus();
	}, [mode]);

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
	// On cancel, also clear any prior delete error so re-opening the
	// dialog starts clean. The error otherwise lingers until the next
	// successful run-guard cycle, which would surface a stale message
	// the moment the user re-opens the confirm prompt.
	const handleCancelDelete = () => {
		setConfirmingDelete(false);
		setError(null);
	};
	// Symmetric to `handleCancelDelete`: clear any prior error before
	// opening the dialog so a stale save/archive failure message isn't
	// re-rendered inside the modal (which would read as a delete error
	// the user never triggered). Without this, `error` carries through
	// from a failed previous action into the freshly-opened confirm.
	const handleOpenDelete = () => {
		setError(null);
		setConfirmingDelete(true);
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
				<div className="note-editor-bar-actions">
					<button
						aria-pressed={mode === "edit"}
						className="auth-link"
						disabled={busy}
						onClick={() =>
							setMode((m) => (m === "preview" ? "edit" : "preview"))
						}
						type="button"
					>
						{mode === "preview" ? t("editor.edit") : t("editor.preview")}
					</button>
					<button
						className="auth-cta auth-cta-compact"
						disabled={busy || !dirty}
						onClick={handleSave}
						type="button"
					>
						{t("editor.save")}
					</button>
				</div>
			</header>
			{error && !confirmingDelete ? (
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
			{mode === "preview" ? (
				// Plain region: no click handler, no role="button". The
				// preview is read-only flow content with real anchor tags
				// inside; entering edit mode happens via the explicit toggle
				// in the toolbar above. A `<section>` carries the label
				// (biome rejects aria-label on a bare div, since the role
				// isn't allowed labels). The empty-body case prints a hint
				// so the preview isn't a silent dead zone.
				<section
					aria-label={t("editor.bodyLabel")}
					className="note-editor-preview"
				>
					{draft.body.trim() ? (
						<div className="note-markdown">
							<NoteMarkdown source={draft.body} />
						</div>
					) : (
						<span className="note-editor-preview-empty">
							{t("editor.bodyPlaceholder")}
						</span>
					)}
				</section>
			) : (
				// No onBlur auto-flip: switching focus to the title input or
				// to another tab must not silently close the editor (gemini
				// on PR #48). The user returns to preview via the explicit
				// toggle in the toolbar, Save, or Cancel.
				<textarea
					aria-label={t("editor.bodyLabel")}
					className="note-editor-body"
					disabled={busy}
					onChange={(e) => setDraft((d) => ({ ...d, body: e.target.value }))}
					placeholder={t("editor.bodyPlaceholder")}
					ref={bodyRef}
					value={draft.body}
				/>
			)}
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
						onClick={handleOpenDelete}
						type="button"
					>
						{t("editor.delete")}
					</button>
				) : null}
			</div>
			{confirmingDelete && note && onDelete ? (
				<DeleteConfirmDialog
					busy={busy}
					error={error}
					onCancel={handleCancelDelete}
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
export function DeleteConfirmDialog({
	busy,
	error,
	onCancel,
	onConfirm,
}: {
	readonly busy: boolean;
	/**
	 * Last delete-failure message, or `null` if none. Rendered *inside*
	 * the dialog rather than the editor backdrop — the modal `<dialog>`
	 * obscures the editor, so an error painted behind it would be
	 * invisible and the user would only see the disabled-then-enabled
	 * confirm button with no explanation of why deletion failed.
	 */
	readonly error: string | null;
	readonly onCancel: () => void;
	/**
	 * Returns a `Promise` because the underlying handler awaits the
	 * store action; typing it as `void | Promise<void>` keeps callers
	 * honest without forcing every test fixture to be async.
	 */
	readonly onConfirm: () => void | Promise<void>;
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
				{error ? (
					<p className="auth-error" role="alert">
						{error}
					</p>
				) : null}
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
