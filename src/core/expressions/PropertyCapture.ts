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
        return { kind: 'opaque', reason: 'computed' };
    }

    if (coerced()) return { kind: 'opaque', reason: 'computed' };

    const direct = pathOf(returned);
    if (direct !== undefined) {
        return direct.includes('.')
            ? { kind: 'opaque', reason: 'nested' }
            : { kind: 'property', path: direct };
    }

    if (isPlainObject(returned)) {
        const aliases: Record<string, string> = {};
        for (const [alias, value] of Object.entries(returned)) {
            const path = pathOf(value);
            if (path === undefined) return { kind: 'opaque', reason: 'computed' };
            if (path.includes('.')) return { kind: 'opaque', reason: 'nested' };
            aliases[alias] = path;
        }
        if (Object.keys(aliases).length === 0) {
            return { kind: 'opaque', reason: 'unsupported' };
        }
        return { kind: 'projection', aliases };
    }

    return { kind: 'opaque', reason: 'unsupported' };
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
