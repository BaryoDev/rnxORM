import { MetadataStorage } from "../MetadataStorage";

const PATH = Symbol('rnxorm.capturePath');

export type OpaqueReason = 'computed' | 'nested' | 'unsupported';

export type CaptureResult =
    | { kind: 'property'; path: string }
    | { kind: 'projection'; aliases: Record<string, string> }
    | { kind: 'opaque'; reason: OpaqueReason };

export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

/**
 * One entry in a captured groupBy().select() result-selector object literal:
 * either an aggregate call (`g.sum(x => x.col)`, `g.count()`, ...) or a bare
 * `g.key` access naming the group's key column.
 */
export type AggregateSelectorEntry =
    | { fn: AggregateFn; path?: string }
    | { kind: 'key' };

export type AggregateCaptureResult =
    | { kind: 'aggregates'; aggregates: Record<string, AggregateSelectorEntry> }
    | { kind: 'opaque'; reason: OpaqueReason };

function pathOf(value: any): string | undefined {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
        return undefined;
    }
    const path = value[PATH];
    return typeof path === 'string' ? path : undefined;
}

function isPlainObject(value: any): boolean {
    return (
        value !== null &&
        typeof value === 'object' &&
        !Array.isArray(value) &&
        pathOf(value) === undefined
    );
}

interface Recorder {
    root: any;
    coerced: () => boolean;
    /** Total root property accesses, counting repeats (see capture). */
    accesses: () => number;
}

