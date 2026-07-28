# rnxORM Phase 1 Correctness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship rnxORM 2.2.0, a non-breaking release that eliminates regex-based lambda parsing, pushes global query filters into SQL so pagination and `count()` are correct, and closes the SQL-injection holes in `where()`/`orderBy()`.

**Architecture:** Two new pure modules under `src/core/expressions/` — a recording-Proxy property capturer and a declarative condition compiler — become the single sources of truth for "which column did this lambda mean" and "how does a filter become SQL". The 1508-line `src/core/DbSet.ts` is split into `src/core/query/` first so subsequent diffs are reviewable, with `DbSet.ts` left behind as a re-export barrel so no consumer import changes.

**Tech Stack:** TypeScript 5.9 (strict, CommonJS, ES2020), Jest 30 + ts-jest, ESLint 9, Prettier. Providers: `pg`, `mariadb`, `mssql`.

**Spec:** `docs/superpowers/specs/2026-07-28-rnxorm-phase1-correctness-design.md`

## Global Constraints

- **Non-breaking.** Upgrading from 2.1.0 must require zero source changes. The legacy `hasQueryFilter(lambda)` form keeps working.
- **No `Function.prototype.toString()` parsing may remain in `src/`** when the plan completes.
- **Every SQL assertion runs per dialect** — `postgresql`, `mariadb`, `mssql` — via `SqlCaptureProvider` from `test/mocks/SqlCaptureProvider.ts`, matching the style of `test/unit/SqlGeneration.test.ts`.
- **Placeholder styles** are produced only by `provider.getParameterPlaceholder(index)`, 1-based: `$1..$n` (postgres), `@p0..@pN-1` (mssql), `?` (mariadb). Never hand-write a placeholder.
- **Parameter order is significant** for MariaDB's positional `?`. SQL fragments and their params must always be appended to their arrays in the same order.
- **No identifier quoting.** Explicit non-goal; deferred to Phase 2. Do not add quoting — it would invalidate the 28 existing exact-SQL tests.
- **Existing 216 tests must keep passing.** `npm test` is the mock run; `npm run test:integration` is the real-database run.
- **Target file size:** no file in `src/core/query/` over ~400 lines.
- Run `npm run lint` before every commit. Commits use Conventional Commits.

---

## File Structure

**Created:**

| File | Responsibility |
|------|---------------|
| `src/core/expressions/PropertyCapture.ts` | Recording Proxy; resolves a lambda to a column path, a projection alias map, or a classified `opaque` |
| `src/core/expressions/Condition.ts` | Condition node types, `ConditionBuilder`, `normalizeCondition`, `compileCondition` |
| `src/core/query/EntityMapper.ts` | Row → entity mapping (tracking + no-tracking), shadow properties, value converters |
| `src/core/query/DbSet.ts` | The `DbSet<T>` entry point |
| `src/core/query/QueryBuilder.ts` | Filter/order/paginate/include builder |
| `src/core/query/SelectQueryBuilder.ts` | Projection builder |
| `src/core/query/GroupedQueryBuilder.ts` | Grouping + aggregate builder |
| `src/core/query/RawSqlQueryBuilder.ts` | Raw SQL builder |
| `src/core/query/QueryFilter.ts` | Shared helper that injects the compiled filter into a WHERE assembly |
| `src/core/query/Identifiers.ts` | Column-name and operator validation |
| `test/unit/PropertyCapture.test.ts` | Capture unit + edge cases |
| `test/unit/Condition.test.ts` | Condition compilation per dialect |
| `test/unit/QueryFilterPushdown.test.ts` | Regression tests for the shipped bugs |
| `test/unit/Injection.test.ts` | Column/operator validation |
| `test/unit/EntityMapper.test.ts` | Characterization tests for the mapper |

**Modified:**

| File | Change |
|------|--------|
| `src/core/DbSet.ts` | Becomes a re-export barrel over `src/core/query/` |
| `src/core/utils.ts` | `extractPropertyName` deleted |
| `src/core/MetadataStorage.ts:92` | `queryFilter` type widened to hold the compiled condition + legacy predicate |
| `src/core/ModelBuilder.ts:526` | `hasQueryFilter` accepts spec/builder, probes for legacy |
| `src/index.ts` | Export `ConditionBuilder` and condition types |
| `README.md`, `CHANGELOG.md`, `TEST_SUMMARY.md`, `package.json` | Release prep |

---

## Task 1: EntityMapper characterization tests

Pin current row-mapping behavior **before** any code moves, so the split in Task 2 is provably behavior-preserving.

**Files:**
- Test: `test/unit/EntityMapper.test.ts` (create)
- Read only: `src/core/DbSet.ts:285-350`

**Interfaces:**
- Consumes: nothing.
- Produces: a passing test file that Task 2 must keep green after the mapper moves to `src/core/query/EntityMapper.ts`.

- [ ] **Step 1: Write characterization tests against the current public API**

Create `test/unit/EntityMapper.test.ts`:

```ts
import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

@Entity('mapper_users')
class MapUser {
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column() tags!: string[];
}

beforeAll(() => {
    const meta = MetadataStorage.get().getEntity(MapUser)!;
    const tags = meta.columns.find(c => c.propertyName === 'tags')!;
    tags.hasConversion = true;
    tags.convertToDb = (v: string[]) => v.join(',');
    tags.convertFromDb = (v: string) => (v === '' || v == null ? [] : String(v).split(','));

    meta.columns.push({
        target: MapUser,
        propertyName: 'tenantId',
        columnName: 'tenant_id',
        type: 'number',
        isPrimaryKey: false,
        isNullable: true,
        isShadowProperty: true,
    });
});

function makeDb() {
    const provider = new SqlCaptureProvider('postgresql');
    return { provider, db: new DbContext(provider) };
}

describe('row mapping', () => {
    it('maps columns onto the entity instance', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'ada', tags: 'a,b', tenant_id: 7 }], rowCount: 1 });

        const [user] = await db.set(MapUser).toList();

        expect(user).toBeInstanceOf(MapUser);
        expect(user.id).toBe(1);
        expect(user.name).toBe('ada');
    });

    it('applies convertFromDb for converted columns', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'ada', tags: 'a,b', tenant_id: 7 }], rowCount: 1 });

        const [user] = await db.set(MapUser).toList();

        expect(user.tags).toEqual(['a', 'b']);
    });

    it('does not assign shadow properties onto the entity', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'ada', tags: '', tenant_id: 7 }], rowCount: 1 });

        const [user] = await db.set(MapUser).toList();

        expect((user as any).tenantId).toBeUndefined();
        expect((user as any).tenant_id).toBeUndefined();
    });

    it('tracks entities by default and does not track under asNoTracking', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'ada', tags: '', tenant_id: 1 }], rowCount: 1 });
        await db.set(MapUser).toList();
        const tracked = db.getChangeTracker().getEntries().length;

        const fresh = makeDb();
        fresh.provider.nextResult({ rows: [{ id: 2, name: 'bob', tags: '', tenant_id: 1 }], rowCount: 1 });
        await fresh.db.set(MapUser).asNoTracking().toList();
        const untracked = fresh.db.getChangeTracker().getEntries().length;

        expect(tracked).toBe(1);
        expect(untracked).toBe(0);
    });
});
```

- [ ] **Step 2: Run the tests and reconcile with actual behavior**

Run: `npx jest test/unit/EntityMapper.test.ts --coverage=false`

Expected: PASS. If `getChangeTracker()` or `getEntries()` differ, run `grep -n "getChangeTracker\|getEntries" src/core/DbContext.ts src/core/ChangeTracker.ts` and adjust the test to the real names. **Do not change `src/` in this task** — these tests document what exists today, whatever that is. If a test reveals genuinely surprising behavior, record it in the test name rather than fixing it here.

- [ ] **Step 3: Commit**

```bash
git add test/unit/EntityMapper.test.ts
git commit -m "test: characterize row mapping before query layer split"
```

---

## Task 2: Split DbSet.ts into src/core/query/

Pure code motion. No behavior change, no signature change.

**Files:**
- Create: `src/core/query/DbSet.ts`, `QueryBuilder.ts`, `SelectQueryBuilder.ts`, `GroupedQueryBuilder.ts`, `RawSqlQueryBuilder.ts`, `EntityMapper.ts`
- Modify: `src/core/DbSet.ts` (becomes a barrel)

**Interfaces:**
- Consumes: Task 1's characterization tests.
- Produces: `src/core/query/QueryBuilder.ts` exporting `QueryBuilder<T>`; `src/core/query/EntityMapper.ts` exporting `mapRowToEntity<T>(row, entityType, options)` where `options: { track: boolean; context: DbContext }`. Tasks 4–10 edit files under `src/core/query/`.

- [ ] **Step 1: Confirm the current test baseline**

Run: `npm test 2>&1 | tail -20`
Expected: 216 passing. Record the exact number — it must not drop.

- [ ] **Step 2: Move each class into its own file**

Cut each class from `src/core/DbSet.ts` verbatim into the matching new file under `src/core/query/`, adding the imports each one needs. Import paths gain one `../` level (e.g. `from "./MetadataStorage"` becomes `from "../MetadataStorage"`).

