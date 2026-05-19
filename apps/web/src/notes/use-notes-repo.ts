"use client";

import type { CryptoVault } from "@opfs/core-wasm";
import { createRepo, type Repo } from "@opfs/storage";
import { useEffect, useState } from "react";

/**
 * Mount the `Repo` for a given `CryptoVault`, tear it down when the
 * vault changes or the consumer unmounts. The vault parameter is the
 * single source of truth — pass `null` while locked and the hook
 * cleans up.
 *
 * Single responsibility: lifecycle. `useNotes` reads from the repo;
 * components compose both.
 */
export type RepoState =
	| { readonly status: "idle" }
	| { readonly status: "loading" }
	| { readonly status: "ready"; readonly repo: Repo }
	| { readonly status: "error"; readonly error: Error };

export function useNotesRepo(vault: CryptoVault | null): RepoState {
	const [state, setState] = useState<RepoState>({ status: "idle" });

	useEffect(() => {
		if (!vault) {
			setState({ status: "idle" });
			return;
		}
		let cancelled = false;
		let attached: Repo | null = null;
		setState({ status: "loading" });
		createRepo({ vault })
			.then((repo) => {
				if (cancelled) {
					repo.close().catch(() => {});
					return;
				}
				attached = repo;
				setState({ status: "ready", repo });
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setState({
					status: "error",
					error: err instanceof Error ? err : new Error(String(err)),
				});
			});
		return () => {
			cancelled = true;
			attached?.close().catch(() => {});
		};
	}, [vault]);

	return state;
}