function createRecorder(): Recorder {
    let coerced = false;
    let accesses = 0;

    const marker = (path: string): any => {
        const base: any = function () {
            coerced = true;
        };
        return new Proxy(base, {
            get(_target, prop) {
                if (prop === PATH) return path;
                // Never let a marker look like a promise.
                if (prop === 'then') return undefined;
                // Any symbol access (Symbol.toPrimitive, Symbol.toStringTag) or an
                // explicit coercion hook means the lambda is computing something we
                // cannot represent as a column reference.
                if (typeof prop === 'symbol' || prop === 'toString' || prop === 'valueOf' || prop === 'toJSON') {
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
            if (prop === 'then') return undefined;
            if (typeof prop === 'symbol') {
                coerced = true;
                return undefined;
            }
            accesses++;
            return marker(String(prop));
        },
    });

    return { root, coerced: () => coerced, accesses: () => accesses };
}

/**
 * Result of re-running a selector against a root whose every property reads as
 * `undefined`. The "nullish probe" described in capture().
 */
interface NullishProbe {
    accesses: number;
    returned: any;
    threw: boolean;
}

function probeNullish(selector: (entity: any) => any): NullishProbe {
    const state = { accesses: 0 };
    const root = new Proxy({} as any, {
        get(_target, prop) {
            if (prop === 'then' || typeof prop === 'symbol') return undefined;
            state.accesses++;
            return undefined;
        },
    });

    try {
        // The selector must run before the count is read.
        const returned = selector(root);
        return { accesses: state.accesses, returned, threw: false };
    } catch {
        return { accesses: state.accesses, returned: undefined, threw: true };
    }
}

/** True when the probe's return value is what a faithful column selector produces. */
function probeReturnedOnlyUndefined(returned: any, aliases?: string[]): boolean {
    if (aliases === undefined) {
        return returned === undefined;
    }
    if (returned === null || typeof returned !== 'object') return false;
    const keys = Object.keys(returned);
    if (keys.length !== aliases.length || !aliases.every(a => keys.includes(a))) return false;
    return keys.every(k => (returned as any)[k] === undefined);
}

/**
 * Resolve a selector lambda to the column(s) it names, or report it opaque.
 *
 * A selector that *picks between* columns (`u => u.nickname || u.name`,
 * `u => u.a ?? u.b`, `u => flag ? u.a : u.b`) is not a column reference and must
 * not be silently resolved to whichever operand happened to be evaluated
 * (issue I2). Two independent signals catch those, because neither can alone:
 *
 * 1. **Root-access count.** A faithful selector performs exactly one root
 *    property access per marker it returns, so a bare return with more than one
 *    access. Or a projection with more accesses than alias entries. Is
 *    computing something. This is what catches ternaries and `&&`, whose
 *    condition operand costs an extra access. (Duplicate columns are fine:
 *    `{a: u.x, b: u.x}` is 2 accesses over 2 entries.)
 *
 * 2. **Nullish probe.** `||` and `??` short-circuit on their left operand, and a
 *    marker is always truthy and non-nullish, so the recorder never observes the
 *    right operand at all. No proxy trap can see it, and the access count is 1.
 *    Re-running the selector against a root whose properties all read
 *    `undefined` forces the other branch: any extra root access, any thrown
 *    error, or any returned value that is not `undefined` (respectively an
 *    object of exactly the same aliases all holding `undefined`) means the
 *    selector contributed something beyond a column reference.
 *
 * The probe means the selector is evaluated twice on the success path; selectors
 * are required to be pure column pickers, so that is safe.
 *
 * RESIDUAL BLIND SPOT: a discarded operand that both costs no root access and
 * evaluates to `undefined`. `u => u.a || undefined`, `u => u.a ?? undefined`,
 * or a closed-over variable that happens to hold `undefined`. Such an
 * expression is a semantic no-op (its result is always `u.a`), so resolving it
 * to column `a` is the correct answer anyway. Conversely, a selector that is
 * impure or non-deterministic can look computed and fall back conservatively.
 */
export function capture(selector: (entity: any) => any): CaptureResult {
    const { root, coerced, accesses } = createRecorder();

    let returned: any;
    try {
        returned = selector(root);
    } catch {
        return { kind: 'opaque', reason: 'computed' };
    }

    if (coerced()) return { kind: 'opaque', reason: 'computed' };
    const accessCount = accesses();

    const direct = pathOf(returned);
    if (direct !== undefined) {
        if (direct.includes('.')) return { kind: 'opaque', reason: 'nested' };
        if (accessCount > 1) return { kind: 'opaque', reason: 'computed' };
        if (!probeIsFaithful(selector, accessCount)) return { kind: 'opaque', reason: 'computed' };
        return { kind: 'property', path: direct };
    }

    if (isPlainObject(returned)) {
        const aliases: Record<string, string> = {};
        for (const [alias, value] of Object.entries(returned)) {
            const path = pathOf(value);
            if (path === undefined) return { kind: 'opaque', reason: 'computed' };
            if (path.includes('.')) return { kind: 'opaque', reason: 'nested' };
            aliases[alias] = path;
        }
        const aliasNames = Object.keys(aliases);
        if (aliasNames.length === 0) {
            return { kind: 'opaque', reason: 'unsupported' };
        }
        if (accessCount > aliasNames.length) return { kind: 'opaque', reason: 'computed' };
        if (!probeIsFaithful(selector, accessCount, aliasNames)) {
            return { kind: 'opaque', reason: 'computed' };
        }
        return { kind: 'projection', aliases };
    }

    return { kind: 'opaque', reason: 'unsupported' };
}

/** Run the nullish probe and report whether it agrees with the first pass. */
function probeIsFaithful(
    selector: (entity: any) => any,
    accessCount: number,
    aliasNames?: string[]
): boolean {
    const probe = probeNullish(selector);
    if (probe.threw) return false;
    if (probe.accesses !== accessCount) return false;
    return probeReturnedOnlyUndefined(probe.returned, aliasNames);
}

// Property names recognized on the `g` grouping object, mapped to the
// canonical AggregateFn they resolve to. `average` is the documented,
// typed `IGrouping.average()` method name; `avg` is accepted as a synonym
// so both spellings resolve to the same SQL `AVG(...)` emission.
const AGGREGATE_FN_ALIASES: Record<string, AggregateFn> = {
    count: 'count',
    sum: 'sum',
    avg: 'avg',
    average: 'avg',
    min: 'min',
    max: 'max',
};
const AGG = Symbol('rnxorm.aggregate');

export function captureAggregates(selector: (group: any) => any): AggregateCaptureResult {
    let unsupported = false;

    const group = new Proxy({} as any, {
        get(_target, prop) {
            if (prop === 'then') return undefined;
            if (typeof prop === 'symbol') {
                unsupported = true;
                return undefined;
            }
            if (prop === 'key') {
                return { [AGG]: true, kind: 'key' as const };
            }
            const canonical = AGGREGATE_FN_ALIASES[String(prop)];
            if (!canonical) {
                unsupported = true;
                return () => undefined;
            }
            return (inner?: (entity: any) => any) => {
                let path: string | undefined;
                if (typeof inner === 'function') {
                    const captured = capture(inner);
                    if (captured.kind !== 'property') {
                        unsupported = true;
                    } else {
                        path = captured.path;
                    }
                } else if (inner !== undefined) {
                    // A non-function argument (e.g. `g.sum(5)`) can't be resolved
                    // to a column selector. Treating it the same as the no-arg
                    // form would silently misrepresent the caller's intent.
                    unsupported = true;
                }
                return { [AGG]: true, fn: canonical, path };
            };
        },
    });

    let returned: any;
    try {
        returned = selector(group);
    } catch {
        return { kind: 'opaque', reason: 'computed' };
    }

    if (unsupported || !isPlainObject(returned)) {
        return { kind: 'opaque', reason: 'unsupported' };
    }

    const aggregates: Record<string, AggregateSelectorEntry> = {};
    for (const [alias, value] of Object.entries(returned as Record<string, any>)) {
        if (!value || value[AGG] !== true) {
            return { kind: 'opaque', reason: 'unsupported' };
        }
        if (value.kind === 'key') {
            aggregates[alias] = { kind: 'key' };
        } else {
            aggregates[alias] = value.path === undefined ? { fn: value.fn } : { fn: value.fn, path: value.path };
        }
    }

    if (Object.keys(aggregates).length === 0) {
        return { kind: 'opaque', reason: 'unsupported' };
    }
    return { kind: 'aggregates', aggregates };
}

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