Extract the two duplicated row-mapping bodies (`DbSet.ts:285` `mapRowToEntity` and `DbSet.ts:320`) into `src/core/query/EntityMapper.ts` as one exported function:

```ts
import { DbContext } from "../DbContext";
import { MetadataStorage } from "../MetadataStorage";

export interface MapOptions {
    track: boolean;
    context: DbContext;
}

export function mapRowToEntity<T>(row: any, entityType: new () => T, options: MapOptions): T {
    const entity = new entityType();
    const metadata = MetadataStorage.get().getEntity(entityType);
    if (!metadata) return entity;

    for (const col of metadata.columns) {
        let value = row[col.columnName];
        if (col.hasConversion && col.convertFromDb) {
            value = col.convertFromDb(value);
        }
        if (!col.isShadowProperty) {
            (entity as any)[col.propertyName] = value;
        }
    }

    if (options.track) {
        options.context.getChangeTracker().track(entity);
    }

    return entity;
}
```

Reconcile the tracking call with whatever the two originals actually do — if they differ from each other, keep the union of behavior and note the difference in a code comment. Replace both original call sites with calls to `mapRowToEntity`.

- [ ] **Step 3: Turn `src/core/DbSet.ts` into a barrel**

Replace the whole file with:

```ts
export { DbSet } from "./query/DbSet";
export { QueryBuilder } from "./query/QueryBuilder";
export { SelectQueryBuilder } from "./query/SelectQueryBuilder";
export { GroupedQueryBuilder } from "./query/GroupedQueryBuilder";
export { RawSqlQueryBuilder } from "./query/RawSqlQueryBuilder";
```

This keeps every existing import path valid, so no other file needs editing.

- [ ] **Step 4: Verify nothing broke**

```bash
npm run build && npm test 2>&1 | tail -20 && npm run lint
```

Expected: build clean, same test count passing as Step 1, lint clean.

- [ ] **Step 5: Confirm the size target**

Run: `wc -l src/core/query/*.ts`
Expected: every file under ~400 lines. If `QueryBuilder.ts` exceeds it, that is acceptable at this stage — Task 8 removes code from it. Do not split further to chase the number.

- [ ] **Step 6: Commit**

```bash
git add src/core/DbSet.ts src/core/query/
git commit -m "refactor: split DbSet into src/core/query modules

Pure code motion. DbSet.ts remains a re-export barrel so no consumer
import changes. Deduplicates row mapping into EntityMapper."
```

---

## Task 3: PropertyCapture module

**Files:**
- Create: `src/core/expressions/PropertyCapture.ts`
- Test: `test/unit/PropertyCapture.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `capture(selector: (entity: any) => any): CaptureResult`
  - `captureAggregates(selector: (group: any) => any): AggregateCaptureResult`
  - `type CaptureResult = { kind: 'property'; path: string } | { kind: 'projection'; aliases: Record<string, string> } | { kind: 'opaque'; reason: OpaqueReason }`
  - `type OpaqueReason = 'computed' | 'nested' | 'unsupported'`
  - `type AggregateCaptureResult = { kind: 'aggregates'; aggregates: Record<string, { fn: 'count' | 'sum' | 'avg' | 'min' | 'max'; path?: string }> } | { kind: 'opaque'; reason: OpaqueReason }`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/PropertyCapture.test.ts`:

```ts
import { capture, captureAggregates } from '../../src/core/expressions/PropertyCapture';

describe('capture — single property', () => {
    it('captures an arrow selector', () => {
        expect(capture((u: any) => u.name)).toEqual({ kind: 'property', path: 'name' });
    });

    it('captures a parenthesized arrow selector', () => {
        expect(capture((u: any) => u.name)).toEqual({ kind: 'property', path: 'name' });
    });

    it('captures a function-expression selector', () => {
        expect(capture(function (u: any) { return u.name; })).toEqual({ kind: 'property', path: 'name' });
    });

    it('is independent of the parameter name', () => {
        expect(capture((a: any) => a.name)).toEqual({ kind: 'property', path: 'name' });
    });
});

describe('capture — projections', () => {
    it('captures an object-literal projection', () => {
        expect(capture((u: any) => ({ n: u.name, a: u.age })))
            .toEqual({ kind: 'projection', aliases: { n: 'name', a: 'age' } });
    });

    it('captures the same column under two aliases', () => {
        expect(capture((u: any) => ({ a: u.name, b: u.name })))
            .toEqual({ kind: 'projection', aliases: { a: 'name', b: 'name' } });
    });

    it('is opaque when a projection value is a constant', () => {
        expect(capture((u: any) => ({ n: u.name, k: 1 })).kind).toBe('opaque');
    });
});

describe('capture — opaque detection', () => {
    const cases: Array<[string, (u: any) => any]> = [
        ['string concatenation', (u: any) => u.first + ' ' + u.last],
        ['template literal', (u: any) => `${u.first}`],
        ['arithmetic', (u: any) => u.age * 2],
        ['constant', () => 5],
        ['array return', (u: any) => [u.name]],
        ['the root itself', (u: any) => u],
        ['a throwing selector', () => { throw new Error('boom'); }],
    ];

    it.each(cases)('is opaque for %s', (_label, selector) => {
        expect(capture(selector).kind).toBe('opaque');
    });

    it('reports nested access as reason "nested"', () => {
        expect(capture((u: any) => u.address.city)).toEqual({ kind: 'opaque', reason: 'nested' });
    });

    it('reports computed expressions as reason "computed"', () => {
        expect(capture((u: any) => u.first + u.last)).toEqual({ kind: 'opaque', reason: 'computed' });
    });

    it('is opaque when a marker is JSON-stringified', () => {
        expect(capture((u: any) => JSON.stringify(u.name)).kind).toBe('opaque');
    });
});

describe('capture — safety', () => {
    it('invokes the selector exactly once', () => {
        let calls = 0;
        capture((u: any) => { calls++; return u.name; });
        expect(calls).toBe(1);
    });

    it('never exposes a thenable marker', async () => {
        let marker: any;
        capture((u: any) => { marker = u.name; return u.name; });
        expect(marker.then).toBeUndefined();
        await expect(Promise.resolve(marker)).resolves.toBe(marker);
    });
});

describe('captureAggregates', () => {
    it('captures count', () => {
        expect(captureAggregates((g: any) => ({ c: g.count() })))
            .toEqual({ kind: 'aggregates', aggregates: { c: { fn: 'count' } } });
    });

    it('captures sum over a property', () => {
        expect(captureAggregates((g: any) => ({ total: g.sum((x: any) => x.price) })))
            .toEqual({ kind: 'aggregates', aggregates: { total: { fn: 'sum', path: 'price' } } });
    });

    it('is opaque for an unknown aggregate', () => {
        expect(captureAggregates((g: any) => ({ x: g.median() })).kind).toBe('opaque');
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/unit/PropertyCapture.test.ts --coverage=false`
Expected: FAIL — `Cannot find module '../../src/core/expressions/PropertyCapture'`.

- [ ] **Step 3: Implement**

Create `src/core/expressions/PropertyCapture.ts`:

