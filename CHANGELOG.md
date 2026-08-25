# Changelog

## 2.2.0 (unreleased)

### Security

- **Runtime identifier and operator validation** (issues #13/#24).
  `where()`, `orderBy()`, `orderByDescending()`, and `having()` on every
  builder validate the column against entity metadata (accepting property or
  column spelling; renamed properties resolve to their mapped column) and the
  operator against a closed set (`=`, `!=`, `<>`, `>`, `<`, `>=`, `<=`,
  `LIKE`, `ILIKE`, `NOT LIKE`). Structured query-filter operators pass
  through the same set. Injected strings — including the
  `orderBy(req.query.sort)` pattern — now throw before any SQL is assembled.
  Previously column and operator were interpolated verbatim. Added
  `SECURITY.md` documenting the protection boundary.

### Added

- **Identity map** (issue #5). Loading the same row twice returns the same
  tracked instance, keyed by entity type + primary key. Local unsaved
  modifications survive a re-query; deletion and `changeTracker.clear()`
  evict; `asNoTracking()` results are never identity-mapped.
- **Recording-Proxy selector capture** (issues #3/#21/#16/#17).
  `src/core/expressions/PropertyCapture.ts` replaces regex parsing of lambda
  selectors everywhere (include, aggregates, select/groupBy projections,
  ModelBuilder, decorators). Nested paths (`u => u.address.city`) and
  computed selectors now fail loudly or fall back explicitly instead of
  silently resolving to a wrong column. `groupBy().select()` gains `g.key`
  aliasing and a working `g.average()`.
- **Typed `where`/`orderBy` overloads** (`keyof T`) for editor autocomplete,
  additive over the string forms (issue #26's runtime half).
- **Query filters now apply to `groupBy()`** (issue #23's last gap), injected
  ahead of GROUP BY/HAVING with placeholder ordering preserved;
  `ignoreQueryFilters()` respected.
- Publish gate: `release.yml` runs the full suite against real PostgreSQL,
  MariaDB, and SQL Server before `npm publish` (dry-run by default; issue #6).
- Issue and PR templates (issue #11's remainder).

### Changed (breaking for undocumented usage)

- `where()`/`orderBy()`/`having()` now **throw** on unmapped columns and
  unknown operators instead of emitting them into SQL. Code passing invalid
  identifiers was generating broken or dangerous SQL before; it now fails at
  the call site.
- A `select()` projection naming an unmapped property now **throws** instead
  of silently returning `SELECT *`-based results.
- `extractPropertyName` (regex selector parsing) is removed from the public
  API, replaced by the PropertyCapture module.

### Added (from the earlier unreleased 2.2.0 work)

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

### Documentation

- **The README is now evidence-based.** The Features section carries a
  feature→test verification map linking every implemented claim to the test
  suite that proves it. Claims that had no automated evidence got tests
  (`asNoTracking`, `saveChanges` transaction wrapping and rollback,
  `executeSqlRaw`, shadow-column inserts, schema evolution, the provider
  type-mapping table, comparison operators). Two false claims were corrected:
  SQL Server `string` maps to `NVARCHAR(MAX)` (not `NVARCHAR(255)`) and
  MariaDB `Date` maps to `DATETIME` (not `TIMESTAMP`). The query-operator list
  now states that operators are passed through verbatim and flags `ILIKE` as
  PostgreSQL-only.

### Testing

- Test suite grew from 216 to 286 tests: SQL-level assertions for query-filter
  translation across all three dialects, dedicated eager-loading tests for all
  four relation types, ModelBuilder relationship-configuration coverage,
  value-converter round-trip tests, keyless-entity tests, migration-CLI tests,
  tracking/transaction/schema-evolution tests, provider type-mapping contract
  tests, and a per-engine comparison-operator test. The mock provider now
  understands `LIKE`.

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
