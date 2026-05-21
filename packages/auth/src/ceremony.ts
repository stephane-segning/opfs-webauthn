import init, { CryptoVault } from "@opfs/core-wasm";
import type { EnrollOptions, UnlockOptions, VaultCredential } from "./types.js";
import { AuthCeremonyError, AuthUnsupportedError } from "./types.js";

const PRF_SALT_LEN = 32;
const USER_HANDLE_LEN = 16;
const CHALLENGE_LEN = 32;
/**
 * Hard upper bound on a WebAuthn ceremony. Without `timeout`, an
 * authenticator dialog that never appears (Linux without a security
 * key, macOS Settings biometrics off, etc.) leaves the page in an
 * unrecoverable "busy" state. 60 s is long enough for a human to
 * comfortably authenticate, short enough that a stuck flow surfaces
 * as a typed `AuthCeremonyError` (`NotAllowedError`) instead of a
 * spinner the user can only escape by reloading.
 */
const CEREMONY_TIMEOUT_MS = 60_000;

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

function resolveRpId(rpId: string | undefined): string {
	if (rpId) return rpId;
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
 * Wrap `navigator.credentials.{create,get}` so the user-cancellation
 * path (a `DOMException` with name `"NotAllowedError"`) becomes an
 * `AuthCeremonyError` and any other DOMException becomes the same so
 * UI code can branch on a single error class. Non-DOMException
 * errors (e.g. our own `AuthUnsupportedError`) pass through.
 */
async function runCeremony<T>(
	what: "passkey creation" | "passkey assertion",
	fn: () => Promise<T>,
): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		if (err instanceof DOMException) {
			throw new AuthCeremonyError(
				`${what} failed: ${err.name} — ${err.message}`,
			);
		}
		throw err;
	}
}