```ts
const PATH = Symbol("rnxorm.capturePath");

export type OpaqueReason = "computed" | "nested" | "unsupported";

export type CaptureResult =
    | { kind: "property"; path: string }
    | { kind: "projection"; aliases: Record<string, string> }
    | { kind: "opaque"; reason: OpaqueReason };

export type AggregateFn = "count" | "sum" | "avg" | "min" | "max";

export type AggregateCaptureResult =
    | { kind: "aggregates"; aggregates: Record<string, { fn: AggregateFn; path?: string }> }
    | { kind: "opaque"; reason: OpaqueReason };

function pathOf(value: any): string | undefined {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) {
        return undefined;
    }
    const path = value[PATH];
    return typeof path === "string" ? path : undefined;
}

function isPlainObject(value: any): boolean {
    return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        pathOf(value) === undefined
    );
}

interface Recorder {
    root: any;
    coerced: () => boolean;
}

function createRecorder(): Recorder {
    let coerced = false;

    const marker = (path: string): any => {
        const base: any = function () {
            coerced = true;
        };
        return new Proxy(base, {
            get(_target, prop) {
                if (prop === PATH) return path;
                // Never let a marker look like a promise.
                if (prop === "then") return undefined;
                // Any symbol access (Symbol.toPrimitive, Symbol.toStringTag) or an
                // explicit coercion hook means the lambda is computing something we
                // cannot represent as a column reference.
                if (typeof prop === "symbol" || prop === "toString" || prop === "valueOf" || prop === "toJSON") {
                    coerced = true;
                    return undefined;
                }
                return marker(`${path}.${String(prop)}`);
            },
            apply() {
                coerced = true;
                return undefined;
            },
        });
    };

    const root = new Proxy({} as any, {
        get(_target, prop) {
            if (prop === "then") return undefined;
            if (typeof prop === "symbol") {
                coerced = true;
                return undefined;
            }
            return marker(String(prop));
        },
    });

    return { root, coerced: () => coerced };
}

export function capture(selector: (entity: any) => any): CaptureResult {
    const { root, coerced } = createRecorder();

    let returned: any;
    try {
        returned = selector(root);
    } catch {
        return { kind: "opaque", reason: "computed" };
    }

    if (coerced()) return { kind: "opaque", reason: "computed" };

    const direct = pathOf(returned);
    if (direct !== undefined) {
        return direct.includes(".")
            ? { kind: "opaque", reason: "nested" }
            : { kind: "property", path: direct };
    }

    if (isPlainObject(returned)) {
        const aliases: Record<string, string> = {};
        for (const [alias, value] of Object.entries(returned)) {
            const path = pathOf(value);
            if (path === undefined) return { kind: "opaque", reason: "computed" };
            if (path.includes(".")) return { kind: "opaque", reason: "nested" };
            aliases[alias] = path;
        }
        if (Object.keys(aliases).length === 0) {
            return { kind: "opaque", reason: "unsupported" };
        }
        return { kind: "projection", aliases };
    }

    return { kind: "opaque", reason: "unsupported" };
}

const AGGREGATE_FNS: AggregateFn[] = ["count", "sum", "avg", "min", "max"];
const AGG = Symbol("rnxorm.aggregate");

export function captureAggregates(selector: (group: any) => any): AggregateCaptureResult {
    let unsupported = false;

    const group = new Proxy({} as any, {
        get(_target, prop) {
            if (prop === "then") return undefined;
            if (typeof prop === "symbol") {
                unsupported = true;
                return undefined;
            }
            const name = String(prop) as AggregateFn;
            if (!AGGREGATE_FNS.includes(name)) {
                unsupported = true;
                return () => undefined;
            }
            return (inner?: (entity: any) => any) => {
                let path: string | undefined;
                if (typeof inner === "function") {
                    const captured = capture(inner);
                    if (captured.kind !== "property") {
                        unsupported = true;
                    } else {
                        path = captured.path;
                    }
                }
                return { [AGG]: true, fn: name, path };
            };
        },
    });

    let returned: any;
    try {
        returned = selector(group);
    } catch {
        return { kind: "opaque", reason: "computed" };
    }

    if (unsupported || !isPlainObject(returned)) {
        return { kind: "opaque", reason: "unsupported" };
    }

    const aggregates: Record<string, { fn: AggregateFn; path?: string }> = {};
    for (const [alias, value] of Object.entries(returned as Record<string, any>)) {
        if (!value || value[AGG] !== true) {
            return { kind: "opaque", reason: "unsupported" };
        }
        aggregates[alias] = value.path === undefined ? { fn: value.fn } : { fn: value.fn, path: value.path };
    }

    if (Object.keys(aggregates).length === 0) {
        return { kind: "opaque", reason: "unsupported" };
    }
    return { kind: "aggregates", aggregates };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/unit/PropertyCapture.test.ts --coverage=false`
Expected: PASS, all cases.

Note on the `[u.name]` array case: `isPlainObject` rejects arrays, so it falls through to `unsupported`. Note on `JSON.stringify(u.name)`: `stringify` reads `toJSON`, which trips `coerced`.

- [ ] **Step 5: Lint and commit**

```bash
npm run lint
git add src/core/expressions/PropertyCapture.ts test/unit/PropertyCapture.test.ts
git commit -m "feat: add Proxy-based property capture for lambda selectors"
```

---

## Task 4: Route include/sum/average/min/max through PropertyCapture

**Files:**
- Modify: `src/core/query/DbSet.ts` (the `include`, `sum`, `average`, `min`, `max` methods), `src/core/query/QueryBuilder.ts` (`include`, and its aggregate methods), `src/core/utils.ts`
- Test: `test/unit/PropertyCapture.test.ts` (append)

**Interfaces:**
- Consumes: `capture` from Task 3.
- Produces: `resolveColumn(selector, entityType, apiName): string` exported from `src/core/expressions/PropertyCapture.ts` — returns the **column name**, throwing on opaque or unknown property.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/PropertyCapture.test.ts`:

```ts
import "reflect-metadata";
import { resolveColumn } from '../../src/core/expressions/PropertyCapture';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

@Entity('capture_orders')
class CapOrder {
    @PrimaryKey() id!: number;
    @Column({ name: 'total_amount' }) total!: number;
}

describe('resolveColumn', () => {
    it('resolves a property selector to its column name', () => {
        expect(resolveColumn((o: any) => o.total, CapOrder, 'sum')).toBe('total_amount');
    });

    it('throws naming the API and property when the property is unknown', () => {
        expect(() => resolveColumn((o: any) => o.missing, CapOrder, 'sum'))
            .toThrow(/sum.*missing/);
    });

    it('throws a Phase-2 message for nested access', () => {
        expect(() => resolveColumn((o: any) => o.customer.name, CapOrder, 'include'))
            .toThrow(/nested/i);
    });

    it('throws for a computed selector', () => {
        expect(() => resolveColumn((o: any) => o.total * 2, CapOrder, 'sum'))
            .toThrow(/single column/i);
    });
});
```

Verify the `@Column({ name: 'total_amount' })` option name first: `grep -n "name" src/decorators/index.ts | head -20`. If the decorator uses a different key for an explicit column name, use the real one.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/unit/PropertyCapture.test.ts -t resolveColumn --coverage=false`
Expected: FAIL — `resolveColumn is not a function`.

- [ ] **Step 3: Implement `resolveColumn`**

Append to `src/core/expressions/PropertyCapture.ts`:

```ts
import { MetadataStorage } from "../MetadataStorage";

/**
 * Resolve a single-property selector to a database column name.
 * Used by APIs that require exactly one column and have no in-memory fallback:
 * include, sum, average, min, max.
 */
export function resolveColumn(
    selector: (entity: any) => any,
    entityType: new (...args: any[]) => any,
    apiName: string
): string {
    const result = capture(selector);

    if (result.kind === "opaque") {
        if (result.reason === "nested") {
            throw new Error(
                `${apiName}() does not support nested property access; ` +
                `related-path selectors arrive in rnxORM 3.0`
            );
        }
        throw new Error(`${apiName}() requires a selector that names a single column, e.g. x => x.total`);
    }

    if (result.kind !== "property") {
        throw new Error(`${apiName}() requires a selector that names a single column, e.g. x => x.total`);
    }

    const metadata = MetadataStorage.get().getEntity(entityType);
    const column = metadata?.columns.find(c => c.propertyName === result.path);
    if (!column) {
        throw new Error(`${apiName}(): property '${result.path}' is not a mapped column on ${entityType.name}`);
    }
    return column.columnName;
}
```

`resolvePropertyName` is not needed separately — `include` looks relations up by property name, so add a sibling that stops before the column lookup:

```ts
/** Resolve a selector to its entity property name (for relations, which are not columns). */
export function resolvePropertyName(selector: (entity: any) => any, apiName: string): string {
    const result = capture(selector);
    if (result.kind === "property") return result.path;
    if (result.kind === "opaque" && result.reason === "nested") {
        throw new Error(
            `${apiName}() does not support nested property access; ` +
            `related-path selectors arrive in rnxORM 3.0`
        );
    }
    throw new Error(`${apiName}() requires a selector that names a single property, e.g. x => x.author`);
}
```

- [ ] **Step 4: Replace every `extractPropertyName` call site**

Run `grep -rn "extractPropertyName" src/` to list them. In `src/core/query/DbSet.ts` and `src/core/query/QueryBuilder.ts`:

