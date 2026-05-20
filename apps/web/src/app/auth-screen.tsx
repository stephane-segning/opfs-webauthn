"use client";

import {
	AuthCeremonyError,
	AuthUnsupportedError,
	CredentialStoreUnavailableError,
	credentialStore,
	detectSupport,
	enroll,
	unlock,
	type VaultCredential,
} from "@opfs/auth";
import type { CryptoVault } from "@opfs/core-wasm";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import pkg from "../../package.json";
import { NotesShell } from "../notes/notes-shell";

const APP_VERSION = pkg.version;

type State =
	| { readonly kind: "loading" }
	| { readonly kind: "unsupported" }
	| { readonly kind: "fresh" }
	| { readonly kind: "locked"; readonly credential: VaultCredential }
	| { readonly kind: "busy"; readonly what: "enrolling" | "unlocking" }
	| {
			readonly kind: "unlocked";
			readonly vault: CryptoVault;
			readonly credential: VaultCredential;
	  }
	| {
			readonly kind: "error";
			readonly message: string;
			readonly retry: () => void;
	  };

function errorMessageFrom(err: unknown, fallback: string): string {
	if (err instanceof AuthUnsupportedError) return err.message;
	if (err instanceof AuthCeremonyError) return err.message;
	if (err instanceof Error) return err.message;
	return fallback;
}

