# ADR 0007 — Deployment & sharing backend

- **Status**: Accepted
- **Date**: 2026-05-19

## Context

We commit to deploying the app on GitHub Pages, which only serves static
files. The product needs a small backend for the cross-device share flow,
which cannot live on Pages. We also use Next.js, which by default expects
a Node runtime. We must reconcile these.

## Decision

### Frontend on GitHub Pages

- `apps/web` is configured for **Next.js static export** (`output:
  'export'`). All dynamic data lives in the client (OPFS, WASM, Zustand).
- A GitHub Actions workflow on push to `main`:
  1. Builds the WASM bundle (`wasm-pack build` via Turbo).
  2. Builds `apps/web` (`next build` with static export).
  3. Publishes the `out/` directory to the `gh-pages` branch.
- Asset paths use the repo's basePath so the same build works whether
  served from a project page or a custom domain later.

### Sharing backend, deployed separately

- `apps/share-backend` is a **Cloudflare Workers** project (TypeScript,
  `wrangler` for local + deploy). Cloudflare's free tier covers the
  expected research traffic, has KV / R2 for the encrypted-blob staging,
  and global edge presence.
- The flow is **recipient-first**, so we never need a global, queryable
  pubkey directory the sender browses by identity. There is no "look up
  someone else's key by handle." A share session is a short-lived
  rendezvous identified by an opaque code that the human user transfers
  out of band (read it off the recipient screen onto the sender screen).
- **The threat model treats the backend as untrusted.** We assume a
  hostile relay can read, replay, and substitute any value it sees.
  Confidentiality must come from cryptographic structure, not from the
  server behaving honestly.
- **The pickup code is a commitment, not a lookup key.** The recipient
  generates an ephemeral X25519 keypair and derives the code as
  `base32(truncate(BLAKE3(epk), 60 bits))` (12 base32 chars, displayed
  as two groups of six to make it easier to read aloud). When the
  sender fetches the ephemeral pubkey by code, it **re-derives the
  code from the fetched pubkey** and refuses to proceed if the two do
  not match. A malicious backend cannot substitute its own pubkey
  without also producing the matching truncation, which is a 60-bit
  pre-image problem behind a rate-limited endpoint with a 5-minute
  TTL. We sized at 60 bits — not 40 — because BLAKE3 is fast enough on
  modern hardware that a 2^40 search is feasible inside the TTL for
  a motivated attacker; 2^60 is not.
- **No server-side authentication on `POST /rendezvous`.** We
  considered requiring a WebAuthn assertion on the recipient request,
  but the backend has no registered credential public keys to verify
  against (this is by design — there are no accounts). Authenticating
  blindly would only prove "some passkey signed this", which the
  backend cannot tie to anyone meaningful. We therefore drop that
  check. Abuse prevention falls back to per-IP rate limits, short
  TTLs, and the cost of cracking the 60-bit commitment within the TTL.
- Endpoints (sketch, finalized in a later ADR):
  - `POST /rendezvous` — recipient posts its ephemeral X25519 public
    key. The worker computes `code = base32(truncate(BLAKE3(epk), 60))`,
    rejects collisions inside the TTL window, and stores
    `{code, ephemeralPubkey, expiresAt}` in KV.
  - `GET /rendezvous/:code` — sender fetches the ephemeral pubkey by
    code. **The sender verifies `code == base32(truncate(BLAKE3(epk),
    60))` locally before doing anything else.** It then derives a
    shared secret (HPKE-X25519-HKDF-SHA256 + AES-256-GCM, implemented
    in the Rust crypto crate) and encrypts the note blob.
  - `POST /rendezvous/:code/blob` — sender uploads the encrypted
    blob. The worker rejects writes if the rendezvous is expired or
    already has a blob.
  - `GET /rendezvous/:code/blob` — recipient pulls the blob exactly
    once. The worker deletes it on first successful read.
- **No long-lived pubkey registry.** Each rendezvous carries its own
  ephemeral key pair, so there is nothing to authenticate-by-overwriting
  later.
- The backend stores **only ciphertext** and short metadata. It never
  sees plaintext, the DEK, or the PRF output. We document this and add
  a server-side integration test that asserts requests carrying
  non-opaque bodies are rejected (best-effort, ciphertext is opaque).
- Pickup codes are 12 chars, base32, 60 bits of entropy bound to the
  ephemeral public key, with rate-limited brute force protection and
  a default TTL of 5 minutes. Cracking a 60-bit pre-image inside a
  5-minute, rate-limited window is computationally infeasible under
  any realistic attacker model we care about for a research project.

### Why two deployment targets

- Pages gives free static hosting that matches our "the user owns the
  data" stance.
- Workers gives the smallest possible backend and is deployable
  independently of the frontend.
- The two are loosely coupled by a single env var
  (`NEXT_PUBLIC_SHARE_BACKEND_URL`).

## Consequences

- We accept the operational cost of two deploy pipelines. They are both
  trivial (one GH Actions workflow each).
- The frontend gracefully degrades when the backend URL is unreachable:
  every non-share feature continues to work offline.
- Custom domain + HTTPS works on both Pages and Workers without code
  changes.
- The backend is small enough that we could re-port it to e.g. Vercel
  Edge or a Fly Machine without disrupting the frontend contract.

## Alternatives considered

- **Vercel** for the whole stack: would require Vercel hosting instead
  of Pages and adds vendor coupling. Pages is the explicit user choice.
- **GitHub Issues / Gists** as the share transport: clever but adds rate
  limits and breaks the "backend never sees plaintext attempts" story.
- **Server-Sent peer-to-peer (WebRTC)**: real-time but heavy. The MVP
  is one-shot relay; we revisit if continuous sync is added.
