import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

@Entity('sgw_orders')
class SgwOrder {
    @PrimaryKey()
    id!: number;

    @Column()
    cat!: string;

    @Column({ type: 'decimal' })
    total!: number;
}

function makeDb(dialect: CaptureDialect = 'postgresql') {
    const provider = new SqlCaptureProvider(dialect);
    const translator = provider.getTranslator();
    const spy = jest.spyOn(translator, 'translateSelect');
    jest.spyOn(provider, 'getTranslator').mockReturnValue(translator);
    return { db: new DbContext(provider), provider, spy };
}

describe('groupBy().select() aggregate paths', () => {
    it('throws for count() over an unmapped property', async () => {
        const { db, provider } = makeDb();
        await expect(async () => {
            await db.set(SgwOrder).groupBy(o => o.cat)
                .select((g: any) => ({ n: g.count((o: any) => o.nope) })).toList();
        }).rejects.toThrow(/property 'nope' is not a mapped column/);
        expect(provider.calls).toHaveLength(0);
    });

    it('still renders COUNT(*) for count() with no selector', async () => {
        const { db, provider } = makeDb();
        await db.set(SgwOrder).groupBy(o => o.cat).select(g => ({ n: g.count() })).toList();
        expect(provider.lastCall!.sql).toContain('COUNT(*)');
    });
});

describe('columnType reaches the translator', () => {
    it('groupBy().select(g => g.sum(...)) carries the column type', async () => {
        const { db, spy } = makeDb();
        await db.set(SgwOrder).groupBy(o => o.cat)
            .select(g => ({ s: g.sum(o => o.total) })).toList();
        const model = spy.mock.calls[0][0];
        const agg = model.items!.map(i => i.operand).find(o => o.kind === 'agg');
        expect(agg).toMatchObject({ kind: 'agg', fn: 'sum', column: 'total', columnType: 'decimal' });
    });

    it('having over an aggregate carries the column type', async () => {
        const { db, spy } = makeDb();
        await db.set(SgwOrder).groupBy(o => o.cat)
            .having('sum(total)', '>', 10)
            .select(g => ({ n: g.count() })).toList();
        const having = JSON.stringify(spy.mock.calls[0][0].having);
        expect(having).toContain('"columnType":"decimal"');
        expect(having).toContain('"fn":"sum"');
    });

    it('DbSet.sum on a decimal column returns the exact string through the real path', async () => {
        const { db, provider, spy } = makeDb();
        provider.nextResult({ rows: [{ total: '12345678901234567.89' }], rowCount: 1 });
        const total = await db.set(SgwOrder).sum(o => o.total);
        expect(total).toBe('12345678901234567.89');
        const agg = spy.mock.calls[0][0].items![0].operand;
        expect(agg).toMatchObject({ kind: 'agg', fn: 'sum', columnType: 'decimal' });
    });

    it('DbSet.sum returns an ordinary total as a number', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ total: '42.5' }], rowCount: 1 });
        expect(await db.set(SgwOrder).sum(o => o.total)).toBe(42.5);
    });
});

describe('select() pagination text', () => {
    it.each<CaptureDialect>(['postgresql', 'mariadb'])('%s: skip/take with no WHERE or ORDER BY uses one space', async dialect => {
        const { db, provider } = makeDb(dialect);
        await db.set(SgwOrder).select(o => ({ c: o.cat })).take(3).toList();
        expect(provider.lastCall!.sql).toContain('FROM sgw_orders LIMIT 3');
        expect(provider.lastCall!.sql).not.toContain('  ');
    });

    it('mariadb: skip without take renders the largest LIMIT', async () => {
        const { db, provider } = makeDb('mariadb');
        await db.set(SgwOrder).select(o => ({ c: o.cat })).skip(3).toList();
        expect(provider.lastCall!.sql).toContain('FROM sgw_orders LIMIT 18446744073709551615 OFFSET 3');
    });
});
