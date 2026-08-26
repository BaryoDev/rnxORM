import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

@Entity('qf_docs')
class QfDoc {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @Column()
    isdeleted!: boolean;
}

@Entity('qf_orders')
class QfOrder {
    @PrimaryKey()
    id!: number;

    @Column()
    tenantid!: number;

    @Column()
    total!: number;
}

@Entity('qf_plain')
class QfPlain {
    @PrimaryKey()
    id!: number;

    @Column()
    label!: string;
}

@Entity('qf_tagged')
class QfTagged {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @Column()
    status!: string;
}

@Entity('qf_soft')
class QfSoft {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @Column()
    deletedAt!: Date | null;
}

@Entity('qf_badop')
class QfBadOp {
    @PrimaryKey()
    id!: number;

    @Column()
    label!: string;
}

let currentTenant = 1;

beforeAll(() => {
    const builder = new ModelBuilder();
    builder.entity(QfDoc).hasQueryFilter({ property: 'isdeleted', operator: '=', value: false });
    builder.entity(QfOrder).hasQueryFilter({ property: 'tenantid', operator: '=', value: () => currentTenant });
    builder.entity(QfTagged).hasQueryFilter({ property: 'status', operator: 'IN', value: ['live', 'draft'] });
    builder.entity(QfSoft).hasQueryFilter({ property: 'deletedAt', operator: 'IS', value: null });
});

function makeDb(dialect: CaptureDialect = 'postgresql'): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider(dialect);
    const db = new DbContext(provider);
    return { db, provider };
}

describe('SQL-translated global query filters', () => {
    it('applies the filter to plain toList()', async () => {
        const { db, provider } = makeDb();
        await db.set(QfDoc).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_docs WHERE isdeleted = $1');
        expect(provider.lastCall!.params).toEqual([false]);
    });

    it('does not modify SQL for entities without filters', async () => {
        const { db, provider } = makeDb();
        await db.set(QfPlain).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_plain');
        expect(provider.lastCall!.params).toBeUndefined();
    });

    it('appends the filter after user conditions in where() chains', async () => {
        const { db, provider } = makeDb();
        await db.set(QfDoc).where('title', '=', 'Spec').toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_docs WHERE title = $1 AND isdeleted = $2');
        expect(provider.lastCall!.params).toEqual(['Spec', false]);
    });

    it('numbers placeholders correctly on mssql', async () => {
        const { db, provider } = makeDb('mssql');
        await db.set(QfDoc).where('title', '=', 'Spec').toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_docs WHERE title = @p0 AND isdeleted = @p1');
    });

    it('uses positional placeholders on mariadb', async () => {
        const { db, provider } = makeDb('mariadb');
        await db.set(QfDoc).where('title', '=', 'Spec').toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_docs WHERE title = ? AND isdeleted = ?');
        expect(provider.lastCall!.params).toEqual(['Spec', false]);
    });

    it('applies the filter to find()', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, title: 'Spec', isdeleted: false }], rowCount: 1 });
        const doc = await db.set(QfDoc).find(1);

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_docs WHERE id = $1 AND isdeleted = $2');
        expect(provider.lastCall!.params).toEqual([1, false]);
        expect(doc!.title).toBe('Spec');
    });

    it('applies the filter to DbSet count()', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '3' }], rowCount: 1 });
        const count = await db.set(QfDoc).count();

        expect(provider.lastCall!.sql).toBe('SELECT COUNT(*) as count FROM qf_docs WHERE isdeleted = $1');
        expect(count).toBe(3);
    });

    it('applies the filter to DbSet aggregates', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ total: '99' }], rowCount: 1 });
        await db.set(QfOrder).sum(o => o.total);

        expect(provider.lastCall!.sql).toBe('SELECT SUM(total) as total FROM qf_orders WHERE tenantid = $1');
        expect(provider.lastCall!.params).toEqual([1]);
    });

    it('applies the filter to QueryBuilder count() after user conditions', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '2' }], rowCount: 1 });
        await db.set(QfDoc).where('title', '=', 'Spec').count();

        expect(provider.lastCall!.sql).toBe('SELECT COUNT(*) as count FROM qf_docs WHERE title = $1 AND isdeleted = $2');
        expect(provider.lastCall!.params).toEqual(['Spec', false]);
    });

    it('applies the filter to QueryBuilder aggregates', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ avg: '10' }], rowCount: 1 });
        await db.set(QfOrder).where('total', '>', 5).average(o => o.total);

        expect(provider.lastCall!.sql).toBe('SELECT AVG(total) as avg FROM qf_orders WHERE total > $1 AND tenantid = $2');
        expect(provider.lastCall!.params).toEqual([5, 1]);
    });

    it('applies the filter to select() projections', async () => {
        const { db, provider } = makeDb();
        await db.set(QfDoc).select(d => ({ title: d.title })).toList();

        expect(provider.lastCall!.sql).toBe('SELECT title AS title FROM qf_docs WHERE isdeleted = $1');
        expect(provider.lastCall!.params).toEqual([false]);
    });

    it('resolves dynamic filter values at query time', async () => {
        const { db, provider } = makeDb();

        currentTenant = 7;
        await db.set(QfOrder).toList();
        expect(provider.lastCall!.params).toEqual([7]);

        currentTenant = 8;
        await db.set(QfOrder).toList();
        expect(provider.lastCall!.params).toEqual([8]);

        currentTenant = 1;
    });

    it('supports multiple filter conditions', async () => {
        @Entity('qf_multi')
        class QfMulti {
            @PrimaryKey()
            id!: number;

            @Column()
            isdeleted!: boolean;

            @Column()
            isarchived!: boolean;
        }
        new ModelBuilder().entity(QfMulti).hasQueryFilter([
            { property: 'isdeleted', operator: '=', value: false },
            { property: 'isarchived', operator: '=', value: false },
        ]);

        const { db, provider } = makeDb();
        await db.set(QfMulti).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_multi WHERE isdeleted = $1 AND isarchived = $2');
        expect(provider.lastCall!.params).toEqual([false, false]);
    });

    it('throws on a filter referencing an unknown property', async () => {
        @Entity('qf_bad')
        class QfBad {
            @PrimaryKey()
            id!: number;
        }
        new ModelBuilder().entity(QfBad).hasQueryFilter({ property: 'nope', operator: '=', value: 1 });

        const { db } = makeDb();
        await expect(db.set(QfBad).toList()).rejects.toThrow(/unknown property 'nope'/);
    });
});

