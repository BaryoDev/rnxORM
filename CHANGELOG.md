# Changelog

## 2.2.0 (2026-08-26)

### Security

- **Runtime identifier and operator validation** (issues #13/#24).
  `where()`, `orderBy()`, `orderByDescending()`, and `having()` on every
  builder validate the column against entity metadata (accepting property or
  column spelling; renamed properties resolve to their mapped column) and the
  operator against a closed set (`=`, `!=`, `<>`, `>`, `<`, `>=`, `<=`,
  `LIKE`, `ILIKE`, `NOT LIKE`, `IN`, `NOT IN`, `IS`, `IS NOT`). Structured
  query-filter operators pass through the same set. Injected strings , 
  including the `orderBy(req.query.sort)` pattern. Now throw before any SQL is
  assembled. Previously column and operator were interpolated verbatim. Added
  `SECURITY.md` documenting the protection boundary.
  Grouped `orderBy()` is the one documented exception: it also accepts a
  projection alias that exists only in the SELECT list, which metadata cannot
  verify, so such aliases are required to be plain identifiers. Which still
  rejects every injection-shaped string (quotes, whitespace, semicolons,
  comment markers).
- **`skip()` / `take()` validate their argument.** Row limits are the only
  query-API arguments that must be interpolated into SQL (`LIMIT`/`OFFSET` and
  `OFFSET ... FETCH NEXT` take no bound parameter on every driver), and
  TypeScript's `number` type erases at runtime. An `as any` cast or an untyped
  `req.query.limit` used to land verbatim in the statement
  (`take("10; DELETE FROM users --")` emitted the payload). All four builders
  now require a non-negative integer and throw before any SQL is assembled.

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
  silently resolving to a wrong column. `groupBy().select()` gains an `avg`
  synonym for `g.average()` and emits the group key as a column
  (see Changed for the `g.key` aliasing behavior change).
- **`IN`, `NOT IN`, `IS`, and `IS NOT` are supported operators** on `where()`,
  `having()`, and structured query filters. `IN`/`NOT IN` take an array and
  expand to one placeholder per element (an empty array compiles to the
  constant `1 = 0` / `1 = 1` rather than invalid SQL); `IS`/`IS NOT` take
  `null` and emit `IS NULL` / `IS NOT NULL` binding nothing. Placeholder
  numbering accounts for both, so conditions composed after them still bind
  correctly on every dialect. Passing a non-array to `IN`, or a non-null value
  to `IS`, throws.
- **Eager-loaded entities are change-tracked and identity-mapped.** See
  Changed. `include()` previously returned untracked, unmapped copies.
- **Query-filter operators are validated at registration time.**
  `ModelBuilder.hasQueryFilter()` (structured form) checks each condition's
  operator when `onModelCreating()` runs, so a configuration typo fails once at
  startup instead of on every read. The compile-time check remains.
- **Typed `keyof T` overloads** for editor autocomplete, additive over the
  string forms (issue #26's runtime half): `where()`, `orderBy()`, and
  `orderByDescending()` on `DbSet`, `QueryBuilder`, and `SelectQueryBuilder`.
  The grouped builder's `orderBy()`/`orderByDescending()` stay string-only,
  because they also accept projection aliases, which are not properties of `T`.
- **Query filters now apply to `groupBy()`** (issue #23's last gap), injected
  ahead of GROUP BY/HAVING with placeholder ordering preserved;
  `ignoreQueryFilters()` respected. Caveat: because `having()` bakes its
  placeholder indices from the parameter count at call time, grouped queries
  must inject the filter first. So a **function-valued** filter value is
  resolved when `groupBy()` is called, not when the query executes. Every other
  read path resolves it at execution. Build grouped queries after the value
  (e.g. the current tenant) is in place.
- Publish gate: `release.yml` runs the full suite against real PostgreSQL,
  MariaDB, and SQL Server before `npm publish` (dry-run by default; issue #6).
- Issue and PR templates (issue #11's remainder).

### Changed

- **Operators outside the supported set now throw**. Breaking for
  *documented* 2.1 usage, not just undefined behavior: 2.1's README showed
  arbitrary SQL comparison operators. The closed set now covers everything
  that was realistically in use (`IN`/`NOT IN`/`IS`/`IS NOT` are restored
  above), leaving `BETWEEN` as the one documented operator with no
  replacement. Express it as two `where()` calls
  (`.where('age','>=',18).where('age','<=',65)`).
- `where()`/`orderBy()`/`having()` now **throw** on unmapped columns instead of
  emitting them into SQL. Code passing invalid identifiers was generating
  broken or dangerous SQL before; it now fails at the call site.
- **`having()` rejects composite expressions.** Only a mapped column or a
  single aggregate over one (`COUNT(*)`, `SUM(price)`, ...) is accepted;
  expressions such as `SUM(price)/COUNT(*)` now throw instead of being
  interpolated verbatim.
- **`groupBy().select()` throws on unrecognized selector shapes** instead of
  silently emitting degenerate SQL. A non-`count` aggregate called without a
  column selector (`g.sum()`) throws too, where it previously rendered
  `SUM(undefined)` into the statement.
- **`g.key` now aliases the group column.** A selector containing `g.key`
  emits `<group column> AS <alias>`. So `select(g => ({ dept: g.key, ... }))`
  changes both the emitted SQL and the result-row keys (previously the bare
  group column was emitted and rows came back keyed by the column name, e.g.
  `department`, not `dept`). Selectors that never reference `g.key` keep their
  previous SQL shape exactly.
- **Eager-loaded related entities are now tracked and identity-mapped.**
  `include()` maps related rows through the querying context, so an included
  entity that is already tracked is the SAME instance (local unsaved edits
  included) instead of an untracked copy. `asNoTracking()` still excludes the
  whole graph.
- **Entities attached with a known key join the identity map.**
  `attach()`, `update()`, and `add()` with an explicit primary key register in
  the identity map, so a later `find()` of that key returns the same instance
  rather than a second tracked copy. `Detached` entries are not registered.
- **Generated keys are converted on backfill.** After an insert, an
  auto-increment key with a value converter is written to the entity through
  `convertFromDb`, matching the row-mapping path, so insert-then-`find()` keys
  the identity map identically.
- A `select()` projection naming an unmapped property now **throws** instead
  of silently returning `SELECT *`-based results.
- `extractPropertyName` (regex selector parsing) is removed from the public
  API, replaced by the PropertyCapture module.
- **Selectors that pick between columns are no longer resolved to one
  column.** `u => u.nickname || u.name`, `u => u.a ?? u.b`, and
  `u => flag ? u.a : u.b` are recognized as computed: `select()` falls back to
  `SELECT *` plus in-memory projection (correct results, full rows fetched),
  and APIs with no fallback (`include`, `sum`, `average`, `min`, `max`,
  `groupBy` aggregates) throw. Previously the first column reached silently
  became the whole expression. `capture()` now evaluates the selector twice , 
  a second "nullish probe" pass is the only way to observe a short-circuited
  operand. So selectors must be pure.

### Added (from the earlier unreleased 2.2.0 work)

- **SQL-translated global query filters.** `hasQueryFilter()` now accepts
  structured conditions. `{ property, operator, value }` or an array of them , 
  that are compiled into parameterized SQL `WHERE` clauses on every query path
  (`toList()`, `find()`, `where()` chains, `count`/`sum`/`average`/`min`/`max`,
  and `select()` projections), so filtered rows never leave the database.
  `operator` must come from the same validated set as `where()` (see Security),
  `value` may be a function resolved at query time (e.g. a current tenant id),
  and value converters are applied. Per element for `IN`/`NOT IN`. The
  predicate form remains supported and
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
  feature-to-test verification map linking every implemented claim to the test
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
- Suite now at 534 tests (569 with the real-database paths enabled), adding:
  `skip()`/`take()` payload rejection end-to-end, `IN`/`NOT IN`/`IS`/`IS NOT`
  exact-SQL and placeholder-composition tests per dialect (builder chains and
  query filters, including the real-driver run), short-circuit selector
  classification and its `select()` fallback, eager-load and
  attach/update/converted-key identity-map cases, registration-time filter
  operator validation, and `applyQueryFilter()` idempotence. The mock provider
  now also understands `IN`/`NOT IN` and `IS [NOT] NULL`.

### Removed

- Five stale demo scripts in `test/` that used the pre-2.0 `DbContext`
  constructor API and no longer compiled.

## 2.1.0 (2026-07-13)

Stabilization release: the suite now runs against real PostgreSQL 16, MariaDB 11,
and SQL Server 2022 (via `docker-compose.test.yml` / `npm run test:integration`),
and the documentation was rewritten to state feature status honestly
(implemented / partial / planned). See the Features section of the README.

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
