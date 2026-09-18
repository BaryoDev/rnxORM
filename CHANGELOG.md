# Changelog

## Unreleased

### Security

- **Migration DDL is validated and quoted** (issue #44). `MigrationBuilder`
  concatenated every argument into DDL, including string defaults that land
  inside quotes, so an app building migration operations from request data had
  an injection point: a default of `x'; DROP TABLE users; --` closed the
  literal and ran, and the SQL Server `sp_rename` path broke out of its string
  literal the same way. Identifiers are now validated as plain identifiers
  (optionally `schema.name`) and quoted per dialect, string defaults have their
  quotes doubled, column types must match a type grammar, and `ON DELETE` must
  be one of the four referential actions.
  Quoting is unconditional on SQL Server and MariaDB, whose quote characters
  affect reserved words and special characters but not case resolution. On
  PostgreSQL it is conditional: a lower-case name is emitted bare, exactly as
  before, and only a reserved word or a mixed-case name is quoted. PostgreSQL
  folds unquoted identifiers to lower case and leaves quoted ones alone, so
  quoting a name that used to be bare would point it at a different table; the
  manual's advice is to "always quote a particular name or never quote it".
  This follows what the Npgsql provider does rather than EF Core's
  unconditional base behavior.
  **Behavior change:** reserved words now work as table and column names
  (`createTable('order', ...)` was previously invalid SQL). SQL Server and
  MariaDB DDL strings gain quote characters. PostgreSQL DDL for lower-case
  names is unchanged. Identifiers that were never valid unquoted (anything with
  a space, a quote, or a semicolon) now throw.
- **`migration:create` validates the migration name** (issue #44). The name was
  interpolated into both the output path and the generated source, so
  `../../../../tmp/pwned` wrote a file outside the migrations directory and a
  name containing `")` broke out of the `super("id", "name")` literal. Names
  are now restricted to letters, numbers, hyphens, and underscores, and the
  resolved path is asserted to stay under the migrations directory.
- **TLS is configurable, and SQL Server encrypts by default** (issue #43).
  `DatabaseConfig` gained `ssl` (`true` or a driver options object),
  `trustServerCertificate`, and a `driverOptions` passthrough, forwarded by all
  three providers. There was previously no supported way to enable TLS on any
  provider, and the SQL Server provider hardcoded `encrypt: false` with
  `trustServerCertificate: true`, putting its traffic on the wire in cleartext
  and accepting any certificate presented. **Behavior change:** SQL Server now
  defaults to `encrypt: true, trustServerCertificate: false`. A local server
  with a self-signed certificate needs `ssl: false` (or
  `trustServerCertificate: true`) set explicitly.
- **Projection aliases are validated** (issue #31). The keys of an
  object-literal projection in `select()` and `groupBy().select()` reached SQL
  as aliases with no validation, while every other identifier position was
  already guarded. A computed key built from request data
  (`{ [req.query.label]: u.name }`) was an injection point: the projection binds
  no parameters, so on `pg` the statement goes over the simple query protocol,
  which accepts stacked statements. Aliases now go through the same
  plain-identifier rule as grouped `orderBy()` aliases and throw before any SQL
  is assembled.

### Fixed

- **mariadb upgraded and dotenv removed** (issue #42). The pinned mariadb
  connector carried three advisories, including one where it leaks the
  cleartext password to an interceptor despite `ssl: true`, which defeats the
  TLS support added in #43, and a SQL injection under the big5/gbk/sjis/cp932/
  gb18030 client charsets. `dotenv` was a production dependency that nothing in
  `src/` imports. `npm audit --omit=dev` now reports zero vulnerabilities.
- **Transactions no longer collide** (issue #38). Transaction state is a single
  slot on the provider instance, so `saveChanges()` and a caller-opened
  transaction fought over it: `saveChanges()` committed the caller's
  transaction early and the caller's later rollback rolled back nothing. On
  PostgreSQL, commit also released a pooled client the caller had acquired
  through `connect()`, after which every later query silently drew an arbitrary
  connection. `saveChanges()` now enlists in an open transaction instead of
  wrapping its own, and only commits or rolls back one it opened. A nested
  `beginTransaction()` throws rather than silently ending the outer transaction
  (which is what MariaDB does with a second START TRANSACTION, and what SQL
  Server did by orphaning the first Transaction object). The SQL Server
  provider also builds its own connection pool rather than the module-global
  one, so two providers with different configs no longer share a pool that
  either one's `disconnect()` closes.
- **Generated keys and exact-numeric aggregates keep their precision**
  (issue #39). The three drivers return three different JS types for BIGINT and
  DECIMAL, and the ORM funnelled all of them through `Number()`/`parseFloat()`,
  which silently rounds anything a double cannot represent: a generated key
  above 2^53 came back wrong, and a DECIMAL sum lost its cents. Values that
  convert exactly are still numbers; values that do not keep their exact string
  form. `count()` also parses with an explicit radix and returns 0 for an empty
  result set rather than NaN. `QueryResult.insertId` is now `number | string`.
- **Change detection compares values, not references** (issue #40). The
  original-values snapshot was a shallow `{ ...entity }` compared with `!==`,
  which was wrong in both directions: two `Date` objects holding the same
  instant are different references, so an entity with a date column was
  rewritten on every save, and nested objects and arrays were shared by
  reference with the entity, so `user.config.theme = 'light'` or
  `user.tags.push('x')` mutated the "original" too and was never persisted.
  Snapshots are now deep for the shapes a column can hold, and comparison is by
  value: `Date` by instant, objects and arrays structurally.
- **`include()` no longer dirties the entities it loads** (issue #34).
  Navigation properties were part of the snapshot comparison, and
  `loadIncludes` assigns them after the snapshot is taken, so every eagerly
  loaded root looked modified. With a concurrency token configured, the next
  unrelated `saveChanges()` bumped the version of every row a read had touched,
  which then broke other contexts holding those rows with spurious concurrency
  violations. Change detection now compares mapped columns only; navigations
  are relations, not column values.
- **`update()` on a detached entity emits SQL** (issue #33). The
  disconnected-update pattern (take an entity off the wire, mark it modified,
  save) snapshotted the entity against itself, so nothing looked modified and
  `updateEntity` returned before emitting anything, while `saveChanges()` still
  reported 1. An entry with no baseline from a database read now writes every
  non-key column, matching EF Core's `Update()`, and `saveChanges()` counts
  statements actually executed rather than entries considered.
- **Deletes check concurrency tokens and row counts** (issue #41). `DELETE` ran
  without the token in its `WHERE` clause and ignored the result, so deleting a
  row another user had already changed or deleted succeeded silently. It now
  carries the token and throws the same concurrency error `updateEntity` does
  when no rows are affected.
- **Concurrency tokens are only bumped after the write succeeds** (issue #41).
  The new value was assigned to the entity while the statement was still being
  built, so a failed or rolled-back save left the entity holding `version + 1`
  against an unchanged `originalValues`, and a retry sent the wrong expected
  version. Non-numeric tokens were also reset to the integer `1`; they now
  throw, and the README no longer documents timestamp or GUID tokens, which
  never worked.
- **`saveChanges()` orders writes by foreign-key dependency** (issue #36).
  Entries were written in insertion order, so adding a child before its parent
  sent the child INSERT first and hit the FK constraint; deletes had the mirror
  problem. Inserts are now topologically sorted principal-first and deletes
  dependent-first. Setting a navigation (`post.author = user`) also back-fills
  the dependent's foreign key once the principal INSERT returns its generated
  key, so the EF Core idiom of adding both and saving once works.
- **Value converters apply to query inputs** (issue #35). Converters ran on
  insert, update, read, and structured query filters, but not on `where()`
  values, `find(id)`, or the parent key in `include()` collection loads. A
  converted column was compared against its unconverted domain value, so the
  query matched nothing and returned an empty result with no error. `IN`/`NOT
  IN` convert per element. `having()` is deliberately unchanged: it compares
  against aggregates, not stored column values.
- **`select(u => u.prop)` returns values, not rows** (issue #45). A
  single-property selector is typed `TResult[]` but returned the raw driver
  rows, so `select(u => u.age)` gave `[{ age: 30 }]` where the compiler said
  `[30]`, and worse with a renamed column, where the key was the column name.
  Object-literal projections are unchanged.
- **Predicate query filters refuse row limits** (issue #45). The predicate form
  of `hasQueryFilter` runs in memory after the database has applied
  `LIMIT`/`OFFSET`, so it dropped rows out of an already-truncated page:
  `first()` returned null while matching rows sat unread, `single()` could throw
  "Sequence contains more than one element" wrongly, and `take(20)` came back
  short. The combination now throws and names `ignoreQueryFilters()` as the way
  out. The structured filter form compiles to SQL and is unaffected.

### Changed

- Coverage is no longer collected on every `jest` run. `npm test` runs without
  it; `npm run test:cov` collects it, and `npm run test:quiet` trims the output
  further for iterating on one file.

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
