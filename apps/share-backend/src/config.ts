/**
 * Tunable constants for the rendezvous backend. Kept in one file so
 * the trade-offs (TTL window vs. UX, blob cap vs. abuse) are
 * reviewable in one place rather than scattered.
 */

/** Default rendezvous lifetime (seconds). 5 minutes per ADR 0007. */
export const RENDEZVOUS_TTL_SECONDS = 300;

/**
 * Hard cap on the encrypted ShareBlob bytes. The plaintext side is a
 * single note (a few KB at most); 64 KiB is generous and well below
 * Cloudflare KV's 25 MiB value cap.
 */
export const MAX_BLOB_BYTES = 64 * 1024;

/**
 * Per-IP mint cap inside one TTL window. Generous enough for legit
 * retries, tight enough that a single host cannot brute-force the
 * 60-bit commitment space.
 */
export const MINT_RATE_LIMIT = 10;
