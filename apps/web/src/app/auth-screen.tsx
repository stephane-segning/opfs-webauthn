"use client";

import {
	AuthCeremonyError,
	AuthUnsupportedError,
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

	useEffect(() => {
		const support = detectSupport();
		if (!support.webauthn) {
			setState({ kind: "unsupported" });
			return;
		}
		const stored = credentialStore.get();
		setState(
			stored ? { kind: "locked", credential: stored } : { kind: "fresh" },
		);
	}, []);

	async function doEnroll() {
		setState({ kind: "busy", what: "enrolling" });
		try {
			const result = await enroll();
			credentialStore.set(result.credential);
			setState({
				kind: "unlocked",
				vault: result.vault,
				credential: result.credential,
			});
		} catch (err) {
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

	function doForget() {
		credentialStore.clear();
		if (state.kind === "unlocked") state.vault.free();
		setState({ kind: "fresh" });
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
