"use client";

import type { Note } from "@opfs/storage";
import { useTranslations } from "next-intl";

import { NoteCard } from "./note-card";

export type NotesListProps = {
	readonly notes: readonly Note[];
	readonly onOpen: (note: Note) => void;
};

export function NotesList({ notes, onOpen }: NotesListProps) {
	const t = useTranslations("notes");
	if (notes.length === 0) {
		return (
			<div className="notes-empty" role="status">
				<p className="notes-empty-title">{t("empty.title")}</p>
				<p className="notes-empty-blurb">{t("empty.blurb")}</p>
			</div>
		);
	}
	return (
		<ul aria-label={t("list.region")} className="notes-list">
			{notes.map((note) => (
				<li key={note.id}>
					<NoteCard note={note} onOpen={onOpen} />
				</li>
			))}
		</ul>
	);
}