describe('ignoreQueryFilters()', () => {
    it('bypasses the SQL filter on DbSet', async () => {
        const { db, provider } = makeDb();
        await db.set(QfDoc).ignoreQueryFilters().toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_docs');
        expect(provider.lastCall!.params).toEqual([]);
    });

    it('bypasses the SQL filter in where() chains', async () => {
        const { db, provider } = makeDb();
        await db.set(QfDoc).where('title', '=', 'Spec').ignoreQueryFilters().toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_docs WHERE title = $1');
        expect(provider.lastCall!.params).toEqual(['Spec']);
    });

    it('carries over into select() projections', async () => {
        const { db, provider } = makeDb();
        await db.set(QfDoc).where('title', '=', 'Spec').ignoreQueryFilters().select(d => ({ title: d.title })).toList();

        expect(provider.lastCall!.sql).toBe('SELECT title AS title FROM qf_docs WHERE title = $1');
    });
});

describe('query filters on raw SQL', () => {
    it('filters raw SQL results in memory using structured conditions', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, title: 'Kept', isdeleted: false },
                { id: 2, title: 'Dropped', isdeleted: true },
            ],
            rowCount: 2,
        });

        const docs = await db.set(QfDoc).fromSqlRaw('SELECT * FROM qf_docs').toList();

        expect(docs).toHaveLength(1);
        expect(docs[0].title).toBe('Kept');
    });
});

/**
 * Query filters that use the set/null operators (I4). compileQueryFilter numbers
 * its placeholders from `startIndex + compiled.params.length`, and QueryBuilder
 * hands it `this.params.length + 1`. Both must account for an IN condition
 * consuming N parameters and an IS condition consuming none.
 *
 * Hand-traced (postgres), user conditions are emitted before filter clauses:
 *   .where('title','=','x')                  user params 0 -> $1        (1 param)
 *   filter status IN ['live','draft']        startIndex 2 -> $2, $3     (2 params)
 */
