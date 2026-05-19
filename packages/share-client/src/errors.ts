/**
 * Typed errors for the page-side share flow. Splitting them out lets
 * the UI render targeted messages (expired vs. wrong-code vs. network
 * failure) without sniffing strings.
 */

export type ShareErrorKind =
	| "network"
	| "rendezvousNotFound"
	| "rendezvousExpired"
	| "commitmentMismatch"
	| "blobAlreadyUploaded"
	| "blobUnavailable"
	| "rateLimited"
	| "originDenied"
	| "protocol";

export class ShareError extends Error {
	readonly kind: ShareErrorKind;
	readonly status?: number;
	constructor(kind: ShareErrorKind, message: string, status?: number) {
		super(message);
		this.kind = kind;
		this.status = status;
	}
}

/** Map a backend HTTP status to a typed `ShareError`. */
export function shareErrorForStatus(
	status: number,
	context: "fetchRendezvous" | "uploadBlob" | "downloadBlob" | "mint",
): ShareError {
	switch (status) {
		case 403:
			return new ShareError(
				"originDenied",
				"share backend rejected this origin",
				status,
			);
		case 404:
			if (context === "downloadBlob") {
				return new ShareError("blobUnavailable", "blob unavailable", status);
			}
			// `fetchRendezvous` and `uploadBlob` both 404 when the
			// rendezvous code itself is unknown to the backend, so the
			// shared classification gives the UI a single recovery path
			// ("retype the code") instead of a confusing blob-state error.
			return new ShareError("rendezvousNotFound", "no such rendezvous", status);
		case 409:
			return new ShareError(
				"blobAlreadyUploaded",
				"a blob is already staged at this code",
				status,
			);
		case 410:
			return new ShareError("rendezvousExpired", "rendezvous expired", status);
		case 429:
			return new ShareError(
				"rateLimited",
				"share backend rate limit reached",
				status,
			);
		default:
			return new ShareError(
				"protocol",
				`share backend returned ${status}`,
				status,
			);
	}
}
