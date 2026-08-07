# Changelog

## 2.2.0 (2026-08-07)

### Added

- **SQL-translated global query filters.** `hasQueryFilter()` now accepts
  structured conditions — `{ property, operator, value }` or an array of them —
  that are compiled into parameterized SQL `WHERE` clauses on every query path
  (`toList()`, `find()`, `where()` chains, `count`/`sum`/`average`/`min`/`max`,
  and `select()` projections), so filtered rows never leave the database.
  `value` may be a function resolved at query time (e.g. a current tenant id),
  and value converters are applied. The predicate form remains supported and
  still runs in memory. Raw SQL results are now filtered in memory by both
  forms. `DbSet` gained `ignoreQueryFilters()` for parity with query chains.
- **Working migration CLI.** `rnxorm migration:run`, `migration:revert`, and
  `migration:status` are now functional: they load a `rnxorm.config.js`
  (or `--config <path>`, or a `.ts` config when ts-node is installed) that
  exports a `createMigrator()` factory, execute the command, and disconnect.
  Previously these commands only printed instructions.
- `Migrator.getContext()` accessor.

### Fixed

- **Published type declarations.** The build never emitted `.d.ts` files even
  though `package.json` pointed `types` at `dist/index.d.ts`; `declaration` is
  now enabled in `tsconfig.build.json`.
- `npx tsc --noEmit` over the whole repo works again (the base tsconfig no
  longer forces `rootDir: src` onto test files).

### Changed

- The real-database integration workflow now runs on every pull request and
  push to `main` (previously manual-trigger only).

### Testing

- Test suite grew from 216 to 266 tests: SQL-level assertions for query-filter
  translation across all three dialects, dedicated eager-loading tests for all
  four relation types, ModelBuilder relationship-configuration coverage,
  value-converter round-trip tests, keyless-entity tests, and migration-CLI
  tests.

### Removed

- Five stale demo scripts in `test/` that used the pre-2.0 `DbContext`
  constructor API and no longer compiled.

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
