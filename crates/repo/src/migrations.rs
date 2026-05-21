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
/// reach [`crate::schema::SCHEMA_VERSION`]. Empty slice means the
/// DB is already current.
#[must_use]
pub fn pending(current_version: u32) -> &'static [Migration] {
    // The list is dense and monotonic; bisect would be overkill.
    // Walk to the first entry whose `from_version` matches and
    // return everything from there.
    let start = MIGRATIONS
        .iter()
        .position(|m| m.from_version == current_version);
    match start {
        Some(i) => &MIGRATIONS[i..],
        // `current_version` is past the last `to_version` — schema
        // is current, nothing to do. (We don't try to "downgrade".)
        None => &[],
    }
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
        let p = pending(0);
        assert_eq!(p.len(), MIGRATIONS.len());
        assert_eq!(p[0].from_version, 0);
    }

    #[test]
    fn pending_on_current_returns_empty() {
        let p = pending(SCHEMA_VERSION);
        assert!(p.is_empty());
    }

    #[test]
    fn pending_on_past_returns_empty() {
        // A future schema bumped beyond what this binary knows about
        // is a no-op rather than a panic — the driver checks the
        // returned slice's emptiness and surfaces the version
        // mismatch as a typed error, not as a missing migration.
        let p = pending(SCHEMA_VERSION + 1);
        assert!(p.is_empty());
    }
}
