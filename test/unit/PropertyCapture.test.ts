import "reflect-metadata";
import { capture, captureAggregates, OpaqueReason, resolveColumn, resolvePropertyName } from '../../src/core/expressions/PropertyCapture';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

describe('capture. Single property', () => {
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

describe('capture. Projections', () => {
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

describe('capture. Opaque detection', () => {
    // Each case's expected reason is asserted deterministically from the
    // implementation's control flow, not by running the code and copying
    // whatever came out:
    //  - string concatenation / template literal / arithmetic all force a
    //    coercion of a marker (ToPrimitive/ToString/ToNumber), which the
    //    marker's `get` trap flags via `coerced = true` before any value is
    //    returned to `capture`. So these are always 'computed'.
    //  - a throwing selector is always 'computed' because `capture`'s catch
    //    block hardcodes that reason regardless of why the throw happened.
    //  - `constant` and `array return` never touch the coercion path at all
    //    (no marker is invoked or asked to convert itself); they fall through
    //    to the generic `{ kind: 'opaque', reason: 'unsupported' }` at the end
    //    of `capture` because a bare number/array is neither a captured path
    //    nor a plain object.
    //  - `the root itself` returns the root proxy unchanged. `pathOf(root)` is
    //    always undefined (only markers carry the PATH symbol), so `capture`
    //    treats it as a plain-object projection candidate. But the target
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

/**
 * I2: a selector that picks between two columns (`||`, `??`, ternary) used to
 * resolve to whichever column happened to be reached first, silently dropping
 * the rest of the expression from the emitted SQL.
 *
 * Two independent signals catch these, because neither alone can:
 *  - the root-access count (a faithful selector touches exactly one root
 *    property per returned marker), which catches ternaries and any other shape
 *    that evaluates more than one root access; and
 *  - a second "nullish probe" evaluation, which catches `||`/`??`, whose left
 *    operand is a truthy, non-nullish marker in the normal pass and therefore
 *    short-circuits without the recorder ever observing the right operand.
 */
const FALLBACK = 'anonymous';

describe('capture. Short-circuit and branching selectors are opaque (I2)', () => {
    it.each([
        ['|| between two columns', (u: any) => u.nickname || u.name],
        ['?? between two columns', (u: any) => u.nickname ?? u.name],
        ['ternary between two columns', (u: any) => (u.flag ? u.nickname : u.name)],
        ['|| with a literal fallback', (u: any) => u.nickname || 'anonymous'],
        ['?? with a closed-over fallback', (u: any) => u.nickname ?? FALLBACK],
    ])('is opaque for a bare %s', (_label, selector) => {
        expect(capture(selector)).toEqual({ kind: 'opaque', reason: 'computed' });
    });

    it.each([
        ['||', (u: any) => ({ label: u.nickname || u.name })],
        ['??', (u: any) => ({ label: u.nickname ?? u.name })],
        ['ternary', (u: any) => ({ label: u.flag ? u.nickname : u.name })],
        ['literal fallback', (u: any) => ({ label: u.nickname || 'anonymous' })],
    ])('is opaque for a projection entry using %s', (_label, selector) => {
        expect(capture(selector)).toEqual({ kind: 'opaque', reason: 'computed' });
    });

    it('is opaque when one entry of a multi-entry projection short-circuits', () => {
        expect(capture((u: any) => ({ label: u.nickname || u.name, age: u.age })))
            .toEqual({ kind: 'opaque', reason: 'computed' });
    });

    it('is opaque when a reused marker hides a short-circuit', () => {
        // Compensating shape: aliasing a marker into a local means the extra
        // operand costs no additional root access, so the access count alone
        // would let it through. The nullish probe is what catches it.
        expect(capture((u: any) => {
            const nick = u.nickname;
            return { a: nick, b: nick || u.name };
        })).toEqual({ kind: 'opaque', reason: 'computed' });
    });

    it('still accepts a faithful projection that names the same column twice', () => {
        expect(capture((u: any) => ({ a: u.name, b: u.name })))
            .toEqual({ kind: 'projection', aliases: { a: 'name', b: 'name' } });
    });

    it('still accepts plain single-property and multi-property selectors', () => {
        expect(capture((u: any) => u.name)).toEqual({ kind: 'property', path: 'name' });
        expect(capture((u: any) => ({ n: u.name, a: u.age })))
            .toEqual({ kind: 'projection', aliases: { n: 'name', a: 'age' } });
    });

    it('documents the residual blind spot: a fallback that is itself undefined', () => {
        // `u.a || undefined` is indistinguishable from `u.a` to both signals:
        // the discarded operand consumes no root access AND evaluates to the
        // same `undefined` the probe pass produces for a plain column read.
        // The expression is a semantic no-op, so resolving it to column 'a' is
        // the correct answer anyway.
        expect(capture((u: any) => u.nickname || undefined))
            .toEqual({ kind: 'property', path: 'nickname' });
    });
});

describe('capture. Safety', () => {
    it('invokes the selector at most twice (normal pass + nullish probe)', () => {
        // The probe pass is what makes `||`/`??` detectable at all (see the I2
        // block above), so capture is no longer single-invocation. Selectors are
        // required to be pure column pickers, so a second evaluation is safe.
        let calls = 0;
        capture((u: any) => { calls++; return u.name; });
        expect(calls).toBe(2);
    });

    it('does not run the probe pass when the first pass is already opaque', () => {
        let calls = 0;
        capture((u: any) => { calls++; return `${u.name}!`; });
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
        // g.sum(5) must not be silently treated the same as g.sum(). A
        // non-function argument can't be resolved to a column path, so it
        // has to be flagged rather than guessed at.
        expect(captureAggregates((g: any) => ({ x: g.sum(5) })))
            .toEqual({ kind: 'opaque', reason: 'unsupported' });
    });

    it('captures average. The documented IGrouping.average() method name', () => {
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

    it('inherits the short-circuit rejection through inner selectors (I2)', () => {
        expect(captureAggregates((g: any) => ({ n: g.sum((u: any) => u.a || u.b) })))
            .toEqual({ kind: 'opaque', reason: 'unsupported' });
    });

    it('is opaque for a genuinely unsupported selector shape', () => {
        // Not g.key, not a recognized aggregate call, not a plain object at
        // all. A computed expression built from the group. This must stay
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
