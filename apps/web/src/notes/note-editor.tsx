"use client";

import type { Note } from "@opfs/storage";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

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
	onShare,
}: NoteEditorProps) {
	const t = useTranslations("notes");
	const [draft, setDraft] = useState<Draft>(fromNote(note));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// View mode picks between rendered-markdown ("preview") and the raw
	// textarea ("edit"). We default to "preview" when opening an existing
	// note — the PRD §Notes call for Markdown rendering — and to "edit"
	// for a brand-new note where there's nothing to render. Tapping the
	// preview switches to "edit"; this is the simpler UX that fits the
	// existing single-column shape (a side-by-side split would crowd the
	// 36rem max-width body on mobile, which is the primary form factor).
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
			{mode === "preview" ? (
				// Whole region is a button so keyboard users get the same
				// "tap to edit" affordance as a mouse user clicking the text.
				// The empty-body case prints a hint so the preview isn't a
				// silent dead zone.
				<button
					aria-label={t("editor.editBody")}
					className="note-editor-preview"
					disabled={busy}
					onClick={() => setMode("edit")}
					type="button"
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
				</button>
			) : (
				<textarea
					aria-label={t("editor.bodyLabel")}
					className="note-editor-body"
					disabled={busy}
					onBlur={() => {
						// Returning to preview on blur only makes sense for an
						// existing note — for a fresh draft the preview would be
						// empty until the first save, defeating the point.
						if (note) setMode("preview");
					}}
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
			</div>
		</section>
	);
}
