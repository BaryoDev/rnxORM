import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
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

let currentTenant = 1;

beforeAll(() => {
    const builder = new ModelBuilder();
    builder.entity(QfDoc).hasQueryFilter({ property: 'isdeleted', operator: '=', value: false });
    builder.entity(QfOrder).hasQueryFilter({ property: 'tenantid', operator: '=', value: () => currentTenant });
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
