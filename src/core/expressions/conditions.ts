import { Predicate } from "../query/model/Predicate";
import { Operand } from "../query/model/Operand";
import { QueryParameter } from "../types";
import { assertColumn, convertValueToDb, findColumn, operatorToPredicate } from "../Identifiers";
import { createRecorder, pathOf } from "./PropertyCapture";

/**
 * Condition builders for `where(u => eq(u.email, x))`.
 *
 * Each builder returns the query model's Predicate directly. The column is a
 * property path read off the marker the recording proxy hands to the lambda;
 * it becomes a column name, and the value goes through the column's converter,
 * when the predicate is resolved against the entity (see resolveCondition).
 */

const built = new WeakSet<object>();

function node(predicate: Predicate): Predicate {
    built.add(predicate);
    return predicate;
}

function isBuilt(value: unknown): value is Predicate {
    return typeof value === 'object' && value !== null && built.has(value);
}

function column(value: unknown, builder: string): Operand {
    const path = pathOf(value);
    if (path === undefined) {
        throw new Error(
            `${builder}() needs a column from the where() lambda as its first argument, e.g. where(u => ${builder}(u.age, ...))`
        );
    }
    return { kind: 'column', name: path };
}

function param(value: unknown, builder: string): QueryParameter {
    if (pathOf(value) !== undefined) {
        throw new Error(`${builder}() compares a column to a value; comparing two columns is not supported`);
    }
    return value as QueryParameter;
}

function parts(items: unknown[], builder: string): Predicate[] {
    for (const item of items) {
        if (!isBuilt(item)) {
            throw new Error(
                `${builder}() takes conditions built with eq(), gt(), and() and the other builders; ` +
                `a plain expression such as u.age > 18 cannot be read`
            );
        }
    }
    return items as Predicate[];
}

export function eq<V>(col: V, value: NoInfer<V>): Predicate {
    return node({ op: 'eq', left: column(col, 'eq'), value: param(value, 'eq') });
}
export function ne<V>(col: V, value: NoInfer<V>): Predicate {
    return node({ op: 'ne', left: column(col, 'ne'), value: param(value, 'ne') });
}
export function gt<V>(col: V, value: NoInfer<V>): Predicate {
    return node({ op: 'gt', left: column(col, 'gt'), value: param(value, 'gt') });
}
export function gte<V>(col: V, value: NoInfer<V>): Predicate {
    return node({ op: 'gte', left: column(col, 'gte'), value: param(value, 'gte') });
}
export function lt<V>(col: V, value: NoInfer<V>): Predicate {
    return node({ op: 'lt', left: column(col, 'lt'), value: param(value, 'lt') });
}
export function lte<V>(col: V, value: NoInfer<V>): Predicate {
    return node({ op: 'lte', left: column(col, 'lte'), value: param(value, 'lte') });
}
export function like(col: string | null | undefined, pattern: string): Predicate {
    return node({ op: 'like', left: column(col, 'like'), value: param(pattern, 'like') });
}
export function notLike(col: string | null | undefined, pattern: string): Predicate {
    return node({ op: 'notLike', left: column(col, 'notLike'), value: param(pattern, 'notLike') });
}
export function ilike(col: string | null | undefined, pattern: string): Predicate {
    return node({ op: 'ilike', left: column(col, 'ilike'), value: param(pattern, 'ilike') });
}
export function inArray<V>(col: V, values: readonly NoInfer<V>[]): Predicate {
    return node({ op: 'in', left: column(col, 'inArray'), values: values.map(v => param(v, 'inArray')) });
}
export function notInArray<V>(col: V, values: readonly NoInfer<V>[]): Predicate {
    return node({ op: 'notIn', left: column(col, 'notInArray'), values: values.map(v => param(v, 'notInArray')) });
}
export function isNull(col: unknown): Predicate {
    return node({ op: 'isNull', left: column(col, 'isNull') });
}
export function isNotNull(col: unknown): Predicate {
    return node({ op: 'isNotNull', left: column(col, 'isNotNull') });
}
export function between<V>(col: V, low: NoInfer<V>, high: NoInfer<V>): Predicate {
    return node({
        op: 'between',
        left: column(col, 'between'),
        low: param(low, 'between'),
        high: param(high, 'between'),
    });
}
export function and(...conditions: Predicate[]): Predicate {
    return node({ op: 'and', parts: parts(conditions, 'and') });
}
export function or(...conditions: Predicate[]): Predicate {
    return node({ op: 'or', parts: parts(conditions, 'or') });
}
export function not(condition: Predicate): Predicate {
    return node({ op: 'not', part: parts([condition], 'not')[0] });
}