describe('query filters using set and null operators', () => {
    it.each([
        ['postgresql', 'SELECT * FROM qf_tagged WHERE status IN ($1, $2)'],
        ['mssql', 'SELECT * FROM qf_tagged WHERE status IN (@p0, @p1)'],
        ['mariadb', 'SELECT * FROM qf_tagged WHERE status IN (?, ?)'],
    ])('expands an IN filter on plain toList() (%s)', async (dialect, expected) => {
        const { db, provider } = makeDb(dialect as CaptureDialect);
        await db.set(QfTagged).toList();

        expect(provider.lastCall!.sql).toBe(expected);
        expect(provider.lastCall!.params).toEqual(['live', 'draft']);
    });

    it.each([
        ['postgresql', 'SELECT * FROM qf_tagged WHERE title = $1 AND status IN ($2, $3)'],
        ['mssql', 'SELECT * FROM qf_tagged WHERE title = @p0 AND status IN (@p1, @p2)'],
        ['mariadb', 'SELECT * FROM qf_tagged WHERE title = ? AND status IN (?, ?)'],
    ])('numbers an IN filter after the user conditions (%s)', async (dialect, expected) => {
        const { db, provider } = makeDb(dialect as CaptureDialect);
        await db.set(QfTagged).where('title', '=', 'x').toList();

        expect(provider.lastCall!.sql).toBe(expected);
        expect(provider.lastCall!.params).toEqual(['x', 'live', 'draft']);
    });

    it('composes a user IN condition with an IN filter', async () => {
        const { db, provider } = makeDb();
        await db.set(QfTagged).where('title', 'IN', ['a', 'b']).where('id', '>', 3).toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM qf_tagged WHERE title IN ($1, $2) AND id > $3 AND status IN ($4, $5)'
        );
        expect(provider.lastCall!.params).toEqual(['a', 'b', 3, 'live', 'draft']);
    });

    it('numbers an IN filter after the primary key in find()', async () => {
        const { db, provider } = makeDb();
        await db.set(QfTagged).find(7);

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM qf_tagged WHERE id = $1 AND status IN ($2, $3)'
        );
        expect(provider.lastCall!.params).toEqual([7, 'live', 'draft']);
    });

    it('applies an IN filter to aggregates and grouped queries', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '2' }], rowCount: 1 });
        await db.set(QfTagged).count();
        expect(provider.lastCall!.sql).toBe('SELECT COUNT(*) as count FROM qf_tagged WHERE status IN ($1, $2)');

        await db.set(QfTagged).groupBy(t => t.status).having('COUNT(*)', '>', 1)
            .select(g => ({ n: g.count() })).toList();
        expect(provider.lastCall!.sql).toBe(
            'SELECT status, COUNT(*) as n FROM qf_tagged WHERE status IN ($1, $2) GROUP BY status HAVING COUNT(*) > $3'
        );
        expect(provider.lastCall!.params).toEqual(['live', 'draft', 1]);
    });

    it('emits an IS NULL filter without consuming a placeholder', async () => {
        const { db, provider } = makeDb();
        await db.set(QfSoft).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_soft WHERE deletedat IS NULL');
        expect(provider.lastCall!.params).toEqual([]);
    });

    it('keeps the user placeholder at $1 alongside an IS NULL filter', async () => {
        const { db, provider } = makeDb();
        await db.set(QfSoft).where('title', '=', 'x').toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_soft WHERE title = $1 AND deletedat IS NULL');
        expect(provider.lastCall!.params).toEqual(['x']);
    });
});

describe('query filter operators are validated at registration time', () => {
    it('rejects an unsupported operator when hasQueryFilter() is called', () => {
        const builder = new ModelBuilder();
        expect(() =>
            builder.entity(QfBadOp).hasQueryFilter({ property: 'label', operator: 'BETWEEN', value: 1 })
        ).toThrow(/hasQueryFilter/);
    });

    it('rejects an unsupported operator inside an array of conditions', () => {
        const builder = new ModelBuilder();
        expect(() =>
            builder.entity(QfBadOp).hasQueryFilter([
                { property: 'label', operator: '=', value: 'a' },
                { property: 'label', operator: '; DROP TABLE qf_badop --', value: 'b' },
            ])
        ).toThrow(/not supported/);
    });

    it('registers nothing when a condition is rejected', async () => {
        const { db, provider } = makeDb();
        await db.set(QfBadOp).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qf_badop');
    });

    it('still validates at compile time when metadata is mutated directly', async () => {
        const { db } = makeDb();
        const metadata = MetadataStorage.get().getEntity(QfBadOp)!;
        metadata.queryFilterConditions = [{ property: 'label', operator: 'OR 1=1 --', value: 'x' } as any];

        await expect(db.set(QfBadOp).toList()).rejects.toThrow(/not supported/);

        metadata.queryFilterConditions = undefined;
    });
});
