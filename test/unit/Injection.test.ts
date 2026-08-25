import "reflect-metadata";
import {
    ALLOWED_OPERATORS,
    assertColumn,
    assertColumnOrAlias,
    assertHavingExpression,
    assertLimit,
    assertOperator,
    buildComparison,
} from '../../src/core/Identifiers';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

@Entity('inj_products')
class InjProduct {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column({ name: 'unit_price' })
    price!: number;
}

class InjUnmapped {}

describe('assertOperator', () => {
    it.each([...ALLOWED_OPERATORS])('allows %s', op => {
        expect(assertOperator(op, 'where')).toBe(op);
    });

    it('uppercases keyword operators', () => {
        expect(assertOperator('like', 'where')).toBe('LIKE');
        expect(assertOperator('ilike', 'where')).toBe('ILIKE');
        expect(assertOperator('not  like', 'where')).toBe('NOT LIKE');
    });

    it.each([
        '; DROP TABLE users; --',
        '= 1 OR 1',
        'BETWEEN',
        '=;',
        '',
    ])('rejects %j', op => {
        expect(() => assertOperator(op, 'where')).toThrow(/not supported/);
    });

    // Restored in 2.2.0 after the closed set removed documented 2.1 usage.
    it.each([
        ['in', 'IN'],
        ['not  in', 'NOT IN'],
        ['is', 'IS'],
        ['is not', 'IS NOT'],
    ])('allows the set/null operator %j', (input, normalized) => {
        expect(assertOperator(input, 'where')).toBe(normalized);
    });
});

describe('assertLimit', () => {
    it.each([0, 1, 10, 1000])('allows the non-negative integer %d', value => {
        expect(assertLimit(value, 'take')).toBe(value);
    });

    it.each([
        ['10; DROP TABLE probe_users --'],
        ['5'],
        [-1],
        [1.5],
        [NaN],
        [Infinity],
        [null],
        [undefined],
        [{}],
    ])('rejects %j naming the API', value => {
        expect(() => assertLimit(value as any, 'take')).toThrow(/take\(\)/);
    });
});

describe('buildComparison', () => {
    // A stand-in for the three real providers' placeholder styles.
    const pg = { getParameterPlaceholder: (i: number) => `$${i}` } as any;
    const mssql = { getParameterPlaceholder: (i: number) => `@p${i - 1}` } as any;
    const mariadb = { getParameterPlaceholder: () => '?' } as any;

    it('binds a standard comparison to one placeholder', () => {
        expect(buildComparison('unit_price', '>', 10, pg, 1, 'where'))
            .toEqual({ clause: 'unit_price > $1', params: [10] });
    });

    it('continues placeholder numbering from nextParamIndex', () => {
        expect(buildComparison('name', '=', 'a', pg, 4, 'where'))
            .toEqual({ clause: 'name = $4', params: ['a'] });
    });

    it.each([
        ['postgresql', pg, 'status IN ($2, $3, $4)'],
        ['mssql', mssql, 'status IN (@p1, @p2, @p3)'],
        ['mariadb', mariadb, 'status IN (?, ?, ?)'],
    ])('expands IN to one placeholder per element (%s)', (_dialect, provider, expected) => {
        expect(buildComparison('status', 'IN', ['a', 'b', 'c'], provider, 2, 'where'))
            .toEqual({ clause: expected, params: ['a', 'b', 'c'] });
    });

    it('expands NOT IN the same way', () => {
        expect(buildComparison('status', 'NOT IN', ['a', 'b'], pg, 1, 'where'))
            .toEqual({ clause: 'status NOT IN ($1, $2)', params: ['a', 'b'] });
    });

    it('compiles an empty IN to a false constant with no params', () => {
        expect(buildComparison('status', 'IN', [], pg, 1, 'where'))
            .toEqual({ clause: '1 = 0', params: [] });
    });

    it('compiles an empty NOT IN to a true constant with no params', () => {
        expect(buildComparison('status', 'NOT IN', [], pg, 1, 'where'))
            .toEqual({ clause: '1 = 1', params: [] });
    });

    it.each([['IN'], ['NOT IN']])('throws when %s receives a non-array value', op => {
        expect(() => buildComparison('status', op, 'a', pg, 1, 'where')).toThrow(/array/);
    });

    it('emits IS NULL and consumes no parameter', () => {
        expect(buildComparison('deletedat', 'IS', null, pg, 1, 'where'))
            .toEqual({ clause: 'deletedat IS NULL', params: [] });
    });

    it('emits IS NOT NULL and consumes no parameter', () => {
        expect(buildComparison('deletedat', 'IS NOT', null, pg, 1, 'where'))
            .toEqual({ clause: 'deletedat IS NOT NULL', params: [] });
    });

    it.each([['IS'], ['IS NOT']])('throws when %s receives a non-null value, pointing at =', op => {
        expect(() => buildComparison('deletedat', op, 5, pg, 1, 'where')).toThrow(/'='/);
    });

    it('still rejects operators outside the allowed set', () => {
        expect(() => buildComparison('name', 'BETWEEN', [1, 2], pg, 1, 'where')).toThrow(/not supported/);
    });
});