- `include(relation)` → `const propertyName = resolvePropertyName(relation, 'include');`
- `sum`, `average`, `min`, `max` → replace the `extractPropertyName` + manual column lookup + `throw new Error(\`Property ${propertyName} not found\`)` block with a single `const column = resolveColumn(selector, this.entityType, 'sum');` (using each method's own name).

Then delete `extractPropertyName` from `src/core/utils.ts`. If that leaves the file empty, delete the file and remove its imports.

- [ ] **Step 5: Verify no toString parsing remains for these paths**

```bash
npx jest test/unit/PropertyCapture.test.ts --coverage=false
npm test 2>&1 | tail -20
grep -rn "toString()" src/ | grep -v "\.toString()\s*$" || echo "no toString parsing in src"
```

Expected: PropertyCapture tests pass; the full suite still passes at the Task 2 baseline; remaining `toString()` hits are only in `SelectQueryBuilder`/`GroupedQueryBuilder`, which Task 5 removes.

- [ ] **Step 6: Commit**

```bash
npm run lint
git add src/core/expressions/PropertyCapture.ts src/core/query/ src/core/utils.ts test/unit/PropertyCapture.test.ts
git commit -m "refactor: resolve include/aggregate selectors via property capture

Replaces regex-based extractPropertyName. Unknown properties and nested
paths now fail with actionable errors instead of a regex miss."
```

---

## Task 5: Route select/groupBy projections through PropertyCapture

**Files:**
- Modify: `src/core/query/SelectQueryBuilder.ts` (replaces `extractProjectedColumns`, formerly `DbSet.ts:1036-1100`), `src/core/query/GroupedQueryBuilder.ts` (replaces the regex at former `DbSet.ts:1350` and `:1442`)
- Test: `test/unit/SqlGeneration.test.ts` (append)

**Interfaces:**
- Consumes: `capture`, `captureAggregates` from Task 3.
- Produces: no new exports. `select()` emits `SELECT col AS alias, ...` when capture succeeds and falls back to `SELECT *` plus in-memory projection when it returns `opaque`.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/SqlGeneration.test.ts`:

```ts
describe('projection SQL from captured selectors', () => {
    it.each(['postgresql', 'mariadb', 'mssql'] as const)(
        'projects an object literal to explicit columns on %s',
        async (dialect) => {
            const { db, provider } = makeDb(dialect);
            await db.set(SgUser).select(u => ({ n: u.name, a: u.age })).toList();
            expect(provider.lastCall!.sql).toBe('SELECT name AS n, age AS a FROM sqlgen_users');
        }
    );

    it('projects a single property to one column', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).select(u => u.name).toList();
        expect(provider.lastCall!.sql).toBe('SELECT name FROM sqlgen_users');
    });

    it('falls back to SELECT * for a computed projection', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ id: 1, name: 'ada', age: 30 }], rowCount: 1 });
        const rows = await db.set(SgUser).select(u => `${u.name}!`).toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_users');
        expect(rows).toEqual(['ada!']);
    });

    it('survives a minified-style parameter name', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).select((a: any) => ({ n: a.name })).toList();
        expect(provider.lastCall!.sql).toBe('SELECT name AS n FROM sqlgen_users');
    });

    it('throws when a projected property is not a mapped column', async () => {
        const { db } = makeDb('postgresql');
        await expect(db.set(SgUser).select((u: any) => ({ x: u.nope })).toList())
            .rejects.toThrow(/nope/);
    });
});
```

Before writing the expected SQL strings, run the existing suite and read the current `SELECT` shape (`grep -n "SELECT" src/core/query/SelectQueryBuilder.ts`) so spacing matches exactly — these are exact-string assertions.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/unit/SqlGeneration.test.ts -t "captured selectors" --coverage=false`
Expected: FAIL — current regex path produces `SELECT *` or mis-aliased columns.

- [ ] **Step 3: Implement in SelectQueryBuilder**

Replace the whole `extractProjectedColumns` method body with capture-driven resolution:

```ts
private extractProjectedColumns(): string[] | null {
    const result = capture(this.selector as (entity: any) => any);
    if (result.kind === "opaque") {
        // Honest fallback: the selector computes something SQL cannot express,
        // so fetch full rows and project in memory.
        return null;
    }

    const metadata = MetadataStorage.get().getEntity(this.entityType);
    const columnFor = (propertyName: string): string => {
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) {
            throw new Error(
                `select(): property '${propertyName}' is not a mapped column on ${this.entityType.name}`
            );
        }
        return column.columnName;
    };

    if (result.kind === "property") {
        return [columnFor(result.path)];
    }

    return Object.entries(result.aliases).map(
        ([alias, propertyName]) => `${columnFor(propertyName)} AS ${alias}`
    );
}
```

The behavior change worth noting: an unknown property now **throws** instead of returning `null` and silently degrading. That is the point — the test above asserts it.

- [ ] **Step 4: Implement in GroupedQueryBuilder**

Replace the two regex sites. The key selector uses `capture` (accepting `property` for a single grouping key and `projection` for a composite key); the result selector uses `captureAggregates`, mapping each entry to SQL:

```ts
const AGG_SQL: Record<string, (col?: string) => string> = {
    count: () => "COUNT(*)",
    sum: (col?: string) => `SUM(${col})`,
    avg: (col?: string) => `AVG(${col})`,
    min: (col?: string) => `MIN(${col})`,
    max: (col?: string) => `MAX(${col})`,
};
```

For each captured aggregate `{ alias, fn, path }`, emit `${AGG_SQL[fn](path && columnFor(path))} AS ${alias}`. When `captureAggregates` returns `opaque`, keep the existing in-memory grouping path unchanged.

- [ ] **Step 5: Verify**

```bash
npx jest test/unit/SqlGeneration.test.ts --coverage=false
npm test 2>&1 | tail -20
grep -rn "\.toString()" src/ || echo "OK: no Function.toString parsing remains in src/"
```

Expected: new tests pass; full suite at baseline; the grep prints the OK line. **This satisfies spec success criterion 2.**

- [ ] **Step 6: Commit**

```bash
npm run lint
git add src/core/query/ test/unit/SqlGeneration.test.ts
git commit -m "refactor: drive select/groupBy projections from property capture

Removes the last Function.prototype.toString() parsing in src/. Column
pruning now works under minification; uncapturable selectors fall back to
in-memory projection explicitly instead of by accident."
```

---

## Task 6: Condition module

**Files:**
- Create: `src/core/expressions/Condition.ts`
- Test: `test/unit/Condition.test.ts`

**Interfaces:**
- Consumes: `ColumnMetadata`, `EntityMetadata` from `src/core/MetadataStorage`; `IDatabaseProvider.getParameterPlaceholder`.
- Produces:
  - `class Condition { readonly node: ConditionNode }`
  - `class ConditionBuilder` with `eq, ne, gt, gte, lt, lte, like, in, notIn, isNull, isNotNull, and, or, not`
  - `normalizeCondition(spec: ConditionSpec): Condition`
  - `compileCondition(condition: Condition, metadata: EntityMetadata, provider: IDatabaseProvider, paramOffset: number): { sql: string; params: any[] }`
  - `type ConditionSpec = Record<string, any> | Condition | ((c: ConditionBuilder) => Condition)`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/Condition.test.ts`:

```ts
import "reflect-metadata";
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';
import {
    Condition, ConditionBuilder, normalizeCondition, compileCondition,
} from '../../src/core/expressions/Condition';

@Entity('cond_users')
class CondUser {
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column() age!: number;
    @Column() isDeleted!: boolean;
    @Column() tags!: string[];
}

beforeAll(() => {
    const meta = MetadataStorage.get().getEntity(CondUser)!;
    const tags = meta.columns.find(c => c.propertyName === 'tags')!;
    tags.hasConversion = true;
    tags.convertToDb = (v: string[]) => v.join(',');
    tags.convertFromDb = (v: string) => String(v).split(',');
});

const meta = () => MetadataStorage.get().getEntity(CondUser)!;
const c = () => new ConditionBuilder();

function compile(cond: Condition, dialect: CaptureDialect = 'postgresql', offset = 0) {
    return compileCondition(cond, meta(), new SqlCaptureProvider(dialect), offset);
}

describe('object spec normalization', () => {
    it('compiles a single key to an equality test', () => {
        expect(compile(normalizeCondition({ isDeleted: false })))
            .toEqual({ sql: 'isDeleted = $1', params: [false] });
    });

    it('preserves falsy values', () => {
        expect(compile(normalizeCondition({ age: 0 })).params).toEqual([0]);
        expect(compile(normalizeCondition({ name: '' })).params).toEqual(['']);
    });

    it('ANDs multiple keys in declaration order', () => {
        expect(compile(normalizeCondition({ isDeleted: false, age: 30 })))
            .toEqual({ sql: '(isDeleted = $1 AND age = $2)', params: [false, 30] });
    });

    it('compiles null to IS NULL rather than = NULL', () => {
        expect(compile(normalizeCondition({ name: null })))
            .toEqual({ sql: 'name IS NULL', params: [] });
    });

    it('rejects undefined as ambiguous', () => {
        expect(() => normalizeCondition({ name: undefined })).toThrow(/undefined/);
    });

    it('rejects an unknown column, naming it', () => {
        expect(() => compile(normalizeCondition({ nope: 1 }))).toThrow(/nope/);
    });
});

describe('builder operators', () => {
    it.each([
        ['eq',  (b: ConditionBuilder) => b.eq('age', 30),  'age = $1'],
        ['ne',  (b: ConditionBuilder) => b.ne('age', 30),  'age <> $1'],
        ['gt',  (b: ConditionBuilder) => b.gt('age', 30),  'age > $1'],
        ['gte', (b: ConditionBuilder) => b.gte('age', 30), 'age >= $1'],
        ['lt',  (b: ConditionBuilder) => b.lt('age', 30),  'age < $1'],
        ['lte', (b: ConditionBuilder) => b.lte('age', 30), 'age <= $1'],
        ['like',(b: ConditionBuilder) => b.like('name', 'a%'), 'name LIKE $1'],
    ])('compiles %s', (_n, build, sql) => {
        expect(compile(build(c())).sql).toBe(sql);
    });

    it('compiles isNull / isNotNull without parameters', () => {
        expect(compile(c().isNull('name'))).toEqual({ sql: 'name IS NULL', params: [] });
        expect(compile(c().isNotNull('name'))).toEqual({ sql: 'name IS NOT NULL', params: [] });
    });

    it('compiles IN with one and many values', () => {
        expect(compile(c().in('age', [30]))).toEqual({ sql: 'age IN ($1)', params: [30] });
        expect(compile(c().in('age', [30, 40]))).toEqual({ sql: 'age IN ($1, $2)', params: [30, 40] });
    });

    it('compiles an empty IN to constant false, never IN ()', () => {
        expect(compile(c().in('age', []))).toEqual({ sql: '1 = 0', params: [] });
        expect(compile(c().notIn('age', []))).toEqual({ sql: '1 = 1', params: [] });
    });

    it('parenthesizes nested and/or', () => {
        const b = c();
        const cond = b.or(b.eq('age', 30), b.and(b.eq('name', 'ada'), b.eq('isDeleted', false)));
        expect(compile(cond).sql).toBe('(age = $1 OR (name = $2 AND isDeleted = $3))');
    });

    it('compiles not', () => {
        expect(compile(c().not(c().eq('age', 30))).sql).toBe('NOT (age = $1)');
    });

    it('applies the column value converter to bound values', () => {
        expect(compile(c().eq('tags', ['a', 'b'])).params).toEqual(['a,b']);
    });
});

