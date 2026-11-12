import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

@Entity('ea_users')
class EaUser {
    @PrimaryKey()
    id!: number;

    // Inferred as `text`, while the database column below is a varchar.
    @Column()
    name!: string;
}

/** A provider whose schema reports a varchar column, so ensureCreated asks for a type change. */
class MismatchProvider extends SqlCaptureProvider {
    isTypeMismatch(entityType: string, dbType: string): boolean {
        return entityType === 'text' && dbType === 'varchar';
    }
}

function setup(dialect: CaptureDialect, name: Record<string, unknown>) {
    const provider = new MismatchProvider(dialect);
    provider.defaultResult = {
        rows: [{ column_name: 'id', data_type: 'int', is_nullable: 'NO' }, { column_name: 'name', data_type: 'varchar', ...name }],
        rowCount: 2,
    };
    return { provider, db: new DbContext(provider) };
}

describe('ensureCreated type changes keep what the column already has', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
        warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warn.mockRestore();
    });

    it('mariadb keeps NOT NULL and the default in MODIFY COLUMN', async () => {
        const { provider, db } = setup('mariadb', { is_nullable: 'NO', column_default: "'anon'" });
        await db.connect();
        await db.ensureCreated();

        const modify = provider.calls.map((c) => c.sql).filter((s) => s.includes('MODIFY COLUMN'));
        expect(modify).toEqual(["ALTER TABLE `ea_users` MODIFY COLUMN `name` TEXT NOT NULL DEFAULT 'anon'"]);
        expect(warn).not.toHaveBeenCalled();
    });

    it('mariadb leaves a nullable column without a default as it was', async () => {
        const { provider, db } = setup('mariadb', { is_nullable: 'YES', column_default: null });
        await db.connect();
        await db.ensureCreated();

        const modify = provider.calls.map((c) => c.sql).filter((s) => s.includes('MODIFY COLUMN'));
        expect(modify).toEqual(['ALTER TABLE `ea_users` MODIFY COLUMN `name` TEXT']);
    });

    it('mssql keeps NOT NULL in ALTER COLUMN', async () => {
        const { provider, db } = setup('mssql', { is_nullable: 'NO' });
        await db.connect();
        await db.ensureCreated();

        const alter = provider.calls.map((c) => c.sql).filter((s) => s.includes('ALTER COLUMN'));
        expect(alter).toEqual(['ALTER TABLE [ea_users] ALTER COLUMN [name] NVARCHAR(MAX) NOT NULL']);
    });

    it('reports a failed type change through console.warn instead of swallowing it', async () => {
        const { provider, db } = setup('mariadb', { is_nullable: 'NO', column_default: null });
        provider.failWhen = (sql) => (sql.includes('MODIFY COLUMN') ? new Error('Data truncated') : undefined);
        await db.connect();

        await expect(db.ensureCreated()).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('ea_users.name');
        expect(warn.mock.calls[0][0]).toContain('Data truncated');
    });

    it('reports a default it cannot repeat and does not run the MODIFY', async () => {
        const { provider, db } = setup('mariadb', { is_nullable: 'NO', column_default: 'uuid()' });
        await db.connect();
        await db.ensureCreated();

        expect(provider.calls.some((c) => c.sql.includes('MODIFY COLUMN'))).toBe(false);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toContain('cannot be repeated safely');
    });
});