describe('assertColumn', () => {
    it('accepts a property name and returns the column name', () => {
        expect(assertColumn(InjProduct, 'price', 'where')).toBe('unit_price');
    });

    it('accepts a column name as-is', () => {
        expect(assertColumn(InjProduct, 'unit_price', 'where')).toBe('unit_price');
    });

    it('accepts default-lowercased columns by either spelling', () => {
        expect(assertColumn(InjProduct, 'name', 'orderBy')).toBe('name');
    });

    it.each([
        'name; DROP TABLE inj_products; --',
        'name) OR (1=1',
        "name'",
        'nonexistent',
        '(SELECT password FROM users)',
    ])('rejects %j with the entity name in the error', column => {
        expect(() => assertColumn(InjProduct, column, 'orderBy')).toThrow(/InjProduct/);
    });

    it('throws for an entity with no metadata', () => {
        expect(() => assertColumn(InjUnmapped as any, 'name', 'where')).toThrow(/no entity metadata/);
    });
});

describe('assertHavingExpression', () => {
    it('allows COUNT(*)', () => {
        expect(assertHavingExpression(InjProduct, 'COUNT(*)', 'having')).toBe('COUNT(*)');
    });

    it('allows aggregates over mapped properties, resolving the column', () => {
        expect(assertHavingExpression(InjProduct, 'SUM(price)', 'having')).toBe('SUM(unit_price)');
        expect(assertHavingExpression(InjProduct, 'avg( unit_price )', 'having')).toBe('AVG(unit_price)');
    });

    it('allows a bare mapped column', () => {
        expect(assertHavingExpression(InjProduct, 'name', 'having')).toBe('name');
    });

    it.each([
        'COUNT(*) > 0; DROP TABLE inj_products',
        'SUM(nonexistent)',
        'EXEC(sp_evil)',
        "COUNT(*') --",
    ])('rejects %j', expression => {
        expect(() => assertHavingExpression(InjProduct, expression, 'having')).toThrow();
    });
});

describe('assertColumnOrAlias', () => {
    it('resolves mapped properties to column names', () => {
        expect(assertColumnOrAlias(InjProduct, 'price', 'orderBy')).toBe('unit_price');
    });

    it('passes through plain-identifier aliases untouched', () => {
        expect(assertColumnOrAlias(InjProduct, 'total', 'orderBy')).toBe('total');
    });

    it.each([
        'total; DROP TABLE x',
        'a b',
        "alias'",
        '1total',
        '',
    ])('rejects %j', name => {
        expect(() => assertColumnOrAlias(InjProduct, name, 'orderBy')).toThrow();
    });
});

// End-to-end: the validation actually guards the public query API.
import { DbContext } from '../../src/core/DbContext';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

