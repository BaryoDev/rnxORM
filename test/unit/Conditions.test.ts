import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import {
    eq, ne, gt, gte, lt, lte, like, notLike, ilike, inArray, notInArray,
    isNull, isNotNull, between, and, or, not,
} from '../../src';
import { recordPredicate } from '../../src/core/expressions/conditions';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

type Dialect = 'postgresql' | 'mssql' | 'mariadb';

@Entity('cb_users')
class CbUser {
    @PrimaryKey()
    id!: number;

    @Column()
    email!: string;

    @Column()
    age!: number;

    @Column({ name: 'full_name' })
    name!: string;

    @Column()
    nickname!: string | null;

    @Column()
    code!: string;

    address!: { city: string };
}

beforeAll(() => {
    const code = MetadataStorage.get().getEntity(CbUser)!.columns.find(c => c.propertyName === 'code')!;
    code.hasConversion = true;
    code.convertToDb = (v: any) => `db:${v}`;
});

const col = (name: string) => ({ kind: 'column', name });

function record(fn: (u: CbUser) => any) {
    return recordPredicate(fn, 'where');
}

function makeDb(dialect: Dialect) {
    const provider = new SqlCaptureProvider(dialect);
    return { db: new DbContext(provider), provider };
}

describe('condition builders: node shapes', () => {
    it('eq, ne, gt, gte, lt, lte', () => {
        expect(record(u => eq(u.email, 'a@b.c'))).toEqual({ op: 'eq', left: col('email'), value: 'a@b.c' });
        expect(record(u => ne(u.age, 1))).toEqual({ op: 'ne', left: col('age'), value: 1 });
        expect(record(u => gt(u.age, 1))).toEqual({ op: 'gt', left: col('age'), value: 1 });
        expect(record(u => gte(u.age, 1))).toEqual({ op: 'gte', left: col('age'), value: 1 });
        expect(record(u => lt(u.age, 1))).toEqual({ op: 'lt', left: col('age'), value: 1 });
        expect(record(u => lte(u.age, 1))).toEqual({ op: 'lte', left: col('age'), value: 1 });
    });

    it('like, notLike, ilike', () => {
        expect(record(u => like(u.email, '%a'))).toEqual({ op: 'like', left: col('email'), value: '%a' });
        expect(record(u => notLike(u.email, '%a'))).toEqual({ op: 'notLike', left: col('email'), value: '%a' });
        expect(record(u => ilike(u.email, '%a'))).toEqual({ op: 'ilike', left: col('email'), value: '%a' });
    });

    it('inArray, notInArray, isNull, isNotNull, between', () => {
        expect(record(u => inArray(u.age, [1, 2]))).toEqual({ op: 'in', left: col('age'), values: [1, 2] });
        expect(record(u => notInArray(u.age, [1, 2]))).toEqual({ op: 'notIn', left: col('age'), values: [1, 2] });
        expect(record(u => isNull(u.nickname))).toEqual({ op: 'isNull', left: col('nickname') });
        expect(record(u => isNotNull(u.nickname))).toEqual({ op: 'isNotNull', left: col('nickname') });
        expect(record(u => between(u.age, 18, 65))).toEqual({ op: 'between', left: col('age'), low: 18, high: 65 });
    });

    it('nests and, or, not', () => {
        const p = record(u => and(eq(u.email, 'x'), or(gt(u.age, 1), not(isNull(u.nickname)))));
        expect(p).toEqual({
            op: 'and',
            parts: [
                { op: 'eq', left: col('email'), value: 'x' },
                {
                    op: 'or',
                    parts: [
                        { op: 'gt', left: col('age'), value: 1 },
                        { op: 'not', part: { op: 'isNull', left: col('nickname') } },
                    ],
                },
            ],
        });
    });

    it('keeps a nested path in the node', () => {
        const p = recordPredicate((u: any) => eq(u.address.city, 'Manila'), 'where');
        expect(p).toEqual({ op: 'eq', left: col('address.city'), value: 'Manila' });
    });
});

describe('condition builders: errors', () => {
    it('a boolean-returning lambda says to use the builders', () => {
        expect(() => record(u => u.age > 18)).toThrow(/expects a condition built with eq\(\)/);
        expect(() => record(u => u.age > 18)).toThrow(/cannot be read/);
    });

    it('a plain expression inside and() is rejected', () => {
        expect(() => record(u => and(eq(u.age, 1), { op: 'eq' } as any))).toThrow(/takes conditions built with/);
    });

    it('comparing two columns is rejected', () => {
        expect(() => record(u => eq(u.age, u.age as any))).toThrow(/comparing two columns/);
    });

    it('branching on a column inside the lambda is rejected', () => {
        expect(() => record(u => (u.nickname ? eq(u.age, 1) : eq(u.age, 2)))).toThrow(/branching/);
    });

    it('nested paths keep the related-path error', () => {
        const { db } = makeDb('postgresql');
        expect(() => db.set(CbUser).where((u: any) => eq(u.address.city, 'x'))).toThrow(
            /does not support nested property access/
        );
    });
});

function sqls(postgresql: string, mssql: string, mariadb: string): Record<Dialect, string> {
    return { postgresql, mssql, mariadb };
}

