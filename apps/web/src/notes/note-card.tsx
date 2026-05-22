"use client";

import type { Note } from "@opfs/storage";
import { useTranslations } from "next-intl";

import { formatDayBucket } from "./format-day";
import { stripMarkdown } from "./markdown";

const EXCERPT_LEN = 140;

function deriveTitle(note: Note, fallback: string): string {
	const trimmed = note.title.trim();
	if (trimmed) return trimmed;
	// Card titles read the *visible* first line, so strip markdown
	// syntax before picking it — a body that opens with "# Heading"
	// should surface "Heading" in the card, not the literal "#" marker.
	const firstLine = stripMarkdown(note.body.split("\n", 1)[0] ?? "");
	return firstLine || fallback;
}

function excerpt(note: Note): string {
	// Cards show one or two lines of text only — full markdown rendering
	// would be visual noise and would pay the unified/remark/rehype cost
	// per card. We strip markdown syntax to a plain string and truncate.
	const body = stripMarkdown(note.body);
	if (!body) return "";
	if (body.length <= EXCERPT_LEN) return body;
	return `${body.slice(0, EXCERPT_LEN).trimEnd()}…`;
}

export type NoteCardProps = {
	readonly note: Note;
	readonly onOpen: (note: Note) => void;
};

export function NoteCard({ note, onOpen }: NoteCardProps) {
	const t = useTranslations("notes");
	const title = deriveTitle(note, t("card.untitled")) || t("card.untitled");
	return (
		<button className="note-card" onClick={() => onOpen(note)} type="button">
			<span className="note-card-title">{title}</span>
			<span className="note-card-excerpt">{excerpt(note)}</span>
			<span className="note-card-day">{formatDayBucket(note.updatedDay)}</span>
		</button>
	);
}
