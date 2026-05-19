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
import { useEffect, useState } from "react";

import { version } from "../../package.json";

type State =
	| { readonly kind: "loading" }
	| { readonly kind: "unsupported"; readonly reason: string }
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

function errorMessage(err: unknown): string {
	if (err instanceof AuthUnsupportedError) return err.message;
	if (err instanceof AuthCeremonyError) return err.message;
	if (err instanceof Error) return err.message;
	return "Unknown error";
}

export function AuthScreen() {
	const [state, setState] = useState<State>({ kind: "loading" });

	useEffect(() => {
		const support = detectSupport();
		if (!support.webauthn) {
			setState({
				kind: "unsupported",
				reason:
					"This browser does not expose WebAuthn. Use a recent Chrome, Safari, Firefox, or Edge on a device with a built-in authenticator.",
			});
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
				message: errorMessage(err),
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
				message: errorMessage(err),
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
					<p className="auth-tag">opfs-webauthn · v{version}</p>
					<h1>{title(state)}</h1>
					<p className="auth-blurb">{blurb(state)}</p>
				</header>
				{renderActions(state, { doEnroll, doUnlock, doLock, doForget })}
			</section>
		</main>
	);
}

function title(state: State): string {
	switch (state.kind) {
		case "loading":
			return "Loading…";
		case "unsupported":
			return "Browser not supported";
		case "fresh":
			return "Your notes, locked to a passkey.";
		case "locked":
			return "Welcome back.";
		case "busy":
			return state.what === "enrolling" ? "Creating your vault…" : "Unlocking…";
		case "unlocked":
			return "Vault open.";
		case "error":
			return "Something went wrong";
	}
}

function blurb(state: State): string {
	switch (state.kind) {
		case "loading":
			return "Looking for an existing vault on this device.";
		case "unsupported":
			return state.reason;
		case "fresh":
			return "Everything stays on this device. The only way in is the passkey you create — no email, no password, no recovery codes.";
		case "locked":
			return "Tap to unlock with the passkey you enrolled on this device.";
		case "busy":
			return "Follow the prompt from your authenticator. This may take a few seconds.";
		case "unlocked":
			return "Notes UI lands in the next PR. For now this proves the WebAuthn PRF → wasm CryptoVault chain works end-to-end.";
		case "error":
			return state.message;
	}
}

function renderActions(
	state: State,
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
				<div aria-label="Loading" className="auth-spinner" role="status" />
			);
		case "unsupported":
			return <p className="auth-foot">No fallback is available.</p>;
		case "fresh":
			return (
				<>
					<button className="auth-cta" onClick={actions.doEnroll} type="button">
						Create encrypted vault
					</button>
					<p className="auth-foot">
						Lose every device with this passkey and the vault is unrecoverable —
						by design.
					</p>
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
						Unlock
					</button>
					<button
						className="auth-link"
						onClick={actions.doForget}
						type="button"
					>
						Forget vault on this device
					</button>
				</>
			);
		case "busy":
			return (
				<button className="auth-cta" disabled type="button">
					<span aria-hidden="true" className="auth-spinner-inline" />
					{state.what === "enrolling" ? "Creating vault…" : "Unlocking…"}
				</button>
			);
		case "unlocked":
			return (
				<>
					<button className="auth-cta" onClick={actions.doLock} type="button">
						Lock vault
					</button>
					<button
						className="auth-link"
						onClick={actions.doForget}
						type="button"
					>
						Forget vault on this device
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
						Try again
					</button>
				</>
			);
	}
}
