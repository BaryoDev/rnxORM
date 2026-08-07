# rnxORM Test Suite Summary

## Current state: 266 tests passing — mock by default, real databases via docker and CI

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
| SqlGeneration | 28 | **Exact SQL strings per dialect**: pagination (LIMIT/OFFSET vs OFFSET/FETCH), placeholders ($n / @pN / ?), aggregates, INSERT id-retrieval (RETURNING / OUTPUT INSERTED / insertId), IDENTITY_INSERT wrapping, concurrency-token UPDATE, projections, GROUP BY/HAVING, raw SQL passthrough |
| QueryFilterSql | 18 | **SQL-translated global query filters**: WHERE clause generation per dialect, placeholder numbering after user conditions, find()/count()/aggregate/projection coverage, dynamic (function) values, ignoreQueryFilters(), in-memory filtering of raw SQL results |
| EagerLoading | 8 | `.include()` for all four relation types: batched `WHERE ... IN` SQL, FK deduplication, entity stitching, empty-collection and null-FK edge cases |
| RelationshipBuilder | 5 | ModelBuilder relations: hasOne/hasMany/hasManyToMany metadata, foreign keys, inverse sides, cascade options, join-table defaults and overrides |
| ValueConversionAndKeyless | 6 | Value converters applied on insert/read/update; keyless entities (query mapping, ensureCreated skip, saveChanges no-op) |
| MigrationBuilder | ~40 | Per-dialect DDL: createTable, auto-increment syntax, defaults, alter/rename, indexes, foreign keys |
| Migrator | ~34 | History table per dialect, migrate/revert/revertTo/status, transaction wrapping, rollback on error |
| MigrationCli | 13 | migration:create scaffolding, config resolution (default + --config), createMigrator() factory shapes, run/revert/status dispatch |
| ModelBuilder | 12 | Fluent API metadata: toTable, hasKey, hasNoKey, indexes, constraints, property config, conversions, shadow properties, seeding, query filters |
| ConcurrencyToken | 2 | End-to-end optimistic concurrency: token increment on save, violation when a competing context saved first |
| ActualApi (integration) | 15 | CRUD, pagination, ordering, bulk ops, SQL-injection safety, unicode — per provider when run with USE_REAL_DB |

## What the real-database run has verified

- All 3 providers connect, create schema, and pass the full CRUD suite
- Generated-key retrieval works (PostgreSQL RETURNING, MSSQL OUTPUT INSERTED, MariaDB insertId)
- Explicit-ID inserts into identity columns work on MSSQL (SET IDENTITY_INSERT wrapping)
- Per-dialect pagination executes on real engines

## Remaining gaps (honest list)

- Structured query filters are not applied to `groupBy()` queries (documented limitation)
- The mock's SQL parsing supports multiple AND conditions but still no OR/LIKE/joins
- `migration:run`/`revert`/`status` are covered at the unit level (config loading, dispatch); no end-to-end CLI process test

## Readiness assessment

- **Solid**: change tracking, transactions, concurrency tokens, migrations
  (library API and CLI), query/pagination SQL generation, SQL-translated query
  filters, eager loading, value converters, keyless entities, seeding —
  tested at the SQL level and against real engines.
- **Not implemented** (see README feature status): owned entities, DDL default
  values, computed columns, explicit loading, lazy loading.
