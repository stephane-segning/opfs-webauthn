# opfs-repo

SQL schema, migrations, and encrypted row codec for the `opfs-webauthn`
notes vault.

## Status

Stub. This crate currently exposes only `SCHEMA_VERSION` and a
placeholder `current_schema_sql()`. The schema, migrations framework,
and row codec land in the storage-implementation PR (see the project
todo / ADR 0004).

## Reuse

When the codec is in place, this crate will be usable as a generic
"encrypted-row SQLite layer" with custom schemas — the host project
will supply the table definitions and the JS-side sqlite-wasm driver,
and this crate will own the column-level encryption.
