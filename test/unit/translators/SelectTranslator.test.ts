import { SelectModel } from '../../../src/core/query/model/SelectModel';
import { Operand } from '../../../src/core/query/model/Operand';
import { Predicate } from '../../../src/core/query/model/Predicate';
import { QueryParameter } from '../../../src/core/types';
import { SqlTranslator } from '../../../src/providers/translators/SqlTranslator';
import { PostgresTranslator } from '../../../src/providers/translators/PostgresTranslator';
import { MsSqlTranslator } from '../../../src/providers/translators/MsSqlTranslator';
import { MariaDbTranslator } from '../../../src/providers/translators/MariaDbTranslator';

type Dialect = 'postgresql' | 'mssql' | 'mariadb';

const translators: Record<Dialect, SqlTranslator> = {
    postgresql: new PostgresTranslator(),
    mssql: new MsSqlTranslator(),
    mariadb: new MariaDbTranslator(),
};
const dialects = Object.keys(translators) as Dialect[];

/** Expected text uses {n} for the nth placeholder; this fills in the dialect's form. */
function fill(template: string, dialect: Dialect): string {
    return template.replace(/\{(\d+)\}/g, (_m, n: string) => {
        if (dialect === 'postgresql') return `$${n}`;
        if (dialect === 'mssql') return `@p${Number(n) - 1}`;
        return '?';
    });
}

const col = (name: string): Operand => ({ kind: 'column', name });
const agg = (fn: 'count' | 'sum' | 'avg' | 'min' | 'max', column?: string): Operand => ({
    kind: 'agg',
    fn,
    column,
});

interface Case {
    name: string;
    model: SelectModel;
    text: string;
    params: QueryParameter[];
}

const T = 'sqlgen_users';

