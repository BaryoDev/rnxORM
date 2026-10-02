import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';
import { MockDatabaseProvider } from '../mocks/MockDatabaseProvider';

afterEach(() => {
    MetadataStorage.reset();
});

/**
 * The decorator registry was module-level state. Two copies of the package (a
 * nested node_modules, or src next to dist) meant two registries, and a class
 * re-evaluated in watch mode left its predecessor registered (issue #53).
 */

type Storage = typeof import('../../src/core/MetadataStorage');
type Decorators = typeof import('../../src/decorators');
type Context = typeof import('../../src/core/DbContext');

/** Load a module graph the way a second installed copy of the package would. */
function loadCopy(): { storage: Storage; decorators: Decorators; context: Context } {
    let copy!: { storage: Storage; decorators: Decorators; context: Context };
    jest.isolateModules(() => {
        // isolateModules only isolates require(), not import.
        /* eslint-disable @typescript-eslint/no-require-imports */
        copy = {
            storage: require('../../src/core/MetadataStorage'),
            decorators: require('../../src/decorators'),
            context: require('../../src/core/DbContext'),
        };
        /* eslint-enable @typescript-eslint/no-require-imports */
    });
    return copy;
}

describe('one registry across copies of the package (#53)', () => {
    const a = loadCopy();
    const b = loadCopy();

    it('loads two distinct copies', () => {
        expect(a.storage.MetadataStorage).not.toBe(b.storage.MetadataStorage);
    });

    it('reads an entity registered through the other copy', () => {
        class DupPlain { }
        a.storage.MetadataStorage.shared().addEntity(DupPlain, 'dup_plain');

        expect(b.storage.MetadataStorage.shared().getEntity(DupPlain)?.tableName).toBe('dup_plain');
    });

    it('queries an entity decorated by one copy from a context of the other', async () => {
        @a.decorators.Entity('dup_users')
        class DupUser {
            @a.decorators.PrimaryKey()
            id!: number;
        }

        const p = new SqlCaptureProvider('postgresql');
        const ctx = new b.context.DbContext(p);

        await ctx.set(DupUser).toList();

        expect(p.lastCall!.sql).toBe('SELECT * FROM dup_users');
    });

    it('lets a context of one copy retarget an entity decorated by the other', async () => {
        @a.decorators.Entity('dup_orders')
        class DupOrder {
            @a.decorators.PrimaryKey()
            id!: number;
        }

        class RetargetingContext extends b.context.DbContext {
            protected onModelCreating(mb: any): void {
                mb.entity(DupOrder).toTable('tenant_orders');
            }
        }

        const p = new SqlCaptureProvider('postgresql');
        const ctx = new RetargetingContext(p);
        await ctx.set(DupOrder).toList();

        expect(p.lastCall!.sql).toBe('SELECT * FROM tenant_orders');
        // The scoped model is a copy of what the other copy's decorators
        // registered, not an empty entry created by `mb.entity()`.
        expect(ctx.metadata.getEntity(DupOrder)!.columns.map(c => c.columnName)).toEqual(['id']);
        expect(a.storage.MetadataStorage.shared().getEntity(DupOrder)!.tableName).toBe('dup_orders');
    });

    it('resets the registry for every copy', () => {
        class DupReset { }
        a.storage.MetadataStorage.shared().addEntity(DupReset, 'dup_reset');

        b.storage.MetadataStorage.reset();

        expect(a.storage.MetadataStorage.shared().getEntity(DupReset)).toBeUndefined();
        expect(b.storage.MetadataStorage.shared().getEntity(DupReset)).toBeUndefined();
    });
});

describe('a re-evaluated entity class replaces its predecessor (#53)', () => {
    /** What a watch-mode reload does: the same source evaluated again. */
    function evaluateModule() {
        @Entity('wm_users')
        class WmUser {
            @PrimaryKey()
            id!: number;

            @Column()
            name!: string;
        }
        return WmUser;
    }

    const tablesNamed = (name: string) =>
        MetadataStorage.shared().getEntities().filter(e => e.tableName === name);

    it('lists the table once, as the newest class', () => {
        evaluateModule();
        const reloaded = evaluateModule();

        const entries = tablesNamed('wm_users');
        expect(entries).toHaveLength(1);
        expect(entries[0].target).toBe(reloaded);
    });

    it('still resolves the old class for code holding on to it', () => {
        const old = evaluateModule();
        evaluateModule();

        expect(MetadataStorage.shared().getEntity(old)?.tableName).toBe('wm_users');
    });

    it('still resolves the old class in a context model', () => {
        const old = evaluateModule();
        evaluateModule();

        expect(MetadataStorage.createScopedModel().getEntity(old)?.tableName).toBe('wm_users');
    });

    it('drops superseded registrations from what a context copies', () => {
        for (let i = 0; i < 20; i++) evaluateModule();

        MetadataStorage.createScopedModel();

        // The raw list, which is what every new context clones. getEntities()
        // already hides the predecessors, so it cannot show the growth.
        const raw: { tableName: string }[] = (globalThis as any)[Symbol.for('rnxorm.metadata.v1')].entities;
        expect(raw.filter(e => e.tableName === 'wm_users').length).toBe(1);
    });

    it('drops them for a context that reads the shared registry directly', () => {
        for (let i = 0; i < 20; i++) evaluateModule();

        // A bare DbContext has no scoped model. It lists the shared registry.
        MetadataStorage.shared().getEntities();

        const raw: { tableName: string }[] = (globalThis as any)[Symbol.for('rnxorm.metadata.v1')].entities;
        expect(raw.filter(e => e.tableName === 'wm_users').length).toBe(1);
    });

    it('creates the table once', async () => {
        evaluateModule();
        evaluateModule();

        const p = new MockDatabaseProvider();
        const querySpy = jest.spyOn(p, 'query');

        const db = new DbContext(p);
        await db.connect();
        await db.ensureCreated();

        const created = querySpy.mock.calls
            .map(([sql]) => sql as string)
            .filter(sql => sql.startsWith('CREATE TABLE wm_users '));
        expect(created).toHaveLength(1);
    });

    it('keeps two differently named classes mapped to one table', () => {
        @Entity('wm_shared')
        class WmRead {
            @PrimaryKey()
            id!: number;
        }

        @Entity('wm_shared')
        class WmWrite {
            @PrimaryKey()
            id!: number;
        }

        expect(tablesNamed('wm_shared').map(e => e.target)).toEqual([WmRead, WmWrite]);
    });

    it('keeps a same-named class mapped to a different table', () => {
        function define(table: string) {
            @Entity(table)
            class WmAudit {
                @PrimaryKey()
                id!: number;
            }
            return WmAudit;
        }
        define('wm_audit_a');
        define('wm_audit_b');

        expect(tablesNamed('wm_audit_a')).toHaveLength(1);
        expect(tablesNamed('wm_audit_b')).toHaveLength(1);
    });
});
