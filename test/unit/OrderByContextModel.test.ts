import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

@Entity('ob_users')
class ObUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

class RenamedContext extends DbContext {
    protected onModelCreating(mb: ModelBuilder): void {
        mb.entity(ObUser).property(u => u.name).hasColumnName('full_name');
    }
}

describe('orderBy resolves columns against the context model', () => {
    function setup() {
        const p = new SqlCaptureProvider('postgresql');
        return { p, ctx: new RenamedContext(p) };
    }

    it('uses the context column name for a selector on QueryBuilder', async () => {
        const { p, ctx } = setup();
        await ctx.set(ObUser).orderBy(u => u.name).toList();
        expect(p.lastCall!.sql).toContain('ORDER BY full_name ASC');
    });

    it('uses the context column name for a keyof string on QueryBuilder', async () => {
        const { p, ctx } = setup();
        await ctx.set(ObUser).orderByDescending('name').toList();
        expect(p.lastCall!.sql).toContain('ORDER BY full_name DESC');
    });

    it('uses the context column name for a selector on SelectQueryBuilder', async () => {
        const { p, ctx } = setup();
        await ctx.set(ObUser).select(u => ({ n: u.name })).orderBy(u => u.name).toList();
        expect(p.lastCall!.sql).toContain('ORDER BY full_name ASC');
    });

    it('uses the context column name for a keyof string on SelectQueryBuilder', async () => {
        const { p, ctx } = setup();
        await ctx.set(ObUser).select(u => ({ n: u.name })).orderByDescending('name').toList();
        expect(p.lastCall!.sql).toContain('ORDER BY full_name DESC');
    });
});
