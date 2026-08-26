# rnxORM Test Suite Summary

## Current state: 534 tests passing. Mock by default, real databases via docker and CI

The default `npm test` run uses the in-memory `MockDatabaseProvider` (fast, no
infrastructure). The same suite runs against **real PostgreSQL, MariaDB,
and SQL Server** containers on every pull request and push to `main`
(`.github/workflows/integration.yml`), and locally:

```bash
# All tests against the in-memory mock (no database required)
npm test

# All tests against real databases
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

## Test suites

| Suite | Tests | What it validates |
|-------|-------|-------------------|
| ChangeTracker | 49 | Entity state transitions, dirty detection (100% coverage) |
| EntityEntry | 22 | Original values, modified-property detection (100% coverage) |
| MetadataStorage | 20 | Decorator metadata registration |
| DbContext | 4 | Context construction, DbSet access |
| SqlGeneration | 61 | **Exact SQL strings per dialect**: pagination (LIMIT/OFFSET vs OFFSET/FETCH), placeholders ($n / @pN / ?), aggregates, INSERT id-retrieval (RETURNING / OUTPUT INSERTED / insertId), IDENTITY_INSERT wrapping, concurrency-token UPDATE, projections, GROUP BY/HAVING, raw SQL passthrough |
| QueryFilterSql | 33 | **SQL-translated global query filters**: WHERE clause generation per dialect, placeholder numbering after user conditions, find()/count()/aggregate/projection coverage, dynamic (function) values, ignoreQueryFilters(), in-memory filtering of raw SQL results |
| EagerLoading | 8 | `.include()` for all four relation types: batched `WHERE ... IN` SQL, FK deduplication, entity stitching, empty-collection and null-FK edge cases |
| RelationshipBuilder | 5 | ModelBuilder relations: hasOne/hasMany/hasManyToMany metadata, foreign keys, inverse sides, cascade options, join-table defaults and overrides |
| ValueConversionAndKeyless | 6 | Value converters applied on insert/read/update; keyless entities (query mapping, ensureCreated skip, saveChanges no-op) |
| TrackingTransactionsAndSchema | 9 | asNoTracking (untracked, no persistence), saveChanges transaction begin/commit and rollback-on-error, executeSqlRaw row counts, shadow columns in INSERT, ensureCreated add-column and type-migration paths |
| ProviderTypeMapping | 10 | Real providers' type-mapping table (pins the README table), placeholder syntax per dialect, dialect ids, SqlCaptureProvider parity with real providers |
| MigrationBuilder | ~40 | Per-dialect DDL: createTable, auto-increment syntax, defaults, alter/rename, indexes, foreign keys |
| Migrator | ~34 | History table per dialect, migrate/revert/revertTo/status, transaction wrapping, rollback on error |
| MigrationCli | 13 | migration:create scaffolding, config resolution (default + --config), createMigrator() factory shapes, run/revert/status dispatch |
| ModelBuilder | 12 | Fluent API metadata: toTable, hasKey, hasNoKey, indexes, constraints, property config, conversions, shadow properties, seeding, query filters |
| ConcurrencyToken | 2 | End-to-end optimistic concurrency: token increment on save, violation when a competing context saved first |
| PropertyCapture | 52 | Recording-Proxy selector capture: property/projection/aggregate classification, nested, computed and short-circuit (`||`/`??`/ternary) selectors as `opaque`, `g.key`, `average` alias |
| Injection | 90 | Identifier/operator validation: closed operator set (incl. `IN`/`NOT IN`/`IS`/`IS NOT` expansion), metadata-checked columns, having-expression shapes, non-integer `skip()`/`take()` payloads, end-to-end rejection of injection payloads through `where()`/`orderBy()`/`having()`/`skip()`/`take()` |
| QueryFilterCoverage | 23 | Structured filters proven on every read path (count, pagination per dialect, all(), aggregates, select, find, groupBy incl. having placeholder ordering); legacy-lambda limitations pinned |
| EntityMapper | 15 | row to entity characterization for both mapping paths: renamed columns, converters, shadow-column exclusion, tracked vs asNoTracking |
| IdentityMap | 18 | Same tracked instance on repeated loads (find/toList) and through `include()`, entities entering tracking via attach/update/add, value-converted keys, local modifications survive re-query, eviction on delete/clear, asNoTracking excluded, per-context isolation |
| ActualApi (integration) | 18 | CRUD, all documented comparison operators (incl. LIKE, IN/NOT IN, IS/IS NOT with real placeholder expansion), pagination and its runtime validation, ordering, bulk ops, SQL-injection safety, unicode. Per provider when run with USE_REAL_DB |

## What the real-database run has verified

- All 3 providers connect, create schema, and pass the full CRUD suite
- Generated-key retrieval works (PostgreSQL RETURNING, MSSQL OUTPUT INSERTED, MariaDB insertId)
- Explicit-ID inserts into identity columns work on MSSQL (SET IDENTITY_INSERT wrapping)
- Per-dialect pagination executes on real engines

## Remaining gaps (honest list)

- The legacy predicate form of `hasQueryFilter()` is in-memory only: its
  `count()` counts unfiltered rows (pinned by test; use the structured form)
- The mock's SQL parsing supports multiple AND conditions, LIKE, IN/NOT IN and IS [NOT] NULL, but still no OR/joins
- `migration:run`/`revert`/`status` are covered at the unit level (config loading, dispatch); no end-to-end CLI process test

## Readiness assessment

- **Solid**: change tracking, transactions, concurrency tokens, migrations
  (library API and CLI), query/pagination SQL generation, SQL-translated query
  filters, eager loading, value converters, keyless entities, seeding , 
  tested at the SQL level and against real engines.
- **Not implemented** (see README feature status): owned entities, DDL default
  values, computed columns, explicit loading, lazy loading.
