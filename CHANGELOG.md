# Changelog

## 2.1.0 (2026-07-13)

Stabilization release: the suite now runs against real PostgreSQL 16, MariaDB 11,
and SQL Server 2022 (via `docker-compose.test.yml` / `npm run test:integration`),
and the documentation was rewritten to state feature status honestly
(implemented / partial / planned) — see the Features section of the README.

### Fixed

- **Generated keys are now returned after insert on real databases.** Auto-increment
  primary keys are backfilled onto the entity after `saveChanges()` using
  `RETURNING` (PostgreSQL), `OUTPUT INSERTED` (SQL Server), and the driver's
  `insertId` (MariaDB). Previously the entity id stayed `undefined` on all three.
- **Explicit IDs into identity columns now work on SQL Server.** Inserts (and
  `hasData()` seeding) with explicit primary-key values are wrapped in
  `SET IDENTITY_INSERT ... ON/OFF`.
- **Global query filters now apply to plain `toList()` and `find()`**, matching the
  documented behavior. Previously they only applied to `where()`/`orderBy()` chains.
- **Grouped queries paginate correctly on SQL Server** (`OFFSET ... FETCH NEXT`
  instead of invalid `LIMIT/OFFSET`).

### Documentation

- README, `llms.txt`, and `TEST_SUMMARY.md` rewritten for accuracy. Key corrections:
  query filters run in memory (not translated to SQL); `asNoTracking()` entities are
  not frozen; `ownsOne`/`ownsMany`, `hasDefaultValue`, and `hasComputedColumnSql`
  are metadata-only (planned); the migration CLI only implements `migration:create`;
  raw-SQL placeholders are provider-native; `.include()` uses batched queries, not JOINs.

### Testing

- Test suite grew from 95 to 216 tests: exact per-dialect SQL-generation assertions,
  full MigrationBuilder/Migrator DDL coverage, ModelBuilder fluent-API coverage, and
  end-to-end optimistic-concurrency tests.
- Added `docker-compose.test.yml`, `npm run test:integration`, and a manual-trigger
  GitHub Actions workflow that runs the suite against real databases.

## 2.0.0

- Multi-provider support (PostgreSQL, SQL Server, MariaDB), change tracking,
  migrations, and breaking API changes. See README for details.