const shared: Case[] = [
    {
        // SqlGeneration: 'generates SELECT DISTINCT *'
        name: 'distinct star',
        model: { table: T, distinct: true },
        text: `SELECT DISTINCT * FROM ${T}`,
        params: [],
    },
    {
        // SqlGeneration: 'translates single-property projections'
        name: 'distinct single column',
        model: { table: T, distinct: true, items: [{ operand: col('age') }] },
        text: `SELECT DISTINCT age FROM ${T}`,
        params: [],
    },
    {
        // SqlGeneration: 'translates multi-property projections with aliases'
        name: 'column list with aliases',
        model: {
            table: 'sqlgen_docs',
            items: [
                { operand: col('title'), alias: 'a' },
                { operand: col('status'), alias: 'b' },
            ],
        },
        text: 'SELECT title AS a, status AS b FROM sqlgen_docs',
        params: [],
    },
    {
        // SqlGeneration: 'joins multiple where conditions with AND and numbers placeholders'
        name: 'top-level and joins without parentheses',
        model: {
            table: T,
            where: {
                op: 'and',
                parts: [
                    { op: 'gt', left: col('age'), value: 18 },
                    { op: 'eq', left: col('name'), value: 'Alice' },
                ],
            },
        },
        text: `SELECT * FROM ${T} WHERE age > {1} AND name = {2}`,
        params: [18, 'Alice'],
    },
    {
        name: 'ne gte lt lte like notLike',
        model: {
            table: T,
            where: {
                op: 'and',
                parts: [
                    { op: 'ne', left: col('a'), value: 1 },
                    { op: 'gte', left: col('b'), value: 2 },
                    { op: 'lt', left: col('c'), value: 3 },
                    { op: 'lte', left: col('d'), value: 4 },
                    { op: 'like', left: col('e'), value: 'x%' },
                    { op: 'notLike', left: col('f'), value: 'y%' },
                ],
            },
        },
        text: `SELECT * FROM ${T} WHERE a != {1} AND b >= {2} AND c < {3} AND d <= {4} AND e LIKE {5} AND f NOT LIKE {6}`,
        params: [1, 2, 3, 4, 'x%', 'y%'],
    },
    {
        // SqlGeneration: 'set and null operators (I4)' IN
        name: 'in',
        model: {
            table: 'sqlgen_docs',
            where: { op: 'in', left: col('status'), values: ['a', 'b', 'c'] },
        },
        text: 'SELECT * FROM sqlgen_docs WHERE status IN ({1}, {2}, {3})',
        params: ['a', 'b', 'c'],
    },
    {
        // SqlGeneration: 'continues placeholder numbering after an IN'
        name: 'placeholder numbering continues after in',
        model: {
            table: 'sqlgen_docs',
            where: {
                op: 'and',
                parts: [
                    { op: 'in', left: col('status'), values: ['a', 'b', 'c'] },
                    { op: 'eq', left: col('title'), value: 't' },
                ],
            },
        },
        text: 'SELECT * FROM sqlgen_docs WHERE status IN ({1}, {2}, {3}) AND title = {4}',
        params: ['a', 'b', 'c', 't'],
    },
    {
        // SqlGeneration: 'set and null operators (I4)' NOT IN
        name: 'notIn',
        model: {
            table: 'sqlgen_docs',
            where: { op: 'notIn', left: col('status'), values: ['a', 'b'] },
        },
        text: 'SELECT * FROM sqlgen_docs WHERE status NOT IN ({1}, {2})',
        params: ['a', 'b'],
    },
    {
        // SqlGeneration: 'compiles an empty IN to 1 = 0 and keeps the following placeholder at $1'
        name: 'empty in is 1 = 0 and binds nothing',
        model: {
            table: 'sqlgen_docs',
            where: {
                op: 'and',
                parts: [
                    { op: 'in', left: col('status'), values: [] },
                    { op: 'eq', left: col('title'), value: 't' },
                ],
            },
        },
        text: 'SELECT * FROM sqlgen_docs WHERE 1 = 0 AND title = {1}',
        params: ['t'],
    },
    {
        // SqlGeneration: 'compiles an empty NOT IN to 1 = 1'
        name: 'empty notIn is 1 = 1',
        model: {
            table: 'sqlgen_docs',
            where: { op: 'notIn', left: col('status'), values: [] },
        },
        text: 'SELECT * FROM sqlgen_docs WHERE 1 = 1',
        params: [],
    },
    {
        // SqlGeneration: 'set and null operators (I4)' IS NULL
        name: 'isNull',
        model: { table: 'sqlgen_docs', where: { op: 'isNull', left: col('deletedat') } },
        text: 'SELECT * FROM sqlgen_docs WHERE deletedat IS NULL',
        params: [],
    },
    {
        // SqlGeneration: 'set and null operators (I4)' IS NOT NULL
        name: 'isNotNull',
        model: { table: 'sqlgen_docs', where: { op: 'isNotNull', left: col('deletedat') } },
        text: 'SELECT * FROM sqlgen_docs WHERE deletedat IS NOT NULL',
        params: [],
    },
    {
        name: 'between binds two params',
        model: {
            table: T,
            where: {
                op: 'and',
                parts: [
                    { op: 'eq', left: col('name'), value: 'n' },
                    { op: 'between', left: col('age'), low: 18, high: 65 },
                ],
            },
        },
        text: `SELECT * FROM ${T} WHERE name = {1} AND age BETWEEN {2} AND {3}`,
        params: ['n', 18, 65],
    },
    {
        name: 'nested or inside and is parenthesised',
        model: {
            table: T,
            where: {
                op: 'and',
                parts: [
                    { op: 'gt', left: col('age'), value: 18 },
                    {
                        op: 'or',
                        parts: [
                            { op: 'eq', left: col('name'), value: 'a' },
                            { op: 'eq', left: col('name'), value: 'b' },
                        ],
                    },
                ],
            },
        },
        text: `SELECT * FROM ${T} WHERE age > {1} AND (name = {2} OR name = {3})`,
        params: [18, 'a', 'b'],
    },
    {
        name: 'not wraps its operand',
        model: {
            table: T,
            where: {
                op: 'not',
                part: {
                    op: 'and',
                    parts: [
                        { op: 'eq', left: col('name'), value: 'a' },
                        { op: 'isNull', left: col('age') },
                    ],
                },
            },
        },
        text: `SELECT * FROM ${T} WHERE NOT (name = {1} AND age IS NULL)`,
        params: ['a'],
    },
    {
        name: 'and inside or inside not',
        model: {
            table: T,
            where: {
                op: 'or',
                parts: [
                    {
                        op: 'and',
                        parts: [
                            { op: 'eq', left: col('a'), value: 1 },
                            { op: 'eq', left: col('b'), value: 2 },
                        ],
                    },
                    { op: 'not', part: { op: 'eq', left: col('c'), value: 3 } },
                ],
            },
        },
        text: `SELECT * FROM ${T} WHERE (a = {1} AND b = {2}) OR NOT (c = {3})`,
        params: [1, 2, 3],
    },
    {
        // SqlGeneration: 'generates SUM' / 'generates AVG' / 'generates MIN' / 'generates MAX'
        name: 'scalar aggregates',
        model: {
            table: T,
            items: [
                { operand: agg('sum', 'age'), alias: 'total' },
                { operand: agg('avg', 'age'), alias: 'avg' },
                { operand: agg('min', 'age'), alias: 'min' },
                { operand: agg('max', 'age'), alias: 'max' },
                { operand: agg('count'), alias: 'count' },
            ],
        },
        text: `SELECT SUM(age) as total, AVG(age) as avg, MIN(age) as min, MAX(age) as max, COUNT(*) as count FROM ${T}`,
        params: [],
    },
    {
        // SqlGeneration: 'generates GROUP BY with SQL aggregates'
        name: 'group by with aggregate projections',
        model: {
            table: T,
            items: [
                { operand: col('age') },
                { operand: agg('count'), alias: 'count' },
                { operand: agg('sum', 'age'), alias: 'total' },
            ],
            groupBy: ['age'],
        },
        text: `SELECT age, COUNT(*) as count, SUM(age) as total FROM ${T} GROUP BY age`,
        params: [],
    },
    {
        // SqlGeneration: 'aliases the group key via g.key...'
        name: 'group key alias',
        model: {
            table: 'sqlgen_accounts',
            items: [
                { operand: col('full_name'), alias: 'dept' },
                { operand: agg('sum', 'acct_balance'), alias: 'total' },
            ],
            groupBy: ['full_name'],
        },
        text: 'SELECT full_name AS dept, SUM(acct_balance) as total FROM sqlgen_accounts GROUP BY full_name',
        params: [],
    },
    {
        // SqlGeneration: 'generates HAVING with parameters'
        name: 'having with a parameter',
        model: {
            table: T,
            items: [{ operand: col('age') }, { operand: agg('count'), alias: 'count' }],
            groupBy: ['age'],
            having: { op: 'gt', left: agg('count'), value: 5 },
        },
        text: `SELECT age, COUNT(*) as count FROM ${T} GROUP BY age HAVING COUNT(*) > {1}`,
        params: [5],
    },
    {
        name: 'where params come before having params',
        model: {
            table: T,
            items: [{ operand: col('age') }, { operand: agg('count'), alias: 'n' }],
            where: { op: 'like', left: col('name'), value: 'A%' },
            groupBy: ['age'],
            having: { op: 'gte', left: agg('sum', 'age'), value: 10 },
        },
        text: `SELECT age, COUNT(*) as n FROM ${T} WHERE name LIKE {1} GROUP BY age HAVING SUM(age) >= {2}`,
        params: ['A%', 10],
    },
    {
        name: 'aggregates carry a column type and still render the same text',
        model: {
            table: T,
            items: [
                { operand: { kind: 'agg', fn: 'sum', column: 'age', columnType: 'float' }, alias: 'total' },
                { operand: { kind: 'agg', fn: 'avg', column: 'age', columnType: 'float' }, alias: 'mean' },
                { operand: { kind: 'agg', fn: 'min', column: 'age', columnType: 'int' }, alias: 'lo' },
                { operand: { kind: 'agg', fn: 'max', column: 'age', columnType: 'int' }, alias: 'hi' },
            ],
        },
        text: `SELECT SUM(age) as total, AVG(age) as mean, MIN(age) as lo, MAX(age) as hi FROM ${T}`,
        params: [],
    },
    {
        name: 'having over a typed aggregate with where params first',
        model: {
            table: T,
            items: [{ operand: col('age') }, { operand: agg('count'), alias: 'n' }],
            where: { op: 'gt', left: col('age'), value: 18 },
            groupBy: ['age'],
            having: {
                op: 'and',
                parts: [
                    { op: 'gt', left: { kind: 'agg', fn: 'avg', column: 'age', columnType: 'decimal' }, value: 30 },
                    { op: 'lte', left: agg('count'), value: 9 },
                ],
            },
        },
        text: `SELECT age, COUNT(*) as n FROM ${T} WHERE age > {1} GROUP BY age HAVING AVG(age) > {2} AND COUNT(*) <= {3}`,
        params: [18, 30, 9],
    },
    {
        name: 'order by column and alias',
        model: {
            table: T,
            items: [{ operand: agg('count'), alias: 'n' }, { operand: col('age') }],
            groupBy: ['age'],
            orderBy: [
                { operand: col('n'), direction: 'desc' },
                { operand: col('age'), direction: 'asc' },
            ],
        },
        text: `SELECT COUNT(*) as n, age FROM ${T} GROUP BY age ORDER BY n DESC, age ASC`,
        params: [],
    },
    {
        name: 'empty and renders as always true',
        model: { table: T, where: { op: 'and', parts: [] } },
        text: `SELECT * FROM ${T} WHERE 1 = 1`,
        params: [],
    },
    {
        name: 'empty or renders as always false',
        model: { table: T, where: { op: 'or', parts: [] } },
        text: `SELECT * FROM ${T} WHERE 1 = 0`,
        params: [],
    },
];

