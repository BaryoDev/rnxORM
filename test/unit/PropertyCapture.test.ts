import "reflect-metadata";
import { capture, captureAggregates, OpaqueReason, resolveColumn, resolvePropertyName } from '../../src/core/expressions/PropertyCapture';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

describe('capture — single property', () => {
    it('captures an arrow selector', () => {
        expect(capture((u: any) => u.name)).toEqual({ kind: 'property', path: 'name' });
    });

    it('captures a bound function selector', () => {
        // A regex-over-toString() approach breaks here: a bound function's
        // toString() renders as "function () { [native code] }" in V8, so the
        // source text of `u.name` is gone entirely. The Proxy-based capture
        // must still resolve this correctly because it observes the actual
        // property access at call time, not the source text.
        const selector = function (u: any) {
            return u.name;
        }.bind(null);
        expect(capture(selector)).toEqual({ kind: 'property', path: 'name' });
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
        // Deterministic: 'k: 1' has no path (pathOf(1) is undefined, since 1 is
        // neither object nor function), which the projection loop treats as a
        // computed value, not a missing/nested column.
        expect(capture((u: any) => ({ n: u.name, k: 1 })))
            .toEqual({ kind: 'opaque', reason: 'computed' });
    });
});

describe('capture — opaque detection', () => {
    // Each case's expected reason is asserted deterministically from the
    // implementation's control flow, not by running the code and copying
    // whatever came out:
    //  - string concatenation / template literal / arithmetic all force a
    //    coercion of a marker (ToPrimitive/ToString/ToNumber), which the
    //    marker's `get` trap flags via `coerced = true` before any value is
    //    returned to `capture` — so these are always 'computed'.
    //  - a throwing selector is always 'computed' because `capture`'s catch
    //    block hardcodes that reason regardless of why the throw happened.
    //  - `constant` and `array return` never touch the coercion path at all
    //    (no marker is invoked or asked to convert itself); they fall through
    //    to the generic `{ kind: 'opaque', reason: 'unsupported' }` at the end
    //    of `capture` because a bare number/array is neither a captured path
    //    nor a plain object.
    //  - `the root itself` returns the root proxy unchanged. `pathOf(root)` is
    //    always undefined (only markers carry the PATH symbol), so `capture`
    //    treats it as a plain-object projection candidate — but the target
    //    object has no own properties, so the projection ends up with zero
    //    aliases, which is explicitly 'unsupported'.
    const cases: Array<[string, (u: any) => any, OpaqueReason]> = [
        ['string concatenation', (u: any) => u.first + ' ' + u.last, 'computed'],
        ['template literal', (u: any) => `${u.first}`, 'computed'],
        ['arithmetic', (u: any) => u.age * 2, 'computed'],
        ['constant', () => 5, 'unsupported'],
        ['array return', (u: any) => [u.name], 'unsupported'],
        ['the root itself', (u: any) => u, 'unsupported'],
        ['a throwing selector', () => { throw new Error('boom'); }, 'computed'],
    ];

    it.each(cases)('is opaque for %s', (_label, selector, reason) => {
        expect(capture(selector)).toEqual({ kind: 'opaque', reason });
    });

    it('reports nested access as reason "nested"', () => {
        expect(capture((u: any) => u.address.city)).toEqual({ kind: 'opaque', reason: 'nested' });
    });

    it('reports computed expressions as reason "computed"', () => {
        expect(capture((u: any) => u.first + u.last)).toEqual({ kind: 'opaque', reason: 'computed' });
    });

    it('is opaque when a marker is JSON-stringified', () => {
        // Deterministic: JSON.stringify reads `.toJSON` off the marker before
        // doing anything else. That read alone matches the marker's coercion
        // guard (`prop === 'toJSON'`) and sets `coerced = true`, so `capture`
        // returns 'computed' from its coerced-check before it ever looks at
        // what JSON.stringify actually returned.
        expect(capture((u: any) => JSON.stringify(u.name)))
            .toEqual({ kind: 'opaque', reason: 'computed' });
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

    it('is opaque when a non-function argument is passed to an aggregate', () => {
        // g.sum(5) must not be silently treated the same as g.sum() — a
        // non-function argument can't be resolved to a column path, so it
        // has to be flagged rather than guessed at.
        expect(captureAggregates((g: any) => ({ x: g.sum(5) })))
            .toEqual({ kind: 'opaque', reason: 'unsupported' });
    });

    it('captures average — the documented IGrouping.average() method name', () => {
        // IGrouping.average() and the class's own @example blocks use
        // "average", not "avg". A capture that only recognized "avg" would
        // make the typed, documented public API silently unusable.
        expect(captureAggregates((g: any) => ({ avgAge: g.average((x: any) => x.age) })))
            .toEqual({ kind: 'aggregates', aggregates: { avgAge: { fn: 'avg', path: 'age' } } });
    });

    it('captures min', () => {
        expect(captureAggregates((g: any) => ({ m: g.min((x: any) => x.age) })))
            .toEqual({ kind: 'aggregates', aggregates: { m: { fn: 'min', path: 'age' } } });
    });

    it('captures max', () => {
        expect(captureAggregates((g: any) => ({ m: g.max((x: any) => x.age) })))
            .toEqual({ kind: 'aggregates', aggregates: { m: { fn: 'max', path: 'age' } } });
    });

    it('captures a bare g.key access as a key alias', () => {
        expect(captureAggregates((g: any) => ({ dept: g.key })))
            .toEqual({ kind: 'aggregates', aggregates: { dept: { kind: 'key' } } });
    });

    it('captures g.key alongside aggregates, preserving declaration order', () => {
        expect(captureAggregates((g: any) => ({ dept: g.key, total: g.sum((x: any) => x.balance) })))
            .toEqual({
                kind: 'aggregates',
                aggregates: { dept: { kind: 'key' }, total: { fn: 'sum', path: 'balance' } },
            });
    });

    it('is opaque for a genuinely unsupported selector shape', () => {
        // Not g.key, not a recognized aggregate call, not a plain object at
        // all — a computed expression built from the group. This must stay
        // opaque; it is not something the g.key fix should start accepting.
        expect(captureAggregates((g: any) => g.key + 1))
            .toEqual({ kind: 'opaque', reason: 'unsupported' });
    });
});

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

describe('resolvePropertyName', () => {
    it('resolves a property selector to the entity property name', () => {
        expect(resolvePropertyName((o: any) => o.total, 'include')).toBe('total');
    });

    it('throws a Phase-2 message for nested access', () => {
        expect(() => resolvePropertyName((o: any) => o.customer.name, 'include'))
            .toThrow(/nested/i);
    });

    it('throws for a computed selector', () => {
        expect(() => resolvePropertyName((o: any) => o.total * 2, 'include'))
            .toThrow(/single property/i);
    });
});
