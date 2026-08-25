# rnxORM examples

Runnable showcase scripts for rnxORM. Each file is self-contained: it drops
and recreates its own uniquely-prefixed tables (`ex1_`, `ex2_`, ...) at the
top of `main()`, so you can run any example any number of times without
manual cleanup, and running one example never touches another's tables.

These examples import from `../src` (the package source) so they run
directly against this checkout. In your own app, install `rnxorm` and import
from the package name instead, e.g. `import { DbContext } from "rnxorm";` —
each file's header comment shows the equivalent import.

## Running

From the repository root:

```bash
docker compose -f ../docker-compose.test.yml up -d --wait
npx ts-node examples/01-quickstart.ts
npx ts-node examples/02-relationships.ts
npx ts-node examples/03-query-filters-and-security.ts
npx ts-node examples/04-concurrency-and-identity.ts
npx ts-node examples/05-migrations.ts
```

`--wait` matters: without it the container is up before PostgreSQL accepts
connections, and the examples fail on connection refused rather than on
anything you changed.

When you're done:

```bash
docker compose -f ../docker-compose.test.yml down -v
```

## What each example shows

| File | Shows |
| --- | --- |
| `01-quickstart.ts` | Entities with decorators, `connect()`, `ensureCreated()`, change-tracked CRUD (`add`/`saveChanges`/generated id, modify, `remove`), `find()`, `where().orderBy().skip().take()`. |
| `02-relationships.ts` | `OneToMany`/`ManyToOne` (Author/Book), `include()` eager loading, `ManyToMany` (Book/Genre) through a join table. |
| `03-query-filters-and-security.ts` | Structured `hasQueryFilter()` soft-delete filtering respected by `count()`, pagination, and `groupBy()`; `ignoreQueryFilters()`; then a security demo where `orderBy()` rejects an injection-shaped column string, caught in a `try`/`catch`. |
| `04-concurrency-and-identity.ts` | The identity map (`find()` twice on one context returns the same instance, printed via `===`), and optimistic concurrency (two contexts racing to update the same row; the loser's `saveChanges()` throws). |
| `05-migrations.ts` | A programmatic `Migrator` with `createTable`/`addColumn` migrations (each with a matching `down()`), `migrate()` then `status()`, plus comments showing the CLI equivalents (`npx rnxorm migration:create ...`, `migration:run`, and the `rnxorm.config.js` shape). |

## Environment variables

All examples connect to PostgreSQL with the same defaults, matching
`docker-compose.test.yml`:

| Variable | Default |
| --- | --- |
| `POSTGRES_HOST` | `localhost` |
| `POSTGRES_PORT` | `5433` |
| `POSTGRES_USER` | `postgres` |
| `POSTGRES_PASSWORD` | `postgres` |
| `POSTGRES_DB` | `rnxorm_test` |

Override any of them to point an example at a different PostgreSQL instance.
