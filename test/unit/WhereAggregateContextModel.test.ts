import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { eq, gt } from '../../src/core/expressions/conditions';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

@Entity('wa_users')
class WaUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    salary!: number;
}

class RenamedContext extends DbContext {
    protected onModelCreating(mb: ModelBuilder): void {
        mb.entity(WaUser).property(u => u.name).hasColumnName('full_name');
        mb.entity(WaUser).property(u => u.salary).hasColumnName('pay');
    }
}

describe('where and aggregates resolve columns against the context model', () => {
    function setup() {
        const p = new SqlCaptureProvider('postgresql');
        p.defaultResult = { rows: [{ total: 1, avg: 1, min: 1, max: 1, count: 1 }], rowCount: 1 };
        return { p, ctx: new RenamedContext(p) };
    }

    describe('where', () => {
        it('uses the mapped column for a condition lambda on QueryBuilder', async () => {
            const { p, ctx } = setup();
            await ctx.set(WaUser).where(u => eq(u.name, 'a')).toList();
            expect(p.lastCall!.sql).toContain('WHERE full_name');
        });

        it('uses the mapped column for the string form on QueryBuilder', async () => {
            const { p, ctx } = setup();
            await ctx.set(WaUser).where('name', '=', 'a').toList();
            expect(p.lastCall!.sql).toContain('WHERE full_name');
        });

        it('uses the mapped column for a condition lambda on SelectQueryBuilder', async () => {
            const { p, ctx } = setup();
            await ctx.set(WaUser).select(u => ({ n: u.name })).where(u => eq(u.name, 'a')).toList();
            expect(p.lastCall!.sql).toContain('WHERE full_name');
        });

        it('uses the mapped column for the string form on SelectQueryBuilder', async () => {
            const { p, ctx } = setup();
            await ctx.set(WaUser).select(u => ({ n: u.name })).where('name', '=', 'a').toList();
            expect(p.lastCall!.sql).toContain('WHERE full_name');
        });
    });

    describe('aggregates', () => {
        const fns = ['sum', 'average', 'min', 'max'] as const;
        const sqlFn = { sum: 'SUM', average: 'AVG', min: 'MIN', max: 'MAX' };

        for (const fn of fns) {
            it(`${fn} uses the mapped column on DbSet`, async () => {
                const { p, ctx } = setup();
                await (ctx.set(WaUser) as any)[fn]((u: WaUser) => u.salary);
                expect(p.lastCall!.sql).toContain(`${sqlFn[fn]}(pay)`);
            });

            it(`${fn} uses the mapped column on QueryBuilder`, async () => {
                const { p, ctx } = setup();
                await (ctx.set(WaUser).where(u => gt(u.salary, 1)) as any)[fn]((u: WaUser) => u.salary);
                expect(p.lastCall!.sql).toContain(`${sqlFn[fn]}(pay)`);
            });
        }
    });

    describe('grouped queries', () => {
        it('having uses the mapped column', async () => {
            const { p, ctx } = setup();
            await ctx.set(WaUser).groupBy(u => u.name)
                .having('SUM(salary)', '>', 1)
                .select(g => ({ k: g.key, s: g.sum(u => u.salary) }))
                .toList();
            expect(p.lastCall!.sql).toContain('HAVING SUM(pay)');
        });

        it('orderBy uses the mapped column', async () => {
            const { p, ctx } = setup();
            await ctx.set(WaUser).groupBy(u => u.name)
                .orderBy('name')
                .select(g => ({ k: g.key, s: g.sum(u => u.salary) }))
                .toList();
            expect(p.lastCall!.sql).toContain('ORDER BY full_name');
        });

        it('orderByDescending uses the mapped column', async () => {
            const { p, ctx } = setup();
            await ctx.set(WaUser).groupBy(u => u.name)
                .orderByDescending('name')
                .select(g => ({ k: g.key, s: g.sum(u => u.salary) }))
                .toList();
            expect(p.lastCall!.sql).toContain('ORDER BY full_name DESC');
        });
    });
});