describe('placeholders per dialect', () => {
    it('numbers postgres placeholders from the offset', () => {
        expect(compile(normalizeCondition({ isDeleted: false, age: 30 }), 'postgresql', 2))
            .toEqual({ sql: '(isDeleted = $3 AND age = $4)', params: [false, 30] });
    });

    it('numbers mssql placeholders from the offset', () => {
        expect(compile(normalizeCondition({ isDeleted: false, age: 30 }), 'mssql', 2))
            .toEqual({ sql: '(isDeleted = @p2 AND age = @p3)', params: [false, 30] });
    });

    it('emits positional ? for mariadb and keeps param order', () => {
        expect(compile(normalizeCondition({ isDeleted: false, age: 30 }), 'mariadb', 2))
            .toEqual({ sql: '(isDeleted = ? AND age = ?)', params: [false, 30] });
    });
});

describe('value types', () => {
    it('binds Date, bigint and Buffer without transformation', () => {
        const date = new Date('2026-01-01T00:00:00Z');
        expect(compile(c().eq('age', date)).params).toEqual([date]);
        expect(compile(c().eq('age', 10n)).params).toEqual([10n]);
        const buf = Buffer.from('x');
        expect(compile(c().eq('name', buf)).params).toEqual([buf]);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/unit/Condition.test.ts --coverage=false`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/core/expressions/Condition.ts`:

```ts
import { EntityMetadata } from "../MetadataStorage";
import { IDatabaseProvider } from "../../providers/IDatabaseProvider";

export type ComparisonOp = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "like";

export type ConditionNode =
    | { op: ComparisonOp; column: string; value: any }
    | { op: "in" | "notIn"; column: string; values: any[] }
    | { op: "isNull" | "isNotNull"; column: string }
    | { op: "and" | "or"; nodes: ConditionNode[] }
    | { op: "not"; node: ConditionNode };

export class Condition {
    constructor(public readonly node: ConditionNode) {}
}

export class ConditionBuilder {
    eq(column: string, value: any): Condition {
        return value === null ? this.isNull(column) : new Condition({ op: "eq", column, value });
    }
    ne(column: string, value: any): Condition {
        return value === null ? this.isNotNull(column) : new Condition({ op: "ne", column, value });
    }
    gt(column: string, value: any): Condition { return new Condition({ op: "gt", column, value }); }
    gte(column: string, value: any): Condition { return new Condition({ op: "gte", column, value }); }
    lt(column: string, value: any): Condition { return new Condition({ op: "lt", column, value }); }
    lte(column: string, value: any): Condition { return new Condition({ op: "lte", column, value }); }
    like(column: string, value: any): Condition { return new Condition({ op: "like", column, value }); }
    in(column: string, values: any[]): Condition { return new Condition({ op: "in", column, values }); }
    notIn(column: string, values: any[]): Condition { return new Condition({ op: "notIn", column, values }); }
    isNull(column: string): Condition { return new Condition({ op: "isNull", column }); }
    isNotNull(column: string): Condition { return new Condition({ op: "isNotNull", column }); }
    and(...conditions: Condition[]): Condition {
        return new Condition({ op: "and", nodes: conditions.map(c => c.node) });
    }
    or(...conditions: Condition[]): Condition {
        return new Condition({ op: "or", nodes: conditions.map(c => c.node) });
    }
    not(condition: Condition): Condition {
        return new Condition({ op: "not", node: condition.node });
    }
}

export type ConditionSpec =
    | Record<string, any>
    | Condition
    | ((builder: ConditionBuilder) => Condition);

/** Turn any accepted filter form into a Condition. Object keys are ANDed in declaration order. */
export function normalizeCondition(spec: ConditionSpec): Condition {
    if (spec instanceof Condition) return spec;

    if (typeof spec === "function") {
        const result = spec(new ConditionBuilder());
        if (!(result instanceof Condition)) {
            throw new Error("Condition callback must return a Condition built from the supplied builder");
        }
        return result;
    }

    const builder = new ConditionBuilder();
    const parts: Condition[] = [];
    for (const [column, value] of Object.entries(spec)) {
        if (value === undefined) {
            throw new Error(
                `Filter for '${column}' is undefined, which is ambiguous. ` +
                `Use null for an IS NULL test, or omit the key entirely.`
            );
        }
        parts.push(Array.isArray(value) ? builder.in(column, value) : builder.eq(column, value));
    }
    if (parts.length === 0) {
        throw new Error("A condition must constrain at least one column");
    }
    return parts.length === 1 ? parts[0] : builder.and(...parts);
}

const OPERATOR_SQL: Record<ComparisonOp, string> = {
    eq: "=", ne: "<>", gt: ">", gte: ">=", lt: "<", lte: "<=", like: "LIKE",
};

/**
 * Compile a Condition to a parameterized SQL fragment.
 * `paramOffset` is the number of parameters already bound by the caller, so
 * filter parameters compose correctly with user-supplied where() parameters.
 */
export function compileCondition(
    condition: Condition,
    metadata: EntityMetadata,
    provider: IDatabaseProvider,
    paramOffset: number
): { sql: string; params: any[] } {
    const params: any[] = [];

    const resolve = (propertyName: string) => {
        const column = metadata.columns.find(c => c.propertyName === propertyName);
        if (!column) {
            throw new Error(
                `Query filter references '${propertyName}', which is not a mapped column on ${metadata.tableName}`
            );
        }
        return column;
    };

    const bind = (column: ReturnType<typeof resolve>, value: any): string => {
        const bound = column.hasConversion && column.convertToDb ? column.convertToDb(value) : value;
        params.push(bound);
        return provider.getParameterPlaceholder(paramOffset + params.length);
    };

    const emit = (node: ConditionNode): string => {
        switch (node.op) {
            case "and":
            case "or": {
                if (node.nodes.length === 0) return node.op === "and" ? "1 = 1" : "1 = 0";
                if (node.nodes.length === 1) return emit(node.nodes[0]);
                const joiner = node.op === "and" ? " AND " : " OR ";
                return `(${node.nodes.map(emit).join(joiner)})`;
            }
            case "not":
                return `NOT (${emit(node.node)})`;
            case "isNull":
                return `${resolve(node.column).columnName} IS NULL`;
            case "isNotNull":
                return `${resolve(node.column).columnName} IS NOT NULL`;
            case "in":
            case "notIn": {
                const column = resolve(node.column);
                // IN () is a syntax error on all three engines.
                if (node.values.length === 0) return node.op === "in" ? "1 = 0" : "1 = 1";
                const list = node.values.map(v => bind(column, v)).join(", ");
                return `${column.columnName} ${node.op === "in" ? "IN" : "NOT IN"} (${list})`;
            }
            default: {
                const column = resolve(node.column);
                return `${column.columnName} ${OPERATOR_SQL[node.op]} ${bind(column, node.value)}`;
            }
        }
    };

    return { sql: emit(condition.node), params };
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx jest test/unit/Condition.test.ts --coverage=false`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/core/expressions/Condition.ts test/unit/Condition.test.ts
git commit -m "feat: add declarative condition spec and SQL compiler"
```

---

## Task 7: hasQueryFilter accepts a condition, with a legacy probe

**Files:**
- Modify: `src/core/MetadataStorage.ts:92`, `src/core/ModelBuilder.ts:526`, `src/index.ts`
- Test: `test/unit/ModelBuilder.test.ts` (append)

**Interfaces:**
- Consumes: `Condition`, `ConditionBuilder`, `normalizeCondition` from Task 6.
- Produces: `EntityMetadata.queryFilter?: Condition` and `EntityMetadata.legacyQueryFilter?: (entity: any) => boolean`. Task 8 reads both.

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/ModelBuilder.test.ts`:

```ts
import { Condition, ConditionBuilder } from '../../src/core/expressions/Condition';

describe('hasQueryFilter API forms', () => {
    it('accepts an object spec and stores a Condition', () => {
        // Use a fresh entity per test; replace FilterUser with a locally declared entity.
        const meta = MetadataStorage.get().getEntity(FilterUser)!;
        new ModelBuilder().entity(FilterUser).hasQueryFilter({ isDeleted: false });
        expect(meta.queryFilter).toBeInstanceOf(Condition);
        expect(meta.legacyQueryFilter).toBeUndefined();
    });

    it('accepts a builder callback', () => {
        const meta = MetadataStorage.get().getEntity(FilterUser)!;
        new ModelBuilder().entity(FilterUser).hasQueryFilter((c: ConditionBuilder) => c.eq('isDeleted', false));
        expect(meta.queryFilter).toBeInstanceOf(Condition);
        expect(meta.legacyQueryFilter).toBeUndefined();
    });

    it('accepts a legacy predicate and stores it separately', () => {
        const meta = MetadataStorage.get().getEntity(FilterUser)!;
        new ModelBuilder().entity(FilterUser).hasQueryFilter((u: any) => u.isDeleted === false);
        expect(meta.queryFilter).toBeUndefined();
        expect(typeof meta.legacyQueryFilter).toBe('function');
    });

    it('warns once per entity for the legacy form, not once per call', () => {
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        const builder = new ModelBuilder();
        builder.entity(FilterUser).hasQueryFilter((u: any) => u.isDeleted === false);
        builder.entity(FilterUser).hasQueryFilter((u: any) => u.isDeleted === false);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('does not throw when probing a legacy predicate that dereferences properties', () => {
        expect(() => new ModelBuilder().entity(FilterUser)
            .hasQueryFilter((u: any) => u.nested.deep.value === 1)).not.toThrow();
    });
});
```

Declare `FilterUser` alongside the file's existing test entities, following the pattern already in `test/unit/ModelBuilder.test.ts`, and reset `queryFilter`/`legacyQueryFilter` in a `beforeEach` so the cases stay independent.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/unit/ModelBuilder.test.ts -t "hasQueryFilter API forms" --coverage=false`
Expected: FAIL — `queryFilter` is a function, not a `Condition`.

- [ ] **Step 3: Widen the metadata**

In `src/core/MetadataStorage.ts`, replace line 92 with:

```ts
    queryFilter?: Condition;                        // Declarative global filter, compiled into WHERE
    legacyQueryFilter?: (entity: any) => boolean;   // Deprecated 2.2.0: in-memory predicate, removed in 3.0
    legacyQueryFilterWarned?: boolean;              // Ensures the deprecation warning fires once per entity
```

and add `import { Condition } from "./expressions/Condition";` at the top.

- [ ] **Step 4: Implement the probe in ModelBuilder**

Replace `hasQueryFilter` at `src/core/ModelBuilder.ts:526`:

```ts
    /**
     * Defines a global query filter applied to every read of this entity.
     *
     * @example
     * modelBuilder.entity(User).hasQueryFilter({ isDeleted: false });
     * modelBuilder.entity(Order).hasQueryFilter(c => c.eq('tenantId', currentTenantId));
     *
     * @remarks
     * Passing a plain predicate (`u => u.isDeleted === false`) is deprecated as of
     * 2.2.0 and will be removed in 3.0. Predicates are evaluated in memory after the
     * database has already paginated, so filtered pages and counts are inaccurate.
     */
    hasQueryFilter(spec: ConditionSpec): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return this;

        if (typeof spec !== "function") {
            metadata.queryFilter = normalizeCondition(spec);
            metadata.legacyQueryFilter = undefined;
            return this;
        }

        // Both the new builder callback and the legacy predicate are functions.
        // Probe: invoke with a ConditionBuilder. The new form returns a Condition;
        // a legacy predicate returns a boolean (or throws while dereferencing).
        let probed: unknown;
        try {
            probed = (spec as (builder: ConditionBuilder) => unknown)(new ConditionBuilder());
        } catch {
            probed = undefined;
        }

        if (probed instanceof Condition) {
            metadata.queryFilter = probed;
            metadata.legacyQueryFilter = undefined;
            return this;
        }

        if (!metadata.legacyQueryFilterWarned) {
            metadata.legacyQueryFilterWarned = true;
            console.warn(
                `[rnxORM] hasQueryFilter() received a predicate for ${this.entityType.name}. ` +
                `Predicate filters run in memory after pagination, so filtered pages and count() ` +
                `are inaccurate. Switch to a condition spec — hasQueryFilter({ isDeleted: false }) ` +
                `— which compiles into the SQL WHERE clause. Predicates are removed in rnxORM 3.0.`
            );
        }
        metadata.legacyQueryFilter = spec as (entity: any) => boolean;
        metadata.queryFilter = undefined;
        return this;
    }
```

The probe is safe: a legacy predicate reading `u.isDeleted` off a `ConditionBuilder` yields `undefined === false` → `false`, and a deeper dereference throws into the `catch`. Import `Condition`, `ConditionBuilder`, `ConditionSpec`, and `normalizeCondition` at the top of the file.

- [ ] **Step 5: Export the public condition API**

Add to `src/index.ts`:

```ts
export { Condition, ConditionBuilder } from "./core/expressions/Condition";
export type { ConditionSpec, ConditionNode } from "./core/expressions/Condition";
```

- [ ] **Step 6: Verify**

```bash
npx jest test/unit/ModelBuilder.test.ts --coverage=false
npm run build
```

Expected: PASS; build clean. The full suite will show failures in filter-behavior tests that assert the old in-memory path — leave them for Task 8, which is where that behavior changes.

- [ ] **Step 7: Commit**

```bash
npm run lint
git add src/core/MetadataStorage.ts src/core/ModelBuilder.ts src/index.ts test/unit/ModelBuilder.test.ts
git commit -m "feat: hasQueryFilter accepts condition specs, deprecates predicates

Object and builder forms compile to SQL. Legacy predicates keep working
behind a one-time deprecation warning; removed in 3.0."
```

---

## Task 8: Push query filters into the SQL WHERE clause

The core correctness fix. Defects 1 and 2 close together because every read path stops owning filter logic.

**Files:**
- Create: `src/core/query/QueryFilter.ts`
- Modify: `src/core/query/DbSet.ts` (`toList`, `find`, `count`, `sum`, `average`, `min`, `max`), `src/core/query/QueryBuilder.ts` (`toList`, `count`, `all`), `src/core/query/SelectQueryBuilder.ts`, `src/core/query/GroupedQueryBuilder.ts`
- Test: `test/unit/QueryFilterPushdown.test.ts` (create)

**Interfaces:**
- Consumes: `compileCondition` (Task 6), `EntityMetadata.queryFilter` / `legacyQueryFilter` (Task 7).
- Produces: `applyQueryFilter(options): { sql: string; params: any[]; legacyPredicate?: (e: any) => boolean }` from `src/core/query/QueryFilter.ts`.

- [ ] **Step 1: Write the failing regression tests**

Create `test/unit/QueryFilterPushdown.test.ts`:

```ts
import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

@Entity('pd_users')
class PdUser {
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column() age!: number;
    @Column() isDeleted!: boolean;
}

beforeEach(() => {
    const meta = MetadataStorage.get().getEntity(PdUser)!;
    meta.queryFilter = undefined;
    meta.legacyQueryFilter = undefined;
    meta.legacyQueryFilterWarned = false;
    new ModelBuilder().entity(PdUser).hasQueryFilter({ isDeleted: false });
});

function makeDb(dialect: CaptureDialect = 'postgresql') {
    const provider = new SqlCaptureProvider(dialect);
    return { provider, db: new DbContext(provider) };
}

describe('filter reaches the WHERE clause before pagination', () => {
    it('emits the filter in SQL and paginates the filtered set', async () => {
        const { db, provider } = makeDb();
        await db.set(PdUser).orderBy('name').skip(2).take(2).toList();
        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM pd_users WHERE isDeleted = $1 ORDER BY name ASC LIMIT 2 OFFSET 2'
        );
        expect(provider.lastCall!.params).toEqual([false]);
    });

    it('ANDs the filter with a user where(), numbering parameters in order', async () => {
        const { db, provider } = makeDb();
        await db.set(PdUser).where('age', '>', 18).toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM pd_users WHERE age > $1 AND isDeleted = $2');
        expect(provider.lastCall!.params).toEqual([18, false]);
    });

    it('keeps parameter order for positional mariadb placeholders', async () => {
        const { db, provider } = makeDb('mariadb');
        await db.set(PdUser).where('age', '>', 18).toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM pd_users WHERE age > ? AND isDeleted = ?');
        expect(provider.lastCall!.params).toEqual([18, false]);
    });

    it('filters count() so it agrees with toList()', async () => {
        const { db, provider } = makeDb();
        await db.set(PdUser).where('age', '>', 18).count();
        expect(provider.lastCall!.sql).toBe(
            'SELECT COUNT(*) as count FROM pd_users WHERE age > $1 AND isDeleted = $2'
        );
        expect(provider.lastCall!.params).toEqual([18, false]);
    });

    it.each(['sum', 'average', 'min', 'max'] as const)('filters %s()', async (fn) => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ result: 0 }], rowCount: 1 });
        await (db.set(PdUser) as any)[fn]((u: any) => u.age);
        expect(provider.lastCall!.sql).toContain('WHERE isDeleted = $1');
    });

    it('filters find() in SQL', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 0 });
        await db.set(PdUser).find(1);
        expect(provider.lastCall!.sql).toContain('isDeleted');
    });

    it('filters projections and grouped queries', async () => {
        const { db, provider } = makeDb();
        await db.set(PdUser).select(u => ({ n: u.name })).toList();
        expect(provider.lastCall!.sql).toContain('WHERE isDeleted = $1');

        await db.set(PdUser).groupBy(u => u.age).toList();
        expect(provider.lastCall!.sql).toContain('WHERE isDeleted = $1');
    });
});

describe('ignoreQueryFilters', () => {
    it('drops the filter from toList', async () => {
        const { db, provider } = makeDb();
        await db.set(PdUser).ignoreQueryFilters().toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM pd_users');
    });

    it('drops the filter from count', async () => {
        const { db, provider } = makeDb();
        await db.set(PdUser).ignoreQueryFilters().count();
        expect(provider.lastCall!.sql).toBe('SELECT COUNT(*) as count FROM pd_users ');
    });
});

describe('legacy predicate filters still work in memory', () => {
    beforeEach(() => {
        const meta = MetadataStorage.get().getEntity(PdUser)!;
        meta.queryFilter = undefined;
        meta.legacyQueryFilter = undefined;
        meta.legacyQueryFilterWarned = true; // suppress the warning in this block
        new ModelBuilder().entity(PdUser).hasQueryFilter((u: any) => u.isDeleted === false);
    });

    it('emits no filter SQL but filters the materialized rows', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, name: 'ada', age: 30, isDeleted: false },
                { id: 2, name: 'bob', age: 31, isDeleted: true },
            ],
            rowCount: 2,
        });
        const rows = await db.set(PdUser).toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM pd_users');
        expect(rows.map(r => r.name)).toEqual(['ada']);
    });
});
```

The exact expected strings for the `ignoreQueryFilters` cases (note the trailing space in the `count` form) come from the current generator. Run each assertion once and paste the observed string if it differs by whitespace — these tests exist to pin filter behavior, not to reformat SQL.

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/unit/QueryFilterPushdown.test.ts --coverage=false`
Expected: FAIL — filters are absent from every generated statement.

- [ ] **Step 3: Implement the shared helper**

Create `src/core/query/QueryFilter.ts`:

```ts
import { EntityMetadata } from "../MetadataStorage";
import { IDatabaseProvider } from "../../providers/IDatabaseProvider";
import { compileCondition } from "../expressions/Condition";

export interface QueryFilterResult {
    /** SQL fragment to AND into the WHERE clause, or undefined when there is nothing to add. */
    sql?: string;
    /** Parameters for the fragment, in emission order. */
    params: any[];
    /** Deprecated in-memory predicate, when the model still uses one. */
    legacyPredicate?: (entity: any) => boolean;
}

/**
 * Resolve the global query filter for an entity into a WHERE fragment.
 *
 * `paramOffset` must be the number of parameters the caller has already bound,
 * so placeholder numbering (postgres/mssql) and positional order (mariadb) stay
 * consistent with the params array.
 */
export function applyQueryFilter(
    metadata: EntityMetadata | undefined,
    provider: IDatabaseProvider,
    paramOffset: number,
    ignore: boolean
): QueryFilterResult {
    if (!metadata || ignore) return { params: [] };

    if (metadata.queryFilter) {
        const { sql, params } = compileCondition(metadata.queryFilter, metadata, provider, paramOffset);
        return { sql, params };
    }

    if (metadata.legacyQueryFilter) {
        return { params: [], legacyPredicate: metadata.legacyQueryFilter };
    }

    return { params: [] };
}
```

- [ ] **Step 4: Wire every read path**

In each read path, immediately before the WHERE clause is assembled:

```ts
const filter = applyQueryFilter(
    MetadataStorage.get().getEntity(this.entityType),
    this.context.getProvider(),
    this.params.length,
    this.ignoreFilters
);
if (filter.sql) {
    this.conditions.push(filter.sql);
    this.params.push(...filter.params);
}
```

then, after rows are materialized:

```ts
return filter.legacyPredicate ? entities.filter(filter.legacyPredicate) : entities;
```

Apply this in `QueryBuilder.toList`, `QueryBuilder.count`, `DbSet.toList`, `DbSet.count`, `DbSet.sum/average/min/max`, `DbSet.find`, `SelectQueryBuilder`, and `GroupedQueryBuilder`. **Delete** every remaining `metadata.queryFilter` reference — `grep -rn "metadata.queryFilter\|\.queryFilter(" src/core/query/` must come back empty except inside `QueryFilter.ts`.

For paths that build a fresh condition array rather than reusing `this.conditions` (`DbSet.count`, the aggregates, `find`), push the fragment into that local array and its params into the local params array in the same order.

`DbSet` methods that have no `ignoreFilters` flag pass `false`.

- [ ] **Step 5: Verify the correctness fix**

```bash
npx jest test/unit/QueryFilterPushdown.test.ts --coverage=false
npm test 2>&1 | tail -30
```

Expected: the pushdown suite passes. Some pre-existing filter tests in `test/unit/ModelBuilder.test.ts` assert the old in-memory behavior against a mock that returns unfiltered rows — those must now be updated to expect SQL-level filtering, since the behavior they pinned was the bug. Update them; do not weaken the new assertions to match.

- [ ] **Step 6: Commit**

```bash
npm run lint
git add src/core/query/ test/unit/
git commit -m "fix: compile global query filters into the SQL WHERE clause

Filters were applied in memory after LIMIT/OFFSET, so filtered pages were
wrong and count() disagreed with toList(). Every read path now shares one
filter assembly. Legacy predicate filters keep their in-memory behavior."
```

---

## Task 9: Validate column names and operators

**Files:**
- Create: `src/core/query/Identifiers.ts`
- Modify: `src/core/query/QueryBuilder.ts` (`where`, `orderBy`, `orderByDescending`), `src/core/query/DbSet.ts` (`where`, `orderBy`, `orderByDescending`)
- Test: `test/unit/Injection.test.ts` (create)

**Interfaces:**
- Consumes: `MetadataStorage`.
- Produces: `assertColumn(name, entityType, apiName): string` (returns the resolved column name) and `assertOperator(op): string` from `src/core/query/Identifiers.ts`.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/Injection.test.ts`:

```ts
import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

@Entity('inj_users')
class InjUser {
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column() age!: number;
}

const db = () => new DbContext(new SqlCaptureProvider('postgresql'));

describe('column validation', () => {
    it('rejects an injected column name in where()', async () => {
        await expect(db().set(InjUser).where('name; DROP TABLE inj_users--', '=', 1).toList())
            .rejects.toThrow(/not a mapped column/);
    });

    it('rejects an unknown column in orderBy()', async () => {
        await expect(db().set(InjUser).orderBy('name; DROP TABLE inj_users--').toList())
            .rejects.toThrow(/not a mapped column/);
    });

    it('rejects an unknown column in orderByDescending()', async () => {
        await expect(db().set(InjUser).orderByDescending('nope').toList())
            .rejects.toThrow(/not a mapped column/);
    });

    it('accepts a valid column', async () => {
        const provider = new SqlCaptureProvider('postgresql');
        await new DbContext(provider).set(InjUser).where('age', '>', 18).toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM inj_users WHERE age > $1');
    });

    it('is case-sensitive: property names must match exactly', async () => {
        await expect(db().set(InjUser).where('AGE', '=', 1).toList())
            .rejects.toThrow(/not a mapped column/);
    });
});

describe('operator validation', () => {
    it('rejects an injected operator', async () => {
        await expect(db().set(InjUser).where('age', 'IS NOT NULL; DELETE FROM inj_users--', 1).toList())
            .rejects.toThrow(/operator/i);
    });

    it.each(['=', '!=', '<>', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE'])(
        'accepts the %s operator', async (op) => {
            const provider = new SqlCaptureProvider('postgresql');
            await new DbContext(provider).set(InjUser).where('age', op, 1).toList();
            expect(provider.lastCall!.sql).toBe(`SELECT * FROM inj_users WHERE age ${op} $1`);
        }
    );

    it('normalizes operator case', async () => {
        const provider = new SqlCaptureProvider('postgresql');
        await new DbContext(provider).set(InjUser).where('name', 'like', 'a%').toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM inj_users WHERE name LIKE $1');
    });

    it('still parameterizes values', async () => {
        const provider = new SqlCaptureProvider('postgresql');
        await new DbContext(provider).set(InjUser).where('name', '=', "'; DROP TABLE x--").toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM inj_users WHERE name = $1');
        expect(provider.lastCall!.params).toEqual(["'; DROP TABLE x--"]);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/unit/Injection.test.ts --coverage=false`
Expected: FAIL — the injected strings are concatenated into SQL instead of throwing.

- [ ] **Step 3: Implement**

Create `src/core/query/Identifiers.ts`:

```ts
import { MetadataStorage } from "../MetadataStorage";

const ALLOWED_OPERATORS = new Set([
    "=", "!=", "<>", ">", ">=", "<", "<=", "LIKE", "NOT LIKE", "IN", "NOT IN", "IS", "IS NOT",
]);

/**
 * Resolve a caller-supplied property name to its column name, rejecting
 * anything that is not a mapped column. Column names are interpolated into SQL
 * and can never be parameterized, so this is the only thing standing between a
 * caller-supplied identifier and the statement text.
 */
export function assertColumn(
    propertyName: string,
    entityType: new (...args: any[]) => any,
    apiName: string
): string {
    const metadata = MetadataStorage.get().getEntity(entityType);
    const column = metadata?.columns.find(
        c => c.propertyName === propertyName || c.columnName === propertyName
    );
    if (!column) {
        throw new Error(
            `${apiName}(): '${propertyName}' is not a mapped column on ${entityType.name}`
        );
    }
    return column.columnName;
}

/** Validate a comparison operator against a fixed allow-list. */
export function assertOperator(operator: string, apiName = "where"): string {
    const normalized = String(operator).trim().toUpperCase();
    if (!ALLOWED_OPERATORS.has(normalized)) {
        throw new Error(
            `${apiName}(): unsupported operator '${operator}'. ` +
            `Allowed: ${[...ALLOWED_OPERATORS].join(", ")}`
        );
    }
    // Preserve the conventional spelling of symbolic operators.
    return /^[A-Z ]+$/.test(normalized) ? normalized : operator.trim();
}
```

In `QueryBuilder.where`:

```ts
where(column: string, operator: string, value: any): this {
    const resolved = assertColumn(column, this.entityType, "where");
    const op = assertOperator(operator);
    const provider = this.context.getProvider();
    const placeholder = provider.getParameterPlaceholder(this.params.length + 1);
    this.conditions.push(`${resolved} ${op} ${placeholder}`);
    this.params.push(value);
    return this;
}
```

In `orderBy` / `orderByDescending`, replace the raw push with
`this.orderByColumns.push({ column: assertColumn(column, this.entityType, "orderBy"), direction: "ASC" });`
(and `"DESC"` / `"orderByDescending"` respectively). Mirror all three in `DbSet`, which delegates to `QueryBuilder` — confirm with `grep -n "where\|orderBy" src/core/query/DbSet.ts` that delegation is complete, and if any method builds SQL itself, validate there too.

Note the tests expect the error at `await` time for `DbSet.where(...)` chains but the throw happens synchronously inside the chain — `rejects.toThrow` still passes because the expression is evaluated inside the async assertion. If a case fails for that reason, switch that assertion to `expect(() => ...).toThrow(...)`.

- [ ] **Step 4: Verify**

```bash
npx jest test/unit/Injection.test.ts --coverage=false
npm test 2>&1 | tail -20
```

Expected: PASS. Existing tests that call `where('age', '>', 18)` on mapped columns are unaffected. If any existing test uses an unmapped column name, that test was relying on the hole — fix the test to use a real column.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/core/query/Identifiers.ts src/core/query/ test/unit/Injection.test.ts
git commit -m "fix: validate column names and operators before SQL interpolation

where() and orderBy() concatenated caller-supplied identifiers straight
into the statement. Columns now resolve through entity metadata and
operators through an allow-list."
```

---

## Task 10: Harden all() and document the remaining limitation

**Files:**
- Modify: `src/core/query/QueryBuilder.ts` (`all`)
- Test: `test/unit/QueryFilterPushdown.test.ts` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change. `all()` stops tracking the rows it materializes.

- [ ] **Step 1: Write the failing test**

Append to `test/unit/QueryFilterPushdown.test.ts`:

```ts
describe('all()', () => {
    it('evaluates the predicate without tracking the scanned rows', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, name: 'ada', age: 30, isDeleted: false },
                { id: 2, name: 'bob', age: 40, isDeleted: false },
            ],
            rowCount: 2,
        });

        const result = await db.set(PdUser).where('age', '>', 18).all(u => u.age > 20);

        expect(result).toBe(true);
        expect(db.getChangeTracker().getEntries().length).toBe(0);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx jest test/unit/QueryFilterPushdown.test.ts -t "all()" --coverage=false`
Expected: FAIL — the change tracker holds 2 entries because `all()` calls `toList()` on a tracking query.

- [ ] **Step 3: Implement**

In `QueryBuilder.all`:

```ts
    /**
     * Check whether every matching row satisfies a predicate.
     *
     * @remarks
     * The predicate is a JavaScript function, so it cannot be translated to SQL:
     * this materializes every matching row and evaluates them in memory. On a
     * large table, constrain the query with where() first. A SQL-translatable
     * form arrives with the typed predicate API in rnxORM 3.0.
     */
    async all(predicate: (entity: T) => boolean): Promise<boolean> {
        const results = await this.asNoTracking().toList();
        return results.every(predicate);
    }
```

Confirm `asNoTracking()` mutates and returns `this` (`grep -n "asNoTracking" -A4 src/core/query/QueryBuilder.ts`). If it returns a new builder, assign it: `const results = await this.asNoTracking().toList();` still works, but verify the flag actually reaches `toList`.

- [ ] **Step 4: Verify**

```bash
npx jest test/unit/QueryFilterPushdown.test.ts --coverage=false
npm test 2>&1 | tail -20
```

Expected: PASS at baseline or better.

- [ ] **Step 5: Commit**

```bash
npm run lint
git add src/core/query/QueryBuilder.ts test/unit/QueryFilterPushdown.test.ts
git commit -m "perf: stop tracking rows scanned by all()

Documents the full-table scan honestly; a SQL-translatable predicate
arrives with the typed API in 3.0."
```

---

## Task 11: Verify against real databases and prepare the release

**Files:**
- Modify: `CHANGELOG.md`, `README.md`, `TEST_SUMMARY.md`, `package.json`

**Interfaces:**
- Consumes: everything above.
- Produces: a tagged, documented 2.2.0.

- [ ] **Step 1: Full mock verification**

```bash
npm run build && npm run lint && npm test 2>&1 | tail -30
```

Expected: build clean, lint clean, all suites passing with a test count above the 216 baseline. Record the number.

- [ ] **Step 2: Real-database verification**

```bash
docker compose -f docker-compose.test.yml up -d --wait
npm run test:integration 2>&1 | tail -40
docker compose -f docker-compose.test.yml down -v
```

Expected: PASS against PostgreSQL 16, MariaDB 11, and SQL Server 2022. **This is the gate that matters** — the filter pushdown and placeholder-offset logic are exactly the kind of change the mock can agree with and a real engine reject. Do not proceed on a mock-only pass.

- [ ] **Step 3: Confirm every spec success criterion**

Run each and confirm:

```bash
grep -rn "\.toString()" src/ || echo "OK criterion 2: no Function.toString parsing"
grep -rn "metadata.queryFilter" src/core/query/ || echo "OK: filters only flow through QueryFilter.ts"
wc -l src/core/query/*.ts   # criterion 5: each under ~400 lines
```

Criterion 6 (no source changes needed to upgrade) is covered by the legacy-predicate tests in Task 7 and Task 8.

- [ ] **Step 4: Update the documentation**

`CHANGELOG.md` — add a 2.2.0 entry covering: query filters compiled into SQL (fixing filtered pagination and `count()`), Proxy-based selector capture replacing regex parsing, column/operator validation in `where()`/`orderBy()`, the `hasQueryFilter` predicate deprecation, and the `src/core/query/` split. Note explicitly that the release is non-breaking.

`README.md` — update the `hasQueryFilter` examples to the condition-spec form, and flip the feature-status markers that this release changed. Keep the honest ✅/⚠️/❌ convention already in the file. Add the known limitation: filters do not apply to eagerly loaded navigations.

`TEST_SUMMARY.md` — update the test count, add rows for the PropertyCapture, Condition, QueryFilterPushdown, Injection, and EntityMapper suites, and move the fixed items out of the "Remaining gaps" list. Leave the genuinely still-open gaps in place.

`package.json` — set `"version": "2.2.0"`.

- [ ] **Step 5: Commit and tag**

```bash
git add CHANGELOG.md README.md TEST_SUMMARY.md package.json
git commit -m "chore(release): 2.2.0"
git tag v2.2.0
```

Do not push or publish — leave that to the user.

---

## Self-Review

**Spec coverage:** PropertyCapture → Tasks 3–5. Condition module → Task 6. Filter push-down → Task 8. Mechanical split → Tasks 1–2. Defects 1–2 → Task 8; 3 → Task 5; 4 → Task 4; 5–6 → Task 9; 7 → Task 10; 8 → Task 2. Backward compatibility → Task 7. Test plan: capture edge cases → Task 3; condition compilation → Task 6; regression tests → Task 8; injection → Task 9; deprecation path → Task 7; refactor safety → Task 1. Non-goals are carried into Global Constraints. Success criteria → Task 11 Step 3.

**Known soft spots for the implementer:** exact-SQL assertions are written against the *expected* generator output; where whitespace differs from the current generator, paste the observed string rather than reformatting SQL (that is Phase 2's job). Several tasks direct a `grep` first because the split in Task 2 moves line numbers — the spec's `DbSet.ts:NNN` references are valid only against the pre-split file.
