"use client";

import type { Note } from "@opfs/storage";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";

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
};

export function NoteEditor({
	note,
	onCancel,
	onSave,
	onArchive,
}: NoteEditorProps) {
	const t = useTranslations("notes");
	const [draft, setDraft] = useState<Draft>(fromNote(note));
	const [busy, setBusy] = useState(false);

	// If the parent swaps the active note while we're open, sync.
	useEffect(() => {
		setDraft(fromNote(note));
	}, [note]);

	const dirty = note
		? draft.title !== note.title || draft.body !== note.body
		: draft.title.length > 0 || draft.body.length > 0;

	async function handleSave() {
		setBusy(true);
		try {
			await onSave(draft);
		} finally {
			setBusy(false);
		}
	}

	async function handleArchive() {
		if (!note || !onArchive) return;
		setBusy(true);
		try {
			await onArchive(note.id);
		} finally {
			setBusy(false);
		}
	}

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
		</section>
	);
}