describe('SelectTranslator shared rendering', () => {
    for (const dialect of dialects) {
        describe(dialect, () => {
            it.each(shared.map((c) => [c.name, c] as const))('%s', (_name, c) => {
                expect(translators[dialect].translateSelect(c.model)).toEqual({
                    text: fill(c.text, dialect),
                    params: c.params,
                });
            });
        });
    }
});

describe('SelectTranslator ilike', () => {
    const model: SelectModel = {
        table: T,
        where: { op: 'ilike', left: col('name'), value: 'a%' },
    };
    const expected: Record<Dialect, string> = {
        postgresql: `SELECT * FROM ${T} WHERE name ILIKE $1`,
        mssql: `SELECT * FROM ${T} WHERE LOWER(name) LIKE LOWER(@p0)`,
        mariadb: `SELECT * FROM ${T} WHERE LOWER(name) LIKE LOWER(?)`,
    };
    it.each(dialects)('%s', (dialect) => {
        expect(translators[dialect].translateSelect(model)).toEqual({
            text: expected[dialect],
            params: ['a%'],
        });
    });
});

describe('SelectTranslator pagination', () => {
    const where: Predicate = { op: 'gt', left: col('age'), value: 18 };
    const ordered = { orderBy: [{ operand: col('name'), direction: 'asc' as const }] };

    interface PageCase {
        name: string;
        model: SelectModel;
        text: Record<Dialect, string>;
        params: QueryParameter[];
    }

    const cases: PageCase[] = [
        {
            // SqlGeneration: 'generates LIMIT/OFFSET pagination on postgresql' and its mariadb / mssql twins
            name: 'where, order by, skip and take',
            model: { table: T, where, ...ordered, skip: 5, take: 10 },
            text: {
                postgresql: `SELECT * FROM ${T} WHERE age > $1 ORDER BY name ASC LIMIT 10 OFFSET 5`,
                mariadb: `SELECT * FROM ${T} WHERE age > ? ORDER BY name ASC LIMIT 10 OFFSET 5`,
                mssql: `SELECT * FROM ${T} WHERE age > @p0 ORDER BY name ASC OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY`,
            },
            params: [18],
        },
        {
            // SqlGeneration: 'injects ORDER BY (SELECT NULL) for mssql pagination without orderBy'
            name: 'skip and take without order by',
            model: { table: T, skip: 5, take: 10 },
            text: {
                postgresql: `SELECT * FROM ${T} LIMIT 10 OFFSET 5`,
                mariadb: `SELECT * FROM ${T} LIMIT 10 OFFSET 5`,
                mssql: `SELECT * FROM ${T} ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY`,
            },
            params: [],
        },
        {
            name: 'take only',
            model: { table: T, take: 10 },
            text: {
                postgresql: `SELECT * FROM ${T} LIMIT 10`,
                mariadb: `SELECT * FROM ${T} LIMIT 10`,
                mssql: `SELECT * FROM ${T} ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY`,
            },
            params: [],
        },
        {
            name: 'take only with order by',
            model: { table: T, ...ordered, take: 10 },
            text: {
                postgresql: `SELECT * FROM ${T} ORDER BY name ASC LIMIT 10`,
                mariadb: `SELECT * FROM ${T} ORDER BY name ASC LIMIT 10`,
                mssql: `SELECT * FROM ${T} ORDER BY name ASC OFFSET 0 ROWS FETCH NEXT 10 ROWS ONLY`,
            },
            params: [],
        },
        {
            // Today MariaDB renders a bare OFFSET here, which is a syntax error.
            name: 'skip only',
            model: { table: T, skip: 5 },
            text: {
                postgresql: `SELECT * FROM ${T} OFFSET 5`,
                mariadb: `SELECT * FROM ${T} LIMIT 18446744073709551615 OFFSET 5`,
                mssql: `SELECT * FROM ${T} ORDER BY (SELECT NULL) OFFSET 5 ROWS`,
            },
            params: [],
        },
        {
            name: 'skip only with order by',
            model: { table: T, ...ordered, skip: 5 },
            text: {
                postgresql: `SELECT * FROM ${T} ORDER BY name ASC OFFSET 5`,
                mariadb: `SELECT * FROM ${T} ORDER BY name ASC LIMIT 18446744073709551615 OFFSET 5`,
                mssql: `SELECT * FROM ${T} ORDER BY name ASC OFFSET 5 ROWS`,
            },
            params: [],
        },
        {
            // SqlGeneration: 'uses LIMIT/OFFSET for grouped pagination on postgresql' and 'uses OFFSET/FETCH for grouped pagination on mssql'
            name: 'grouped skip and take',
            model: {
                table: T,
                items: [{ operand: col('age') }, { operand: agg('count'), alias: 'count' }],
                groupBy: ['age'],
                skip: 2,
                take: 3,
            },
            text: {
                postgresql: `SELECT age, COUNT(*) as count FROM ${T} GROUP BY age LIMIT 3 OFFSET 2`,
                mariadb: `SELECT age, COUNT(*) as count FROM ${T} GROUP BY age LIMIT 3 OFFSET 2`,
                mssql: `SELECT age, COUNT(*) as count FROM ${T} GROUP BY age ORDER BY (SELECT NULL) OFFSET 2 ROWS FETCH NEXT 3 ROWS ONLY`,
            },
            params: [],
        },
    ];

    for (const dialect of dialects) {
        describe(dialect, () => {
            it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
                expect(translators[dialect].translateSelect(c.model)).toEqual({
                    text: c.text[dialect],
                    params: c.params,
                });
            });
        });
    }
});

