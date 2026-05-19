"use client";

import {
	normalizeCode,
	type RendezvousClient,
	sendShare,
} from "@opfs/share-client";
import type { Note } from "@opfs/storage";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import { encodeSharedNote } from "./note-codec";
import { describeShareError } from "./receive-dialog";

type State =
	| { readonly status: "idle" }
	| { readonly status: "sending" }
	| { readonly status: "sent" }
	| { readonly status: "error"; readonly message: string };

export type SendShareDialogProps = {
	readonly client: RendezvousClient;
	readonly note: Note;
	readonly onClose: () => void;
};

export function SendShareDialog({
	client,
	note,
	onClose,
}: SendShareDialogProps) {
	const t = useTranslations("share");
	const [code, setCode] = useState("");
	const [state, setState] = useState<State>({ status: "idle" });
	// Submit guard — the same ref pattern used in the note editor,
	// prevents a double-tap rapid submit from racing past the disabled
	// button (which only flips on the next render).
	const inflight = useRef(false);

	const normalized = normalizeCode(code);
	const submittable = normalized !== null && state.status !== "sending";

	async function submit(): Promise<void> {
		if (!submittable || inflight.current) return;
		inflight.current = true;
		setState({ status: "sending" });
		try {
			const payload = encodeSharedNote({ title: note.title, body: note.body });
			await sendShare(client, normalized as string, payload);
			setState({ status: "sent" });
		} catch (err) {
			setState({ status: "error", message: describeShareError(err, t) });
		} finally {
			inflight.current = false;
		}
	}

	return (
		<dialog className="share-dialog" open>
			<header className="share-dialog-header">
				<h2>{t("send.title")}</h2>
				<button className="auth-link" onClick={onClose} type="button">
					{t("dialog.close")}
				</button>
			</header>
			<div className="share-dialog-body">
				{state.status === "sent" ? (
					<p className="share-blurb" role="status">
						{t("send.sent")}
					</p>
				) : (
					<>
						<p className="share-blurb">{t("send.askCode")}</p>
						<input
							aria-label={t("send.codeLabel")}
							autoCapitalize="characters"
							autoComplete="off"
							autoCorrect="off"
							className="share-code-input"
							disabled={state.status === "sending"}
							inputMode="text"
							maxLength={32}
							onChange={(e) => setCode(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter" && submittable) void submit();
							}}
							placeholder="ABCD-EFGH-JKMN"
							spellCheck={false}
							type="text"
							value={code}
						/>
						{state.status === "error" ? (
							<p className="auth-error" role="alert">
								{state.message}
							</p>
						) : null}
						<button
							className="auth-cta auth-cta-compact share-send-cta"
							disabled={!submittable}
							onClick={() => void submit()}
							type="button"
						>
							{state.status === "sending" ? t("send.sending") : t("send.cta")}
						</button>
					</>
				)}
			</div>
		</dialog>
	);
}
