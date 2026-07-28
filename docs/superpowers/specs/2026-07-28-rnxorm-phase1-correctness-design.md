# rnxORM Phase 1 — Correctness (2.2.0)

**Date:** 2026-07-28
**Status:** Approved
**Scope:** Non-breaking correctness release. Phase 2 (query-core rewrite, 3.0) and
Phase 3 (feature honesty gap) are specified separately.

## Context

rnxORM 2.1.0 has a solid change-tracking core, a well-covered migration system, and
a 216-test suite that passes against real PostgreSQL 16, MariaDB 11, and SQL Server
2022. The weaknesses are concentrated in the query layer:

- `src/core/DbSet.ts` is 1508 lines holding five classes, each re-implementing
  dialect branching inline.
- Lambda selectors are decoded with regular expressions applied to
  `Function.prototype.toString()`, which fails silently and breaks under bundling.
- Global query filters are JS predicates applied in memory *after* the database has
  already paginated, so filtered pages are wrong and `count()` disagrees with
  `toList()`.

Phase 1 fixes the defects that do not require a full expression compiler, and builds
the two components that Phase 2's compiler will be constructed from. Nothing built
here is throwaway.

## Sequencing

| Phase | Release | Content |
|-------|---------|---------|
| 1 (this spec) | 2.2.0 | Correctness fixes; property capture; declarative conditions |
| 2 | 3.0.0 | Expression tree + SQL compiler; typed `where`; dialect logic moved into providers; identifier quoting; legacy paths deleted |
| 3 | 3.x | Owned entities, DDL defaults, computed columns, explicit loading, CLI `migration:run/revert/status` |

## Architecture

### New module: `src/core/expressions/PropertyCapture.ts`

Sole export `capture(selector)`. Invokes the user's lambda with a recording Proxy and
classifies the return value:

```ts
capture(u => u.name)                     // { kind: 'property',  path: 'name' }
capture(u => ({ n: u.name, a: u.age }))  // { kind: 'projection', aliases: { n: 'name', a: 'age' } }
capture(u => u.first + ' ' + u.last)     // { kind: 'opaque' }
```

Design points that make this robust where the regex was not:

- **Alias mapping is structural.** For projections we read the returned object's keys
  as aliases and its values as markers. The mapping is derived from the returned
  shape, not from source-text ordering.
- **Misses are detected, not guessed.** A marker reaching `Symbol.toPrimitive`,
  `Symbol.toStringTag`, or `toString` means the lambda computed something the proxy
  cannot represent. `capture` returns `kind: 'opaque'` and the caller falls back to
  in-memory projection *knowingly*. Today's regex silently produces a wrong or absent
  optimization with no signal.
- **Parameter names are irrelevant**, so minified and transpiled builds work.
- **The selector is invoked exactly once** and the result cached per call site;
  selectors with side effects are not run twice.
- **`then` is never recorded.** The proxy returns `undefined` for `then` so a marker
  is never mistaken for a thenable when it crosses an `await`.

`capture` replaces `src/core/utils.ts:extractPropertyName` (used by `include`, `sum`,
`average`, `min`, `max`) and both regex projection extractors in `DbSet.ts`.

**`opaque` means different things to different callers**, and this is deliberate.
`select` and `groupBy` have a legitimate fallback: project in memory. `include`,
`sum`, `average`, `min`, and `max` require a single resolvable column and have no
fallback — for them `opaque` is an error, raised with the offending selector's source
text in the message. Today `extractPropertyName` either throws a raw regex-failure
message or, worse, returns the first `\w+` after a dot regardless of whether it is a
real column. Both callers get a defined outcome instead.

The
grouped-query variant additionally records aggregate calls (`g => ({ c: g.count() })`),
replacing the regex at `DbSet.ts:1442`.

### New module: `src/core/expressions/Condition.ts`

