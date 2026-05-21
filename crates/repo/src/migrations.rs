//! Forward-only schema migrations.
//!
//! `MIGRATIONS` is the ordered list of every `from_version →
//! to_version` step the schema has ever had. A driver picks up the
//! installed version from `schema_meta.version`, applies every
//! [`Migration`] whose `from_version` is `>= installed`, in order.
//!
//! Down-migrations are intentionally absent. The vault's row codec
//! is keyed on the schema's AAD format ([`crate::codec::aad_for`]);
//! a downgrade that revives an older AAD construction would either
//! fail authentication or — worse — accept tampered rows. Forward-
//! only is the simpler, safer story.

/// A single forward step.
///
/// `from_version` is the schema version this migration applies on
/// top of; `to_version` is what `schema_meta.version` should read
/// after it has run. `up_sql` runs as a single transaction.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// Version this migration assumes is currently installed.
    pub from_version: u32,
    /// Version the schema reaches after `up_sql` runs.
    pub to_version: u32,
    /// SQL to apply. Multiple statements separated by `;`.
    pub up_sql: &'static str,
}

/// All migrations in declaration order. Each entry's `to_version`
/// equals the next entry's `from_version`. The last entry's
/// `to_version` matches [`crate::schema::SCHEMA_VERSION`].
///
/// `from_version = 0` is the bootstrap case: applies to a fresh DB
/// that has no `schema_meta` rows yet. Drivers should record
/// `schema_meta.version = to_version` at the end of each step.
pub const MIGRATIONS: &[Migration] = &[Migration {
    from_version: 0,
    to_version: 1,
    up_sql: crate::schema::SCHEMA_SQL,
}];

/// Return the migrations a DB at `current_version` needs to run to
/// reach [`crate::schema::SCHEMA_VERSION`].
///
/// - `Ok(&[])` — the DB is already at `SCHEMA_VERSION`, no work to do.
/// - `Ok(&[...])` — apply each migration in order; each step's
///   `up_sql` is safe to run as a single transaction.
/// - `Err(Error::UnknownSchemaVersion)` — `current_version` is
///   neither a known `from_version` nor `SCHEMA_VERSION`. Most
///   commonly: the DB was created by a newer binary that knows
///   more migrations than we do, or `schema_meta.version` is
///   corrupted. Caller should refuse to proceed rather than try
///   to wing it.
///
/// Returning a typed error here (rather than an empty slice for
/// both the "current" and "unknown" cases — the original API)
/// lets the driver distinguish those two and surface "this binary
/// is too old / the DB is corrupt" instead of silently writing
/// against a schema it doesn't understand.
pub fn pending(current_version: u32) -> Result<&'static [Migration], crate::error::Error> {
    use crate::error::Error;
    use crate::schema::SCHEMA_VERSION;

    if current_version == SCHEMA_VERSION {
        return Ok(&[]);
    }
    // The list is dense and monotonic; bisect would be overkill.
    // Walk to the first entry whose `from_version` matches and
    // return everything from there.
    MIGRATIONS
        .iter()
        .position(|m| m.from_version == current_version)
        .map_or(
            Err(Error::UnknownSchemaVersion {
                current: current_version,
                latest: SCHEMA_VERSION,
            }),
            |i| Ok(&MIGRATIONS[i..]),
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::SCHEMA_VERSION;

    #[test]
    fn migrations_are_contiguous() {
        // Each step's `to_version` must equal the next step's
        // `from_version`. Catches accidental gaps when someone adds
        // a new migration without bumping the predecessor.
        for window in MIGRATIONS.windows(2) {
            let [prev, next] = window else { unreachable!() };
            assert_eq!(
                prev.to_version, next.from_version,
                "migration gap between {} → {} and {} → {}",
                prev.from_version, prev.to_version, next.from_version, next.to_version,
            );
        }
    }

    #[test]
    fn last_migration_reaches_schema_version() {
        let last = MIGRATIONS.last().expect("at least one migration");
        assert_eq!(last.to_version, SCHEMA_VERSION);
    }

    #[test]
    fn pending_on_fresh_db_returns_all() {
        let p = pending(0).expect("0 is a known from_version");
        assert_eq!(p.len(), MIGRATIONS.len());
        assert_eq!(p[0].from_version, 0);
    }

    #[test]
    fn pending_on_current_returns_empty() {
        let p = pending(SCHEMA_VERSION).expect("current is a known version");
        assert!(p.is_empty());
    }

    #[test]
    fn pending_on_unknown_version_errors() {
        // A schema version this binary doesn't recognise — most
        // commonly a DB created by a newer build, or a corrupted
        // `schema_meta.version`. The function now distinguishes
        // this from "already current" so callers can refuse to
        // proceed (codex on PR #41 flagged the prior empty-slice
        // ambiguity).
        let err = pending(SCHEMA_VERSION + 1).expect_err("unknown version must surface as Err");
        assert!(matches!(
            err,
            crate::error::Error::UnknownSchemaVersion { current, latest }
                if current == SCHEMA_VERSION + 1 && latest == SCHEMA_VERSION,
        ));
    }
}
