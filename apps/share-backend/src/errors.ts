/**
 * Typed HTTP errors. Handlers throw; the router turns them into
 * `Response` objects with consistent shape. Keeps the happy path in
 * each handler linear and the error mapping in one place.
 */

export class HttpError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

export const badRequest = (msg: string): HttpError => new HttpError(400, msg);
export const notFound = (msg = "not found"): HttpError =>
	new HttpError(404, msg);
export const conflict = (msg: string): HttpError => new HttpError(409, msg);
export const gone = (msg = "expired"): HttpError => new HttpError(410, msg);
export const payloadTooLarge = (msg: string): HttpError =>
	new HttpError(413, msg);
export const tooManyRequests = (msg = "rate limited"): HttpError =>
	new HttpError(429, msg);
