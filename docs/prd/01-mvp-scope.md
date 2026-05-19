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
- Per-row encryption of note content (body + title) using a DEK derived
  from the PRF output.
- Row IDs and timestamps are stored in plaintext to allow indexing.

### Sync (local)
- Multi-tab safety: two tabs in the same browser do not corrupt the DB and
  see each other's writes.

### Sharing (cross-device)
- A "share to another device" action produces a one-time pickup code.
- The other device, already enrolled with its own passkey, can claim the
  code and receive the encrypted blob.
- The blob is wrapped with an ephemeral key exchange (sender encrypts to
  recipient's published public key) so the backend only sees ciphertext.
- Recipient inserts the decrypted note into its own DB.

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
- [ ] Send a note from device A to device B → device B sees the note
      decrypted; the backend log shows only ciphertext.
- [ ] App installs as a PWA on iOS Safari and Android Chrome.
- [ ] All ADRs marked Accepted reflect the shipped behaviour.
