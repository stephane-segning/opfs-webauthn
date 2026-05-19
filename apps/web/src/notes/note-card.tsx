"use client";

import type { Note } from "@opfs/storage";
import { useTranslations } from "next-intl";

import { formatDayBucket } from "./format-day";

const EXCERPT_LEN = 140;

function deriveTitle(note: Note, fallback: string): string {
	const trimmed = note.title.trim();
	if (trimmed) return trimmed;
	const firstLine = note.body.split("\n", 1)[0]?.trim();
	return firstLine || fallback;
}

function excerpt(note: Note): string {
	const body = note.body.trim();
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
	const title = deriveTitle(note, t("card.untitled"));
	return (
		<button className="note-card" onClick={() => onOpen(note)} type="button">
			<span className="note-card-title">{title}</span>
			<span className="note-card-excerpt">{excerpt(note)}</span>
			<span className="note-card-day">{formatDayBucket(note.updatedDay)}</span>
		</button>
	);
}