/**
 * Enroll a fresh vault. Drives a `navigator.credentials.create` with
 * the PRF extension, then constructs a `CryptoVault` inside the wasm
 * module. Falls back to a second `get()` ceremony only if the
 * authenticator does not return `prf.results.first` on `create` — see
 * the "Inspect the `create` response for PRF output first" note in
 * ADR 0005.
 *
 * Returns the open vault plus a serialisable `VaultCredential` blob
 * to persist alongside the encrypted notes DB.
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

	// Initialise wasm before the ceremony so the .wasm fetch is visible
	// in DevTools the moment the user clicks Enroll, and a missing /
	// corrupt artifact surfaces as a typed error before we burn the
	// user's biometric on a flow that would have failed anyway.
	await init();

	const prfSalt = randomBytes(PRF_SALT_LEN);
	// `Uint8Array<ArrayBufferLike>` -> `BufferSource` widening; the
	// underlying buffer is an ArrayBuffer at runtime in every case we
	// feed.
	const userHandle = (options?.userHandle ??
		randomBytes(USER_HANDLE_LEN)) as BufferSource;
	const challenge = randomBytes(CHALLENGE_LEN);
	const userName = options?.userName ?? "vault";
	const rpId = resolveRpId(options?.rpId);

	const requestedAttachment = options?.authenticatorAttachment;
	const authenticatorSelection: AuthenticatorSelectionCriteria = {
		residentKey: "required",
		userVerification: "required",
		// Only include the field when the caller explicitly opts in.
		// Setting it to `undefined` is functionally identical to
		// omitting it for the browser, but tools that snapshot the
		// `PublicKeyCredentialCreationOptions` for debugging look
		// nicer without the noise.
		...(requestedAttachment
			? { authenticatorAttachment: requestedAttachment }
			: {}),
	};

	const credential = (await runCeremony("passkey creation", () =>
		navigator.credentials.create({
			publicKey: {
				rp: { name: "opfs-webauthn", id: rpId },
				user: { id: userHandle, name: userName, displayName: userName },
				challenge,
				pubKeyCredParams: PUBKEY_CRED_PARAMS,
				authenticatorSelection,
				timeout: CEREMONY_TIMEOUT_MS,
				extensions: {
					prf: { eval: { first: prfSalt } },
				} as AuthenticationExtensionsClientInputs,
			},
		}),
	)) as PublicKeyCredential | null;
	if (!credential) {
		throw new AuthCeremonyError("passkey creation returned no credential");
	}

	// Enforce the requested attachment after the fact. The
	// `authenticatorSelection.authenticatorAttachment` hint above is
	// best-effort — some browsers surface cross-platform options
	// regardless. The credential carries its actual attachment in
	// `authenticatorAttachment`; if the user enrolled with something
	// the caller said no to, reject the credential rather than wrap
	// data with a key the user doesn't expect to be where it is.
	//
	// **Reject on unknown too.** Some browsers / authenticators omit
	// `authenticatorAttachment` from the credential entirely
	// (returns `null` or undefined). If the caller asked for a
	// specific attachment, we can't verify the actual one is what
	// they wanted — fail closed, because the alternative is silently
	// accepting a cross-platform credential when the app explicitly
	// asked for platform-only.
	if (requestedAttachment) {
		const actual = credential.authenticatorAttachment;
		if (!actual) {
			throw new AuthUnsupportedError(
				`enrollment requested authenticator attachment "${requestedAttachment}" ` +
					"but the browser did not report the credential's actual attachment; " +
					"unable to verify the request was honoured",
			);
		}
		if (actual !== requestedAttachment) {
			throw new AuthUnsupportedError(
				`enrollment requested authenticator attachment "${requestedAttachment}" ` +
					`but the user picked "${actual}"`,
			);
		}
	}

	let prfOutput = readPrfResult(credential);
	if (!prfOutput) {
		// Older authenticators don't return PRF on `create`; immediately
		// follow with a `get()` that supplies the same eval salt. See
		// ADR 0005 "Inspect the `create` response for PRF output first".
		const assertion = (await runCeremony("passkey assertion", () =>
			navigator.credentials.get({
				publicKey: {
					challenge: randomBytes(CHALLENGE_LEN),
					rpId,
					allowCredentials: [{ type: "public-key", id: credential.rawId }],
					userVerification: "required",
					timeout: CEREMONY_TIMEOUT_MS,
					extensions: {
						prf: { eval: { first: prfSalt } },
					} as AuthenticationExtensionsClientInputs,
				},
			}),
		)) as PublicKeyCredential | null;
		if (!assertion) {
			throw new AuthCeremonyError(
				"passkey created but follow-up PRF assertion returned nothing",
			);
		}
		prfOutput = readPrfResult(assertion);
	}
	if (!prfOutput) {
		throw new AuthUnsupportedError(
			"this authenticator does not implement the WebAuthn PRF extension",
		);
	}

	// `init()` already ran at the head of this function; calling it
	// twice is idempotent — the wasm-bindgen entry returns the cached
	// module on every call past the first.
	const enrollResult = CryptoVault.enroll(prfOutput, prfSalt);
	try {
		const persisted: VaultCredential = {
			credentialId: new Uint8Array(credential.rawId),
			prfSalt,
			wrappedDek: enrollResult.wrappedDek,
			wrapNonce: enrollResult.wrapNonce,
			rpId,
			createdAt: Date.now(),
		};
		const vault = enrollResult.takeVault();
		return { vault, credential: persisted };
	} finally {
		// `EnrollResult` holds wasm-heap memory; release it once we have
		// the persisted blob + the vault. The vault is its own handle
		// and stays alive.
		enrollResult.free();
	}
}

/**
 * Unlock an existing vault. Drives `navigator.credentials.get` with
 * the persisted credential id, rpId, and PRF salt, then unwraps the
 * DEK inside wasm. Throws `AuthCeremonyError` on cancellation,
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

	// See the matching note in `enroll` — init first so wasm-load
	// failure surfaces before the WebAuthn ceremony.
	await init();

	const challenge = randomBytes(CHALLENGE_LEN);
	const assertion = (await runCeremony("passkey assertion", () =>
		navigator.credentials.get({
			publicKey: {
				challenge,
				rpId: credential.rpId,
				allowCredentials: [
					{ type: "public-key", id: credential.credentialId as BufferSource },
				],
				userVerification: "required",
				timeout: CEREMONY_TIMEOUT_MS,
				extensions: {
					prf: { eval: { first: credential.prfSalt } },
				} as AuthenticationExtensionsClientInputs,
			},
		}),
	)) as PublicKeyCredential | null;
	if (!assertion) {
		throw new AuthCeremonyError("vault unlock returned no assertion");
	}
	const prfOutput = readPrfResult(assertion);
	if (!prfOutput) {
		throw new AuthUnsupportedError(
			"authenticator did not return a PRF result — vault cannot be unlocked",
		);
	}

	return CryptoVault.unlock(
		prfOutput,
		credential.prfSalt,
		credential.wrappedDek,
		credential.wrapNonce,
	);
}