The declarative condition spec, a builder, and `compileCondition(cond, provider,
paramOffset) → { sql, params }` — the single place that turns a condition into
parameterized SQL.

```ts
modelBuilder.entity(User).hasQueryFilter({ isDeleted: false })
modelBuilder.entity(Order).hasQueryFilter(c => c.eq('tenantId', currentTenantId))
```

Builder surface: `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `in`, `notIn`, `like`,
`isNull`, `isNotNull`, `and`, `or`, `not`.

Semantics fixed by this spec:

- `null` compiles to `IS NULL` / `IS NOT NULL`, never `= NULL`.
- `undefined` is an error, not a silent no-op — it is ambiguous.
- Falsy values (`false`, `0`, `''`) are real values and are never dropped.
- `in([])` compiles to a constant-false predicate. `IN ()` is a syntax error on all
  three engines.
- Multiple object keys are ANDed. Nested `and`/`or` groups are parenthesized.
- Values pass through the column's value converter (`convertToDb`) before binding.
- Unknown columns raise an error naming the property.
- Parameter numbering respects `paramOffset` so filter params compose with user
  `where()` params. Ordering is significant for MariaDB's positional `?`.

### Query filter push-down

Every read path injects the compiled filter fragment into `WHERE` *before*
`LIMIT`/`OFFSET`: `toList`, `find`, `count`, `any`, the aggregates, the select
builder, and the grouped builder. They stop having independent filter logic, which is
what makes defects 1 and 2 a single fix rather than five.

`ignoreQueryFilters()` suppresses the fragment on every one of those paths.

### Mechanical split

`src/core/DbSet.ts` → `src/core/query/`: `DbSet.ts`, `QueryBuilder.ts`,
`SelectQueryBuilder.ts`, `GroupedQueryBuilder.ts`, `RawSqlQueryBuilder.ts`, and
`EntityMapper.ts` (absorbing the row-mapping duplicated at `DbSet.ts:285` and `:320`).

Pure code motion, landed as its own commit ahead of the behavior changes, so the
subsequent diffs are reviewable. Phase 2 rewrites these files.

## Defects fixed

| # | Defect | Site | Fix |
|---|--------|------|-----|
| 1 | Query filter applied client-side after `LIMIT`/`OFFSET` → wrong pages | `DbSet.ts:88,171,513,1121,1141` | push into `WHERE` |
| 2 | `count()` ignores query filters → disagrees with `toList()` | `DbSet.ts:537` | shared `WHERE` assembly |
| 3 | Regex projection extraction | `DbSet.ts:1043,1076,1350,1442` | `PropertyCapture` |
| 4 | Regex property extraction | `utils.ts:5` | `PropertyCapture` |
| 5 | `column` and `operator` concatenated into SQL | `DbSet.ts:374` | validate column against metadata; whitelist operator |
| 6 | `orderBy` column concatenated into SQL | `DbSet.ts:409,417` | validate against metadata |
| 7 | `all(predicate)` scans the whole table | `DbSet.ts:556` | cannot push down a JS predicate before Phase 2 — switch to no-tracking, document honestly |
| 8 | Row mapping duplicated | `DbSet.ts:285,320` | `EntityMapper` |

## Backward compatibility

`hasQueryFilter` keeps accepting the legacy JS lambda, applied in memory exactly as
today, behind a one-time deprecation warning. Which API was used is determined by
probing: invoke the callback with a `ConditionBuilder`; a `Condition` back means the
new API, anything else means legacy. A legacy `u => u.isDeleted === false` probed this
way evaluates to `false` harmlessly. The object-spec form needs no probe
(`typeof !== 'function'`).

The legacy path is deleted in 3.0.

## Test plan

Every SQL assertion runs per dialect (PostgreSQL, MariaDB, MSSQL), matching the
existing `SqlGeneration.test.ts` style. The full suite must pass against the real
containers in `docker-compose.test.yml`, not only the mock.

### PropertyCapture

Forms: `u => u.name`; `(u) => u.name`; `function (u) { return u.name }`; minified
`a=>a.name`; object literal; object literal with the same source column under two
aliases; nested `u => u.address.city`.

Opaque detection: string concatenation; template literal; arithmetic; returning a
constant; returning the proxy root; returning an array; a selector that throws; a
marker passed to `JSON.stringify`; a marker crossing `await` (must not be thenable).

Errors and integration: property absent from metadata errors with the property name;
shadow properties; columns carrying a value converter still apply `convertFromDb`
after projection; the selector is invoked exactly once (assert via a side-effect
counter); grouped selectors capture aggregate calls.

Nested paths are a Phase 2 concern: in a projection they classify as opaque; in
`include()` they raise an explicit "not supported until 3.0" error rather than
silently reading the first segment.

### Condition compilation

Exact SQL per dialect for each builder method. Placeholder numbering under a non-zero
`paramOffset`, and composition of a filter with a user `where()` — asserting MariaDB
positional-parameter order specifically.

Value handling: `null` → `IS NULL`; `undefined` → throws; `false`, `0`, `''` survive;
`Date`, `Buffer`, and `bigint` bind correctly; converter columns bind the converted
value.

Structure: multi-key AND; nested and/or parenthesization; `not`; `in([])` →
constant-false; `in` with one element; unknown column errors.

### Regression tests for the shipped bugs

- Seed 10 rows with 5 soft-deleted; `.skip(2).take(2)` returns rows 3–4 **of the
  filtered set**. This test fails on 2.1.0.
- `await count()` equals `(await toList()).length` under a filter.
- `any()` returns `false` when the filter excludes every row.
- `find(id)` on a filtered-out id returns `null`.
- `sum`/`average`/`min`/`max` respect the filter — these build their own SQL today and
  must be verified independently.
- Filter combined with `select` projection, and with `groupBy`.
- `ignoreQueryFilters()` restores unfiltered results on **every** path above,
  including `count()` and the aggregates.
- Filter plus `include` plus pagination plus `orderBy` in a single query.

### Injection

`where('name; DROP TABLE users--', '=', 1)` throws. `where('name', 'IS NOT NULL; DELETE
FROM x--', 1)` throws on the operator whitelist. `orderBy('name; DROP')` throws.
Case-mismatched column names have an asserted, documented behavior. Values remain
parameterized.

### Deprecation path

Legacy lambda still filters; the warning fires once per model, not per query; probing
a legacy lambda that dereferences properties does not throw; object-spec and builder
forms both work.

### Refactor safety

Characterization tests for `EntityMapper` — tracked vs no-tracking mapping, shadow
properties, value converters — written **before** the code motion.

## Explicit non-goals

- **Identifier quoting.** Columns named with reserved words (`order`, `user`) are
  emitted unquoted today and can break. Fixing it changes every generated SQL string
  and would invalidate the 28 exact-SQL tests wholesale. It belongs in Phase 2, where
  the compiler owns SQL emission. Tracked, not forgotten.
- **Filters on included navigations.** EF Core applies filters to eagerly loaded
  navigations; Phase 1 applies the root entity's filter only. Documented as a known
  limitation.
- **Typed `where(u => u.age > 18)`.** Phase 2. Phase 1 only hardens the existing
  string form.
- **ESM/dual build, N+1 review, connection-pool work.** Out of scope for a
  correctness release.

## Success criteria

1. The soft-delete pagination test and the `count()`/`toList()` agreement test pass.
2. No `Function.prototype.toString()` parsing remains in `src/`.
3. Column and operator inputs cannot reach SQL unvalidated.
4. Existing 216 tests still pass, plus the new cases, against the mock and against all
   three real engines.
5. `npm run lint` clean; no file in `src/core/query/` exceeds ~400 lines.
6. Upgrading from 2.1.0 requires no source changes.
