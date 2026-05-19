"use client";

import {
	pollAndDecrypt,
	prepareReceive,
	type RecipientSession,
	type RendezvousClient,
	ShareError,
} from "@opfs/share-client";
import type { Note, Repo } from "@opfs/storage";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { formatCodeForDisplay } from "./format-code";
import { decodeSharedNote } from "./note-codec";
import { useModalDialog } from "./use-modal-dialog";

/**
 * Each render of `ReceiveShareDialog` walks through this state
 * machine. Keeping it as a discriminated union means the JSX can
 * exhaustively branch and the editor only ever observes one
 * coherent shape.
 */
type State =
	| { readonly status: "minting" }
	| { readonly status: "waiting"; readonly session: RecipientSession }
	| { readonly status: "received" }
	| { readonly status: "error"; readonly message: string };

export type ReceiveShareDialogProps = {
	readonly client: RendezvousClient;
	readonly repo: Repo;
	readonly onClose: () => void;
	readonly onReceived: (note: Note) => void;
};

export function ReceiveShareDialog({
	client,
	repo,
	onClose,
	onReceived,
}: ReceiveShareDialogProps) {
	const t = useTranslations("share");
	const dialogRef = useModalDialog(onClose);
	const [state, setState] = useState<State>({ status: "minting" });
	// Stash the latest props in refs so the mount-only effect can
	// read them without re-running on every parent render. Re-running
	// would re-mint a rendezvous and burn the per-IP rate-limit budget.
	const clientRef = useRef(client);
	const repoRef = useRef(repo);
	const onReceivedRef = useRef(onReceived);
	const tRef = useRef(t);
	clientRef.current = client;
	repoRef.current = repo;
	onReceivedRef.current = onReceived;
	tRef.current = t;

	useEffect(() => {
		const controller = new AbortController();
		let active = true;

		void (async () => {
			try {
				const session = await prepareReceive(clientRef.current, {
					signal: controller.signal,
				});
				if (!active) {
					session.handle.free();
					return;
				}
				setState({ status: "waiting", session });
				const plaintext = await pollAndDecrypt(clientRef.current, session, {
					signal: controller.signal,
				});
				if (!active) return;
				const sharedNote = decodeSharedNote(plaintext);
				const saved = await repoRef.current.upsertNote(sharedNote);
				if (!active) return;
				setState({ status: "received" });
				onReceivedRef.current(saved);
			} catch (err) {
				if (!active) return;
				setState({
					status: "error",
					message: describeShareError(err, tRef.current),
				});
			}
		})();

		return () => {
			active = false;
			controller.abort();
		};
	}, []);

	return (
		<dialog className="share-dialog" ref={dialogRef}>
			<header className="share-dialog-header">
				<h2>{t("receive.title")}</h2>
				<button className="auth-link" onClick={onClose} type="button">
					{t("dialog.close")}
				</button>
			</header>
			<div className="share-dialog-body">
				<ReceiveBody state={state} t={t} />
			</div>
		</dialog>
	);
}

function ReceiveBody({
	state,
	t,
}: {
	readonly state: State;
	readonly t: ReturnType<typeof useTranslations>;
}) {
	if (state.status === "minting") {
		return (
			<p className="share-blurb" role="status">
				{t("receive.minting")}
			</p>
		);
	}
	if (state.status === "waiting") {
		return (
			<>
				<p className="share-blurb">{t("receive.readAloud")}</p>
				<output aria-label={t("receive.codeLabel")} className="share-code">
					{formatCodeForDisplay(state.session.code)}
				</output>
				<p className="share-foot">{t("receive.waiting")}</p>
			</>
		);
	}
	if (state.status === "received") {
		return (
			<p className="share-blurb" role="status">
				{t("receive.received")}
			</p>
		);
	}
	return (
		<p className="auth-error" role="alert">
			{state.message}
		</p>
	);
}

/**
 * Map a `ShareError.kind` to a localized human string. Kept here
 * (next to the dialog that surfaces them) rather than in the shared
 * library so the i18n catalog and the kind enum can evolve together.
 */
export function describeShareError(
	err: unknown,
	t: ReturnType<typeof useTranslations>,
): string {
	if (err instanceof ShareError) {
		switch (err.kind) {
			case "network":
				return t("error.network");
			case "rendezvousNotFound":
				return t("error.rendezvousNotFound");
			case "rendezvousExpired":
				return t("error.rendezvousExpired");
			case "commitmentMismatch":
				return t("error.commitmentMismatch");
			case "blobAlreadyUploaded":
				return t("error.blobAlreadyUploaded");
			case "blobUnavailable":
				return t("error.blobUnavailable");
			case "rateLimited":
				return t("error.rateLimited");
			case "originDenied":
				return t("error.originDenied");
			case "protocol":
				return t("error.protocol");
		}
	}
	return err instanceof Error ? err.message : String(err);
}