describe('SelectTranslator dialect differences', () => {
    it('one model differs only in placeholders and pagination', () => {
        const model: SelectModel = {
            table: T,
            distinct: true,
            items: [{ operand: col('name') }, { operand: col('age'), alias: 'a' }],
            where: {
                op: 'and',
                parts: [
                    { op: 'in', left: col('age'), values: [1, 2] },
                    { op: 'between', left: col('age'), low: 3, high: 4 },
                ],
            },
            orderBy: [{ operand: col('name'), direction: 'desc' }],
            skip: 1,
            take: 2,
        };
        const out = dialects.map((d) => translators[d].translateSelect(model));

        for (const o of out) expect(o.params).toEqual([1, 2, 3, 4]);

        const normalise = (text: string) =>
            text
                .replace(/\$\d+|@p\d+|\?/g, '#')
                .replace(/ LIMIT 2 OFFSET 1| OFFSET 1 ROWS FETCH NEXT 2 ROWS ONLY/, ' PAGE');
        const normalised = out.map((o) => normalise(o.text));
        expect(new Set(normalised).size).toBe(1);
        expect(normalised[0]).toBe(
            `SELECT DISTINCT name, age AS a FROM ${T} WHERE age IN (#, #) AND age BETWEEN # AND # ORDER BY name DESC PAGE`
        );
    });

    it('is pure: translating twice gives the same statement', () => {
        const model: SelectModel = { table: T, where: { op: 'eq', left: col('a'), value: 1 } };
        const t = translators.postgresql;
        expect(t.translateSelect(model)).toEqual(t.translateSelect(model));
    });
});