function leafCount(p: Predicate): number {
    switch (p.op) {
        case 'and':
        case 'or':
            return p.parts.reduce((n, part) => n + leafCount(part), 0);
        case 'not':
            return leafCount(p.part);
        default:
            return 1;
    }
}

/**
 * Run a `where(u => ...)` lambda against a recording proxy and return the
 * Predicate the builders produced. Throws when the lambda returns anything
 * else, since a plain boolean (`u => u.age > 18`) cannot be observed.
 */
export function recordPredicate(selector: (entity: any) => unknown, apiName: string): Predicate {
    const { root, accesses, coerced } = createRecorder();
    const message =
        `${apiName}() expects a condition built with eq(), gt(), and() and the other builders, ` +
        `e.g. ${apiName}(u => eq(u.age, 18)). A plain expression such as u.age > 18 cannot be read`;
    let returned: unknown;
    try {
        returned = selector(root);
    } catch (err) {
        if (coerced()) throw new Error(message);
        throw err;
    }

    if (!isBuilt(returned)) throw new Error(message);
    if (accesses() !== leafCount(returned)) {
        throw new Error(
            `${apiName}() lambda must return the builders' result and read each column once per condition; ` +
            `branching on a column inside the lambda is not supported`
        );
    }
    return returned;
}

/**
 * Rewrite property paths to column names and apply each column's value
 * converter, so the translator only sees resolved nodes. Property or column
 * names both resolve, as in the three-argument where().
 */
export function resolveCondition(
    entityType: new (...args: any[]) => any,
    predicate: Predicate,
    apiName: string
): Predicate {
    switch (predicate.op) {
        case 'and':
        case 'or':
            return { op: predicate.op, parts: predicate.parts.map(p => resolveCondition(entityType, p, apiName)) };
        case 'not':
            return { op: 'not', part: resolveCondition(entityType, predicate.part, apiName) };
        default:
            break;
    }

    const left = predicate.left;
    if (left.kind !== 'column') return predicate;
    if (left.name.includes('.')) {
        throw new Error(
            `${apiName}() does not support nested property access; ` +
            `related-path selectors arrive in rnxORM 3.0`
        );
    }
    const resolved: Operand = { kind: 'column', name: assertColumn(entityType, left.name, apiName) };
    const meta = findColumn(entityType, left.name);
    const conv = (v: QueryParameter): QueryParameter => convertValueToDb(meta, v);

    switch (predicate.op) {
        case 'in':
        case 'notIn':
            return { ...predicate, left: resolved, values: predicate.values.map(conv) };
        case 'between':
            return { ...predicate, left: resolved, low: conv(predicate.low), high: conv(predicate.high) };
        case 'isNull':
        case 'isNotNull':
            return { ...predicate, left: resolved };
        default:
            return { ...predicate, left: resolved, value: conv(predicate.value) };
    }
}

/**
 * The one entry point for where(): the lambda form and the deprecated
 * three-argument form both end up as a resolved Predicate here.
 */
export function buildWhere(
    entityType: new (...args: any[]) => any,
    first: string | ((entity: any) => unknown),
    operator: string | undefined,
    value: unknown
): Predicate {
    if (typeof first === 'function') {
        return resolveCondition(entityType, recordPredicate(first, 'where'), 'where');
    }
    return resolveCondition(entityType, operatorToPredicate(first, operator as string, value, 'where'), 'where');
}
