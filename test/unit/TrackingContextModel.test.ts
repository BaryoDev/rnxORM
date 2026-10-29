import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { EntityState } from '../../src/core/EntityEntry';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

@Entity('tc_things')
class TcThing {
    @PrimaryKey()
    id!: number;

    @Column()
    code!: string;

    @Column()
    label!: string;
}

class CodeKeyContext extends DbContext {
    protected onModelCreating(mb: ModelBuilder): void {
        mb.entity(TcThing).hasKey(s => s.code);
    }
}

// Not decorated: the shared model has no metadata for it, only this context does,
// and the context maps no columns, so nothing on it is compared.
class TcPlain {
    id!: number;
    note!: string;
}

class PlainContext extends DbContext {
    protected onModelCreating(mb: ModelBuilder): void {
        mb.entity(TcPlain);
    }
}

describe('change tracking reads the context model', () => {
    it('identity map uses the key the context overrides, not the shared one', async () => {
        const p = new SqlCaptureProvider('postgresql');
        p.defaultResult = { rows: [{ id: 7, code: 'X', label: 'a' }], rowCount: 1 };
        const ctx = new CodeKeyContext(p);
        await ctx.set(TcThing).toList();
        expect(ctx.changeTracker.findByKey(TcThing, 'X')).toBeDefined();
        expect(ctx.changeTracker.findByKey(TcThing, 7)).toBeUndefined();
    });

    it('detectChanges and entry state use the context model', () => {
        const ctx = new PlainContext(new SqlCaptureProvider('postgresql'));
        const plain = Object.assign(new TcPlain(), { id: 1, note: 'a' });
        const entry = ctx.changeTracker.track(plain, EntityState.Unchanged);
        plain.note = 'changed';
        expect(entry.getModifiedProperties()).toEqual([]);
        ctx.changeTracker.detectChanges();
        expect(entry.state).toBe(EntityState.Unchanged);
    });
});