describe('SelectTranslator exact decimal aggregates', () => {
    const typed = (fn: 'sum' | 'avg' | 'min' | 'max', columnType?: string): Operand => ({
        kind: 'agg',
        fn,
        column: 'amount',
        columnType,
    });
    const selectOf = (operand: Operand): SelectModel => ({ table: T, items: [{ operand, alias: 'total' }] });

    it('casts sum over a decimal column to text on mssql only', () => {
        const model = selectOf(typed('sum', 'decimal'));
        expect(translators.mssql.translateSelect(model).text).toBe(
            `SELECT CAST(SUM(amount) AS NVARCHAR(MAX)) as total FROM ${T}`
        );
        expect(translators.postgresql.translateSelect(model).text).toBe(`SELECT SUM(amount) as total FROM ${T}`);
        expect(translators.mariadb.translateSelect(model).text).toBe(`SELECT SUM(amount) as total FROM ${T}`);
    });

    it.each(['decimal(38,10)', 'DECIMAL(10,2)', 'numeric(18,4)', 'numeric', 'dec(18,2)'])('casts sum and avg over %s', (type) => {
        expect(translators.mssql.translateSelect(selectOf(typed('sum', type))).text).toContain(
            'CAST(SUM(amount) AS NVARCHAR(MAX))'
        );
        expect(translators.mssql.translateSelect(selectOf(typed('avg', type))).text).toContain(
            'CAST(AVG(amount) AS NVARCHAR(MAX))'
        );
    });

    it.each(['float', 'real', 'double precision', 'int', 'integer', 'bigint', 'varchar(20)', undefined])(
        'leaves %s columns alone',
        (type) => {
            expect(translators.mssql.translateSelect(selectOf(typed('sum', type))).text).toBe(
                `SELECT SUM(amount) as total FROM ${T}`
            );
        }
    );

    it('does not cast min, max or count', () => {
        for (const fn of ['min', 'max'] as const) {
            expect(translators.mssql.translateSelect(selectOf(typed(fn, 'decimal'))).text).not.toContain('CAST');
        }
        expect(translators.mssql.translateSelect(selectOf({ kind: 'agg', fn: 'count' })).text).not.toContain('CAST');
    });

    it('never casts inside HAVING or ORDER BY, only in the select list', () => {
        const model: SelectModel = {
            table: T,
            items: [
                { operand: col('name') },
                { operand: typed('sum', 'decimal(38,10)'), alias: 'total' },
            ],
            groupBy: ['name'],
            having: { op: 'gt', left: typed('sum', 'decimal(38,10)'), value: 5 },
            orderBy: [{ operand: typed('sum', 'decimal(38,10)'), direction: 'desc' }],
        };
        expect(translators.mssql.translateSelect(model).text).toBe(
            `SELECT name, CAST(SUM(amount) AS NVARCHAR(MAX)) as total FROM ${T} GROUP BY name HAVING SUM(amount) > @p0 ORDER BY SUM(amount) DESC`
        );
    });
});