describe('condition builders: SQL per dialect', () => {
    const cases: [string, (u: CbUser) => any, Record<Dialect, string>, any[]][] = [
        ['eq', u => eq(u.email, 'a'), sqls('email = $1', 'email = @p0', 'email = ?'), ['a']],
        ['ne', u => ne(u.age, 1), sqls('age != $1', 'age != @p0', 'age != ?'), [1]],
        ['gt', u => gt(u.age, 1), sqls('age > $1', 'age > @p0', 'age > ?'), [1]],
        ['gte', u => gte(u.age, 1), sqls('age >= $1', 'age >= @p0', 'age >= ?'), [1]],
        ['lt', u => lt(u.age, 1), sqls('age < $1', 'age < @p0', 'age < ?'), [1]],
        ['lte', u => lte(u.age, 1), sqls('age <= $1', 'age <= @p0', 'age <= ?'), [1]],
        ['like', u => like(u.email, '%a'), sqls('email LIKE $1', 'email LIKE @p0', 'email LIKE ?'), ['%a']],
        ['notLike', u => notLike(u.email, '%a'), sqls('email NOT LIKE $1', 'email NOT LIKE @p0', 'email NOT LIKE ?'), ['%a']],
        ['inArray', u => inArray(u.age, [1, 2]), sqls('age IN ($1, $2)', 'age IN (@p0, @p1)', 'age IN (?, ?)'), [1, 2]],
        ['notInArray', u => notInArray(u.age, [1, 2]), sqls('age NOT IN ($1, $2)', 'age NOT IN (@p0, @p1)', 'age NOT IN (?, ?)'), [1, 2]],
        ['isNull', u => isNull(u.nickname), sqls('nickname IS NULL', 'nickname IS NULL', 'nickname IS NULL'), []],
        ['isNotNull', u => isNotNull(u.nickname), sqls('nickname IS NOT NULL', 'nickname IS NOT NULL', 'nickname IS NOT NULL'), []],
        ['between', u => between(u.age, 1, 5), sqls('age BETWEEN $1 AND $2', 'age BETWEEN @p0 AND @p1', 'age BETWEEN ? AND ?'), [1, 5]],
        ['and', u => and(eq(u.age, 1), eq(u.email, 'a')), sqls('age = $1 AND email = $2', 'age = @p0 AND email = @p1', 'age = ? AND email = ?'), [1, 'a']],
        ['or nested in and', u => and(eq(u.age, 1), or(eq(u.email, 'a'), eq(u.email, 'b'))),
            sqls('age = $1 AND (email = $2 OR email = $3)', 'age = @p0 AND (email = @p1 OR email = @p2)', 'age = ? AND (email = ? OR email = ?)'), [1, 'a', 'b']],
        ['not', u => not(eq(u.age, 1)), sqls('NOT (age = $1)', 'NOT (age = @p0)', 'NOT (age = ?)'), [1]],
        ['renamed column', u => eq(u.name, 'n'), sqls('full_name = $1', 'full_name = @p0', 'full_name = ?'), ['n']],
        ['value converter', u => eq(u.code, 'x'), sqls('code = $1', 'code = @p0', 'code = ?'), ['db:x']],
    ];

    const dialects: Dialect[] = ['postgresql', 'mssql', 'mariadb'];

    for (const [name, build, sql, params] of cases) {
        for (const dialect of dialects) {
            it(`${name} on ${dialect}`, async () => {
                const { db, provider } = makeDb(dialect);
                await db.set(CbUser).where(build).toList();
                expect(provider.lastCall!.sql).toContain(` WHERE ${sql[dialect]}`);
                expect(provider.lastCall!.params ?? []).toEqual(params);
            });
        }
    }

    it('ilike renders on postgresql', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(CbUser).where(u => ilike(u.email, '%a')).toList();
        expect(provider.lastCall!.sql).toContain(' WHERE email ILIKE $1');
    });

    it('where chains on QueryBuilder and works on SelectQueryBuilder', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(CbUser).where(u => gt(u.age, 1)).where(u => eq(u.email, 'a')).toList();
        expect(provider.lastCall!.sql).toContain(' WHERE age > $1 AND email = $2');
    });

    it.each(['postgresql', 'mssql', 'mariadb'] as Dialect[])(
        'three-argument form builds the same SQL as the builder on %s',
        async dialect => {
            const a = makeDb(dialect);
            const b = makeDb(dialect);
            await a.db.set(CbUser).where('code', '>=', 'x').toList();
            await b.db.set(CbUser).where(u => gte(u.code, 'x')).toList();
            expect(a.provider.lastCall).toEqual(b.provider.lastCall);
            expect(a.provider.lastCall!.params).toEqual(['db:x']);
        }
    );
});

describe('condition builders: compile-time checks', () => {
    it('rejects a wrong value type and an unknown property', () => {
        const { db } = makeDb('postgresql');
        // @ts-expect-error age is a number
        expect(() => db.set(CbUser).where(u => eq(u.age, 'eighteen'))).not.toThrow();
        // @ts-expect-error nope is not a property of CbUser
        expect(() => db.set(CbUser).where(u => eq(u.nope, 1))).toThrow();
        // @ts-expect-error between bounds follow the column type
        expect(() => db.set(CbUser).where(u => between(u.age, 'a', 'b'))).not.toThrow();
        // @ts-expect-error like takes a string column
        expect(() => db.set(CbUser).where(u => like(u.age, '%'))).not.toThrow();
        // @ts-expect-error inArray values follow the column type
        expect(() => db.set(CbUser).where(u => inArray(u.age, ['a']))).not.toThrow();
    });
});
