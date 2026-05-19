/**
 * Notes-table schema. Per ADR 0004:
 *
 * - `id` BLOB: 16 random bytes (128 bits). Stored as BLOB, not TEXT,
 *   because the worker treats it as bytes; the page side encodes /
 *   decodes Crockford base32 for the JS string handle.
 * - `updated_day`: integer days since the Unix epoch
 *   (`floor(unixSeconds / 86400)`). Day-quantised so the disk layout
 *   never reveals when within the day a note was edited.
 * - `archived`: 0 / 1 bool.
 * - `*_nonce` / `*_ciphertext` BLOB pairs: AES-GCM nonce + ciphertext+tag
 *   produced by `CryptoVault.encrypt`. AAD binding is `note-row:v1`.
 *
 * Index orders newest day desc then id desc — `id` is the stable
 * secondary sort because it leaks no timing.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS schema_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS notes (
  id BLOB PRIMARY KEY NOT NULL,
  updated_day INTEGER NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  title_nonce BLOB NOT NULL,
  title_ciphertext BLOB NOT NULL,
  body_nonce BLOB NOT NULL,
  body_ciphertext BLOB NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_notes_recent
  ON notes(updated_day DESC, id DESC)
  WHERE archived = 0;
`;

export const ROW_AAD = "opfs-webauthn/v1/note-row";