describe('SelectTranslator mssql average over integer columns', () => {
    const avgOf = (columnType?: string): Operand => ({ kind: 'agg', fn: 'avg', column: 'qty', columnType });

    it.each(['int', 'integer', 'bigint', 'smallint', 'tinyint', 'INT'])('widens avg over %s on mssql only', (type) => {
        const model: SelectModel = { table: T, items: [{ operand: avgOf(type), alias: 'mean' }] };
        expect(translators.mssql.translateSelect(model).text).toBe(
            `SELECT AVG(CAST(qty AS DECIMAL(38,6))) as mean FROM ${T}`
        );
        expect(translators.postgresql.translateSelect(model).text).toBe(`SELECT AVG(qty) as mean FROM ${T}`);
        expect(translators.mariadb.translateSelect(model).text).toBe(`SELECT AVG(qty) as mean FROM ${T}`);
    });

    it('widens in HAVING too, so the comparison matches the other dialects', () => {
        const model: SelectModel = {
            table: T,
            groupBy: ['grp'],
            having: { op: 'gt', left: avgOf('int'), value: 1 },
        };
        expect(translators.mssql.translateSelect(model).text).toBe(
            `SELECT * FROM ${T} GROUP BY grp HAVING AVG(CAST(qty AS DECIMAL(38,6))) > @p0`
        );
    });

    it('leaves avg over float and untyped columns alone, and sum over integers', () => {
        for (const type of ['float', 'real', undefined]) {
            const model: SelectModel = { table: T, items: [{ operand: avgOf(type), alias: 'mean' }] };
            expect(translators.mssql.translateSelect(model).text).toBe(`SELECT AVG(qty) as mean FROM ${T}`);
        }
        const sum: SelectModel = {
            table: T,
            items: [{ operand: { kind: 'agg', fn: 'sum', column: 'qty', columnType: 'int' }, alias: 's' }],
        };
        expect(translators.mssql.translateSelect(sum).text).toBe(`SELECT SUM(qty) as s FROM ${T}`);
    });
});

