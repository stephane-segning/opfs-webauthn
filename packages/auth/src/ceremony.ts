import init, { CryptoVault } from "@opfs/core-wasm";
import type { EnrollOptions, UnlockOptions, VaultCredential } from "./types.js";
import { AuthCeremonyError, AuthUnsupportedError } from "./types.js";

const PRF_SALT_LEN = 32;
const USER_HANDLE_LEN = 16;
const CHALLENGE_LEN = 32;

const PUBKEY_CRED_PARAMS: PublicKeyCredentialParameters[] = [
	{ type: "public-key", alg: -7 }, // ES256
	{ type: "public-key", alg: -257 }, // RS256
];

/**
 * Allocate a Uint8Array backed by an `ArrayBuffer` (not the generic
 * `ArrayBufferLike`) so it satisfies the DOM `BufferSource` type that
 * the WebAuthn APIs ask for. Built-in `new Uint8Array(n)` widens to
 * `Uint8Array<ArrayBufferLike>` in TS 5.7+.
 */
function randomBytes(length: number): Uint8Array<ArrayBuffer> {
	const buf = new Uint8Array(new ArrayBuffer(length));
	crypto.getRandomValues(buf);
	return buf;
}

function rpId(opts: EnrollOptions | undefined): string {
	if (opts?.rpId) return opts.rpId;
	if (typeof location !== "undefined") return location.hostname || "localhost";
	throw new AuthCeremonyError("rpId must be supplied when running off the web");
}

function readPrfResult(
	credential: PublicKeyCredential,
): Uint8Array | undefined {
	const ext = credential.getClientExtensionResults() as {
		prf?: { results?: { first?: ArrayBuffer } };
	};
	const first = ext.prf?.results?.first;
	return first ? new Uint8Array(first) : undefined;
}

/**
 * Enroll a fresh vault. Drives a `navigator.credentials.create` with
 * the PRF extension, then constructs a `CryptoVault` inside the wasm
 * module. Falls back to a second `get()` ceremony only if the
 * authenticator does not return `prf.results.first` on `create` — see
 * the "Inspect the `create` response for PRF output first" note in
 * ADR 0005.
 *
 * Returns the open vault plus a serialisable `VaultCredential`
 * blob to persist alongside the encrypted notes DB.
 */
export async function enroll(options?: EnrollOptions): Promise<{
	readonly vault: CryptoVault;
	readonly credential: VaultCredential;
}> {
	if (typeof navigator === "undefined" || !navigator.credentials) {
		throw new AuthUnsupportedError(
			"WebAuthn is not available in this environment",
		);
	}

	const prfSalt = randomBytes(PRF_SALT_LEN);
	// `Uint8Array<ArrayBufferLike>` -> `BufferSource` widening; the
	// underlying buffer is an ArrayBuffer at runtime in every case
	// we feed (`randomBytes` produces an explicit ArrayBuffer, caller
	// inputs likewise come from `getRandomValues` in practice).
	const userHandle = (options?.userHandle ??
		randomBytes(USER_HANDLE_LEN)) as BufferSource;
	const challenge = randomBytes(CHALLENGE_LEN);
	const userName = options?.userName ?? "vault";

	const credential = (await navigator.credentials.create({
		publicKey: {
			rp: { name: "opfs-webauthn", id: rpId(options) },
			user: { id: userHandle, name: userName, displayName: userName },
			challenge,
			pubKeyCredParams: PUBKEY_CRED_PARAMS,
			authenticatorSelection: {
				residentKey: "required",
				userVerification: "required",
			},
			extensions: {
				prf: { eval: { first: prfSalt } },
			} as AuthenticationExtensionsClientInputs,
		},
	})) as PublicKeyCredential | null;
	if (!credential) {
		throw new AuthCeremonyError("passkey creation was cancelled");
	}

	let prfOutput = readPrfResult(credential);
	if (!prfOutput) {
		// Older authenticators don't return PRF on `create`; immediately
		// follow with a `get()` that supplies the same eval salt. See
		// ADR 0005 "Inspect the `create` response for PRF output first".
		const assertion = (await navigator.credentials.get({
			publicKey: {
				challenge: randomBytes(CHALLENGE_LEN),
				allowCredentials: [{ type: "public-key", id: credential.rawId }],
				userVerification: "required",
				extensions: {
					prf: { eval: { first: prfSalt } },
				} as AuthenticationExtensionsClientInputs,
			},
		})) as PublicKeyCredential | null;
		if (!assertion) {
			throw new AuthCeremonyError(
				"passkey created but follow-up PRF assertion was cancelled",
			);
		}
		prfOutput = readPrfResult(assertion);
	}
	if (!prfOutput) {
		throw new AuthUnsupportedError(
			"this authenticator does not implement the WebAuthn PRF extension",
		);
	}

	await init();
	const enrollResult = CryptoVault.enroll(prfOutput, prfSalt);
	const persisted: VaultCredential = {
		credentialId: new Uint8Array(credential.rawId),
		prfSalt,
		wrappedDek: enrollResult.wrappedDek,
		wrapNonce: enrollResult.wrapNonce,
		createdAt: Date.now(),
	};
	const vault = enrollResult.takeVault();
	return { vault, credential: persisted };
}

/**
 * Unlock an existing vault. Drives `navigator.credentials.get` with
 * the persisted credential id and PRF salt, then unwraps the DEK
 * inside wasm. Throws `AuthCeremonyError` on cancellation,
 * `AuthUnsupportedError` if PRF data is missing from the assertion.
 */
export async function unlock({
	credential,
}: UnlockOptions): Promise<CryptoVault> {
	if (typeof navigator === "undefined" || !navigator.credentials) {
		throw new AuthUnsupportedError(
			"WebAuthn is not available in this environment",
		);
	}

	const challenge = randomBytes(CHALLENGE_LEN);
	const assertion = (await navigator.credentials.get({
		publicKey: {
			challenge,
			allowCredentials: [
				{ type: "public-key", id: credential.credentialId as BufferSource },
			],
			userVerification: "required",
			extensions: {
				prf: { eval: { first: credential.prfSalt } },
			} as AuthenticationExtensionsClientInputs,
		},
	})) as PublicKeyCredential | null;
	if (!assertion) {
		throw new AuthCeremonyError("vault unlock was cancelled");
	}
	const prfOutput = readPrfResult(assertion);
	if (!prfOutput) {
		throw new AuthUnsupportedError(
			"authenticator did not return a PRF result — vault cannot be unlocked",
		);
	}

	await init();
	return CryptoVault.unlock(
		prfOutput,
		credential.prfSalt,
		credential.wrappedDek,
		credential.wrapNonce,
	);
}
