# rnxORM Test Suite Summary

## Current state: 216 tests passing — mock by default, real databases via docker

The default `npm test` run uses the in-memory `MockDatabaseProvider` (fast, no
infrastructure). The same suite can be run against **real PostgreSQL, MariaDB,
and SQL Server** containers, and passes there too:

```bash
# All tests against the in-memory mock (no database required)
npm test

# All tests against real databases
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

A GitHub Actions workflow (`.github/workflows/integration.yml`, manual trigger)
runs the real-database suite in CI on demand.

## Test suites

| Suite | Tests | What it validates |
|-------|-------|-------------------|
| ChangeTracker | 49 | Entity state transitions, dirty detection (100% coverage) |
| EntityEntry | 22 | Original values, modified-property detection (100% coverage) |
| MetadataStorage | 20 | Decorator metadata registration |
| DbContext | 4 | Context construction, DbSet access |
| SqlGeneration | 28 | **Exact SQL strings per dialect**: pagination (LIMIT/OFFSET vs OFFSET/FETCH), placeholders ($n / @pN / ?), aggregates, INSERT id-retrieval (RETURNING / OUTPUT INSERTED / insertId), IDENTITY_INSERT wrapping, concurrency-token UPDATE, projections, GROUP BY/HAVING, raw SQL passthrough |
| MigrationBuilder | ~40 | Per-dialect DDL: createTable, auto-increment syntax, defaults, alter/rename, indexes, foreign keys |
| Migrator | ~34 | History table per dialect, migrate/revert/revertTo/status, transaction wrapping, rollback on error |
| ModelBuilder | 12 | Fluent API metadata: toTable, hasKey, hasNoKey, indexes, constraints, property config, conversions, shadow properties, seeding, query filters (incl. end-to-end filter behavior on toList/find/where/ignoreQueryFilters) |
| ConcurrencyToken | 2 | End-to-end optimistic concurrency: token increment on save, violation when a competing context saved first |
| ActualApi (integration) | 15 | CRUD, pagination, ordering, bulk ops, SQL-injection safety, unicode — per provider when run with USE_REAL_DB |

## Coverage (default mock run)

```
ChangeTracker / EntityEntry   100%
src/migrations                ~98%
MetadataStorage               ~86%
DbContext                     ~55%
ModelBuilder                  ~52%   (relationship builders still uncovered)
DbSet                         ~49%   (eager-loading include() paths still uncovered)
Real providers                ~2% here — exercised by the real-DB run instead
```

## What the real-database run has verified

- All 3 providers connect, create schema, and pass the full CRUD suite
- Generated-key retrieval works (PostgreSQL RETURNING, MSSQL OUTPUT INSERTED, MariaDB insertId)
- Explicit-ID inserts into identity columns work on MSSQL (SET IDENTITY_INSERT wrapping)
- Per-dialect pagination executes on real engines

## Remaining gaps (honest list)

- Eager loading (`.include()` for all four relationship types) has no dedicated tests
- Relationship configuration via ModelBuilder (hasOne/hasMany/hasManyToMany) untested
- Value converters, keyless entities, and shadow properties lack end-to-end tests
- The real-DB integration job is manual (workflow_dispatch), not part of every CI run
- The mock's SQL parsing supports multiple AND conditions but still no OR/LIKE/joins

## Readiness assessment

- **Solid**: change tracking, transactions, concurrency tokens, migrations,
  query/pagination SQL generation, seeding — tested at the SQL level and
  against real engines.
- **Implemented, tested lightly**: eager loading, value converters, keyless
  entities (work in real-DB CRUD paths but lack dedicated tests).
- **Not implemented** (see README feature status): owned entities, DDL default
  values, computed columns, explicit loading, CLI migration:run/revert/status.