describe('SelectTranslator ordering by an aggregate alias', () => {
    const sumOf = (columnType: string): Operand => ({ kind: 'agg', fn: 'sum', column: 'amount', columnType });
    const byAlias = (columnType: string): SelectModel => ({
        table: T,
        items: [{ operand: col('grp') }, { operand: sumOf(columnType), alias: 'total' }],
        groupBy: ['grp'],
        orderBy: [{ operand: col('total'), direction: 'desc' }],
    });

    it('sorts by the numeric aggregate on mssql, not the NVARCHAR alias', () => {
        expect(translators.mssql.translateSelect(byAlias('decimal(38,10)')).text).toBe(
            `SELECT grp, CAST(SUM(amount) AS NVARCHAR(MAX)) as total FROM ${T} GROUP BY grp ORDER BY SUM(amount) DESC`
        );
    });

    it('keeps ORDER BY total on postgres and mariadb', () => {
        const expected = `SELECT grp, SUM(amount) as total FROM ${T} GROUP BY grp ORDER BY total DESC`;
        expect(translators.postgresql.translateSelect(byAlias('decimal(38,10)')).text).toBe(expected);
        expect(translators.mariadb.translateSelect(byAlias('decimal(38,10)')).text).toBe(expected);
    });

    it('keeps ORDER BY total on mssql when the alias was not cast', () => {
        expect(translators.mssql.translateSelect(byAlias('float')).text).toBe(
            `SELECT grp, SUM(amount) as total FROM ${T} GROUP BY grp ORDER BY total DESC`
        );
    });

    it('leaves decimal avg in the select list as plain AVG on postgres and mariadb', () => {
        const model: SelectModel = {
            table: T,
            items: [{ operand: { kind: 'agg', fn: 'avg', column: 'amount', columnType: 'decimal' }, alias: 'mean' }],
        };
        expect(translators.postgresql.translateSelect(model).text).toBe(`SELECT AVG(amount) as mean FROM ${T}`);
        expect(translators.mariadb.translateSelect(model).text).toBe(`SELECT AVG(amount) as mean FROM ${T}`);
    });
});
