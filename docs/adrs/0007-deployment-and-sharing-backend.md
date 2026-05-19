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
- Endpoints (sketch, finalized in a later ADR):
  - `POST /rendezvous` — recipient device starts here. The request
    body carries the recipient's **ephemeral X25519 public key** plus
    a WebAuthn assertion (the same passkey, signing the SHA-256 of the
    public key as the challenge). The worker verifies the assertion
    against the credential bound to *that* rendezvous's vault key
    record, mints a short pickup code (8 chars, base32), and stores
    `{code, ephemeralPubkey, credentialId, expiresAt}` in KV with a
    short TTL (default 5 minutes).
  - `GET /rendezvous/:code` — sender device fetches the ephemeral
    pubkey by code, derives a shared secret, encrypts the note blob to
    that public key (HPKE-style, X25519 + HKDF + AES-256-GCM in the
    Rust crypto crate), and posts the result.
  - `POST /rendezvous/:code/blob` — sender uploads the encrypted blob.
    The worker rejects writes if the rendezvous is expired or already
    has a blob.
  - `GET /rendezvous/:code/blob` — recipient pulls the blob exactly
    once. The worker deletes it on first successful read.
- **No long-lived pubkey registry.** Each rendezvous carries its own
  ephemeral key pair, so there is nothing to authenticate-by-overwriting
  later. The MitM surface area collapses to "the human typed the right
  8-character code into the right device", and the pickup code is
  bound to the specific ephemeral key at mint time.
- WebAuthn assertion on `POST /rendezvous` guarantees that only a
  passkey-holder can stand up a rendezvous; the backend still does not
  learn who the user is across rendezvous (we deliberately do not link
  credentialIds across sessions).
- The backend stores **only ciphertext** and short metadata. It never
  sees plaintext, the DEK, or the PRF output. We document this and add
  a server-side integration test that asserts requests carrying
  non-opaque bodies are rejected (best-effort, ciphertext is opaque).
- Pickup codes are short (8 chars, base32) with rate-limited brute force
  protection and a default TTL of 5 minutes. Brute-forcing the code
  before expiry still only buys the attacker an ephemeral pubkey, not
  the plaintext.

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
