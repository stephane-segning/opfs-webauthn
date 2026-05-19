# PRD 01 — MVP scope

The MVP is what we commit to shipping to GitHub Pages as the first
"installable, usable" build.

## In scope

### Identity
- Single-button enrollment that creates a passkey with the PRF extension.
- Single-button unlock from a returning visit.
- Detection of "this browser does not support PRF" with a clear,
  non-recoverable error screen explaining the requirement.
- Local-only "vault" concept: the device that enrolled is the device that
  can unlock. No account, no server-side identity.

### Notes
- Create, read, update, delete notes.
- A single plaintext or lightly-formatted body (Markdown rendered with a
  small library; rich-text editor is out of scope for MVP).
- Title derived from the first line; manual override allowed.
- Created / updated timestamps.
- Soft delete (archive) with a "show archived" toggle.
- Full-text search over decrypted titles + bodies, in-memory after
  decryption.

### Storage
- SQLite database file persisted in OPFS.
- Per-row encryption of note content (body + title) using a random
  per-vault **DEK**. The DEK is wrapped at rest with a **KEK** derived
  from the WebAuthn PRF output (see ADR 0005 for the full key
  hierarchy); the PRF output is never used directly as the
  content-encryption key.
- Row IDs are stored in plaintext; timestamps are quantized to 24h
  buckets on disk and stored at full precision inside the encrypted
  blob (see ADR 0004 for the metadata-leak trade-off).

### Sync (local)
- Multi-tab safety: two tabs in the same browser do not corrupt the DB and
  see each other's writes.

### Sharing (cross-device)
- Sharing is a **recipient-first rendezvous**, not a sender-initiated
  push to a directory of users.
- On the recipient device, the user taps "Receive on this device". The
  recipient generates a fresh ephemeral X25519 keypair, authenticates
  the request with its own passkey, and the backend returns a short
  12-character pickup code (5-minute TTL).
- The user reads the code out loud or types it on the sender device.
- The sender device fetches the recipient's ephemeral public key by
  code, derives a shared secret, encrypts the note's plaintext with
  AES-256-GCM under that secret, and uploads the ciphertext.
- The recipient device pulls the blob exactly once, decrypts it
  locally, and inserts it into its own DB. The backend deletes the
  blob on first read and the pickup code expires.
- The backend never holds anything other than the ephemeral public
  key, the encrypted blob, and short metadata; no long-lived directory
  of "who is who".

### PWA / offline
- Installable manifest with icons.
- Service worker that serves the app shell offline.
- App is fully functional offline after first load. Sharing requires
  network; everything else does not.

### Deployment
- Static export deployed to GitHub Pages on push to `main`.
- A separate small backend service deployed independently for the sharing
  endpoint.

## Out of scope for MVP

See [02 — Non-goals](./02-non-goals.md) for the durable list. The short
version: no rich-text editor, no folders / tags, no attachments, no
recovery flow, no cross-device automatic sync, no multi-user collaboration
on a single note.

## Acceptance checklist

- [ ] Fresh browser → enrollment → first note saved in < 15s on a mid-range
      phone over LTE.
- [ ] Airplane mode after first load → all note operations still work.
- [ ] Reload page → vault unlocks with one biometric tap.
- [ ] Two tabs open → edits in one appear in the other within ~500ms with
      no DB corruption under stress (rapid alternating writes).
- [ ] Receive on device B → 12-character code shown. Type code on
      device A → pick a note → "send" → device B sees the note
      decrypted; the backend log shows only the ephemeral pubkey and
      the ciphertext blob; the rendezvous record is gone after the
      recipient pull.
- [ ] App installs as a PWA on iOS Safari and Android Chrome.
- [ ] All ADRs marked Accepted reflect the shipped behaviour.