export function AuthScreen() {
	const t = useTranslations();
	const [state, setState] = useState<State>({ kind: "loading" });

	// biome-ignore lint/correctness/useExhaustiveDependencies: `t` is stable per locale change; bootstrap is mount-only by design.
	useEffect(() => {
		const support = detectSupport();
		if (!support.webauthn) {
			setState({ kind: "unsupported" });
			return;
		}
		// Bootstrap is async because the store is OPFS-backed.
		// `cancelled` guards against StrictMode's double-mount and
		// unmount-during-read. The try/catch keeps the screen out
		// of a stuck `loading` state if the store throws — codex
		// caught that an unhandled rejection here would never reach
		// `setState`, leaving the spinner up forever.
		let cancelled = false;
		void (async () => {
			try {
				const stored = await credentialStore.get();
				if (cancelled) return;
				setState(
					stored ? { kind: "locked", credential: stored } : { kind: "fresh" },
				);
			} catch (err) {
				if (cancelled) return;
				// `CredentialStoreUnavailableError` means OPFS is missing
				// or blocked — the user could complete a passkey ceremony
				// but the resulting credential metadata could never be
				// persisted. That's effectively the same dead-end as "no
				// WebAuthn", so route it through the `unsupported` screen
				// rather than `fresh` (which would let them start a
				// ceremony that's guaranteed to fail at persist time).
				if (err instanceof CredentialStoreUnavailableError) {
					setState({ kind: "unsupported" });
					return;
				}
				setState({
					kind: "error",
					message: errorMessageFrom(err, t("auth.error.unknown")),
					retry: () => setState({ kind: "fresh" }),
				});
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	async function doEnroll() {
		setState({ kind: "busy", what: "enrolling" });
		let result: Awaited<ReturnType<typeof enroll>> | undefined;
		try {
			result = await enroll();
			// The wasm vault is `Send`-but-not-`Sync`-style: each handle
			// owns a chunk of the wasm heap that we have to release
			// explicitly. If `set()` rejects (OPFS write failure, quota,
			// runtime quirk), the vault has been generated but never
			// shown — we must free it here, otherwise every failed
			// enrollment leaks wasm heap. Codex caught it.
			await credentialStore.set(result.credential);
			setState({
				kind: "unlocked",
				vault: result.vault,
				credential: result.credential,
			});
		} catch (err) {
			if (result) result.vault.free();
			setState({
				kind: "error",
				message: errorMessageFrom(err, t("auth.error.unknown")),
				retry: () => setState({ kind: "fresh" }),
			});
		}
	}

	async function doUnlock(credential: VaultCredential) {
		setState({ kind: "busy", what: "unlocking" });
		try {
			const vault = await unlock({ credential });
			setState({ kind: "unlocked", vault, credential });
		} catch (err) {
			setState({
				kind: "error",
				message: errorMessageFrom(err, t("auth.error.unknown")),
				retry: () => setState({ kind: "locked", credential }),
			});
		}
	}

	function doLock() {
		if (state.kind !== "unlocked") return;
		state.vault.free();
		setState({ kind: "locked", credential: state.credential });
	}

	async function doForget() {
		// **Await** the clear before transitioning. Codex caught a
		// race: if `doForget` returned synchronously and the user
		// immediately tapped Enroll, the still-in-flight `clear()`
		// could land *after* `enroll()`'s `set()` and erase the
		// fresh credential. Serializing is the simple fix.
		//
		// Snapshot the credential for the retry path *before* freeing
		// the vault — if the clear fails, we want to drop the user
		// back to `locked` so the next reload doesn't surprise them
		// with a still-existing credential they thought was gone
		// (codex's point: the previous version set `fresh` from the
		// retry, which is a lie that reappears on reload).
		const snapshot =
			state.kind === "unlocked" || state.kind === "locked"
				? state.credential
				: undefined;
		if (state.kind === "unlocked") state.vault.free();
		setState({ kind: "busy", what: "enrolling" });
		try {
			await credentialStore.clear();
			setState({ kind: "fresh" });
		} catch (err) {
			setState({
				kind: "error",
				message: errorMessageFrom(err, t("auth.error.unknown")),
				// Drop back to `locked` so the UI matches the disk: the
				// credential is still there, the user can try Forget
				// again from the locked screen. If we have no snapshot
				// (bootstrap-time clear?) fall back to `fresh` — there's
				// nothing else to surface.
				retry: () =>
					setState(
						snapshot
							? { kind: "locked", credential: snapshot }
							: { kind: "fresh" },
					),
			});
		}
	}

	if (state.kind === "unlocked") {
		return <NotesShell onLock={doLock} vault={state.vault} />;
	}

	return (
		<main className="auth-screen">
			<section aria-live="polite" className="auth-card">
				<header>
					<p className="auth-tag">
						{t("app.name")} · v{APP_VERSION}
					</p>
					<h1>{titleFor(state, t)}</h1>
					<p className="auth-blurb">{blurbFor(state, t)}</p>
				</header>
				{actionsFor(state, t, { doEnroll, doUnlock, doLock, doForget })}
			</section>
		</main>
	);
}

type T = ReturnType<typeof useTranslations>;

function titleFor(state: State, t: T): string {
	switch (state.kind) {
		case "loading":
			return t("auth.loading.title");
		case "unsupported":
			return t("auth.unsupported.title");
		case "fresh":
			return t("auth.fresh.title");
		case "locked":
			return t("auth.locked.title");
		case "busy":
			return t(
				state.what === "enrolling"
					? "auth.busy.enrollingTitle"
					: "auth.busy.unlockingTitle",
			);
		case "unlocked":
			return t("auth.unlocked.title");
		case "error":
			return t("auth.error.title");
	}
}

function blurbFor(state: State, t: T): string {
	switch (state.kind) {
		case "loading":
			return t("auth.loading.blurb");
		case "unsupported":
			return t("auth.unsupportedReason");
		case "fresh":
			return t("auth.fresh.blurb");
		case "locked":
			return t("auth.locked.blurb");
		case "busy":
			return t("auth.busy.blurb");
		case "unlocked":
			return t("auth.unlocked.blurb");
		case "error":
			return state.message;
	}
}

function actionsFor(
	state: State,
	t: T,
	actions: {
		doEnroll: () => void;
		doUnlock: (credential: VaultCredential) => void;
		doLock: () => void;
		doForget: () => void;
	},
): React.ReactNode {
	switch (state.kind) {
		case "loading":
			return (
				<div
					aria-label={t("auth.loading.spinnerLabel")}
					className="auth-spinner"
					role="status"
				/>
			);
		case "unsupported":
			return <p className="auth-foot">{t("auth.unsupportedFallback")}</p>;
		case "fresh":
			return (
				<>
					<button className="auth-cta" onClick={actions.doEnroll} type="button">
						{t("auth.fresh.create")}
					</button>
					<p className="auth-foot">{t("auth.fresh.foot")}</p>
				</>
			);
		case "locked":
			return (
				<>
					<button
						className="auth-cta"
						onClick={() => actions.doUnlock(state.credential)}
						type="button"
					>
						{t("auth.locked.unlock")}
					</button>
					<button
						className="auth-link"
						onClick={actions.doForget}
						type="button"
					>
						{t("auth.locked.forget")}
					</button>
				</>
			);
		case "busy":
			return (
				<button className="auth-cta" disabled type="button">
					<span aria-hidden="true" className="auth-spinner-inline" />
					{t(
						state.what === "enrolling"
							? "auth.busy.enrollingLabel"
							: "auth.busy.unlockingLabel",
					)}
				</button>
			);
		case "unlocked":
			return (
				<>
					<button className="auth-cta" onClick={actions.doLock} type="button">
						{t("auth.unlocked.lock")}
					</button>
					<button
						className="auth-link"
						onClick={actions.doForget}
						type="button"
					>
						{t("auth.locked.forget")}
					</button>
				</>
			);
		case "error":
			return (
				<>
					<p className="auth-error" role="alert">
						{state.message}
					</p>
					<button className="auth-cta" onClick={state.retry} type="button">
						{t("auth.error.retry")}
					</button>
				</>
			);
	}
}