describe('query API rejects untrusted identifiers end-to-end', () => {
    function makeDb() {
        const provider = new SqlCaptureProvider('postgresql');
        return { db: new DbContext(provider), provider };
    }

    it('where() rejects an injected column before any SQL is built', () => {
        const { db, provider } = makeDb();
        expect(() => db.set(InjProduct).where('name; DROP TABLE inj_products; --', '=', 'x'))
            .toThrow(/InjProduct/);
        expect(provider.calls).toHaveLength(0);
    });

    it('where() rejects an injected operator', () => {
        const { db } = makeDb();
        expect(() => db.set(InjProduct).where('name', '= 1 OR 1', 'x')).toThrow(/not supported/);
    });

    it('orderBy() rejects the classic sortable-table payload', () => {
        const { db } = makeDb();
        expect(() => db.set(InjProduct).orderBy('name; SELECT pg_sleep(10)')).toThrow(/InjProduct/);
    });

    it('having() rejects non-aggregate expressions', () => {
        const { db } = makeDb();
        expect(() =>
            db.set(InjProduct).groupBy(p => p.name).having('COUNT(*) > 0; DROP TABLE x', '>', 1)
        ).toThrow();
    });

    it('where() resolves a renamed property to its mapped column', async () => {
        const { db, provider } = makeDb();
        await db.set(InjProduct).where('price', '>', 10).toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM inj_products WHERE unit_price > $1');
    });

    it('keyword operators are normalized into SQL', async () => {
        const { db, provider } = makeDb();
        await db.set(InjProduct).where('name', 'like', '%a%').toList();
        expect(provider.lastCall!.sql).toBe('SELECT * FROM inj_products WHERE name LIKE $1');
    });
});

// skip()/take() are the one pair of query-API arguments that must be
// interpolated (no dialect accepts a placeholder for LIMIT/OFFSET on every
// driver), so they need their own runtime guard: TypeScript's `number` type
// erases at runtime and `as any` / untyped JSON gets through it.
describe('skip()/take() reject non-integer payloads end-to-end (C1)', () => {
    const PAYLOAD = '10; DROP TABLE probe_users --';

    function makeDb() {
        const provider = new SqlCaptureProvider('postgresql');
        return { db: new DbContext(provider), provider };
    }

    it('DbSet.take() throws and issues no query', () => {
        const { db, provider } = makeDb();
        expect(() => db.set(InjProduct).take(PAYLOAD as any)).toThrow(/take\(\)/);
        expect(provider.calls).toHaveLength(0);
    });

    it('DbSet.skip() throws and issues no query', () => {
        const { db, provider } = makeDb();
        expect(() => db.set(InjProduct).skip(PAYLOAD as any)).toThrow(/skip\(\)/);
        expect(provider.calls).toHaveLength(0);
    });

    it('QueryBuilder.take()/skip() throw', () => {
        const { db, provider } = makeDb();
        expect(() => db.set(InjProduct).where('name', '=', 'x').take(PAYLOAD as any)).toThrow(/take\(\)/);
        expect(() => db.set(InjProduct).where('name', '=', 'x').skip(PAYLOAD as any)).toThrow(/skip\(\)/);
        expect(provider.calls).toHaveLength(0);
    });

    it('SelectQueryBuilder.take()/skip() throw', () => {
        const { db, provider } = makeDb();
        expect(() => db.set(InjProduct).select(p => p.name).take(PAYLOAD as any)).toThrow(/take\(\)/);
        expect(() => db.set(InjProduct).select(p => p.name).skip(PAYLOAD as any)).toThrow(/skip\(\)/);
        expect(provider.calls).toHaveLength(0);
    });

    it('GroupedQueryBuilder.take()/skip() throw', () => {
        const { db, provider } = makeDb();
        expect(() => db.set(InjProduct).groupBy(p => p.name).take(PAYLOAD as any)).toThrow(/take\(\)/);
        expect(() => db.set(InjProduct).groupBy(p => p.name).skip(PAYLOAD as any)).toThrow(/skip\(\)/);
        expect(provider.calls).toHaveLength(0);
    });

    it.each([[-1], [2.5], [NaN]])('rejects the non-integer %j', value => {
        const { db } = makeDb();
        expect(() => db.set(InjProduct).take(value as any)).toThrow(/take\(\)/);
    });

    it('still emits LIMIT/OFFSET for valid integers', async () => {
        const { db, provider } = makeDb();
        await db.set(InjProduct).skip(5).take(10).toList();
        // (The double space before LIMIT is the pre-existing shape of a
        // paginated query with no WHERE/ORDER BY clause.)
        expect(provider.lastCall!.sql).toBe('SELECT * FROM inj_products  LIMIT 10 OFFSET 5');
    });
});
