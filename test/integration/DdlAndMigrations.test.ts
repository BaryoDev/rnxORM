import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { Migration } from '../../src/migrations/Migration';
import { MigrationBuilder } from '../../src/migrations/MigrationBuilder';
import { Migrator } from '../../src/migrations/Migrator';
import { createTestProvider, getTestProviders } from '../test-config';

const realProviders = getTestProviders().filter((p) => p === 'postgres' || p === 'mariadb' || p === 'mssql');

class CreateProbe extends Migration {
    constructor() {
        super('20260101000001', 'create_probe');
    }
    async up(builder: MigrationBuilder): Promise<void> {
        builder.createTable('mig_probe', [
            { name: 'id', type: 'integer', isPrimaryKey: true },
            { name: 'label', type: 'varchar(50)' },
        ]);
    }
    async down(builder: MigrationBuilder): Promise<void> {
        builder.dropTable('mig_probe');
    }
}

class AddExtra extends Migration {
    constructor() {
        super('20260101000002', 'add_extra');
    }
    async up(builder: MigrationBuilder): Promise<void> {
        builder.addColumn('mig_probe', 'extra', 'integer');
    }
    async down(builder: MigrationBuilder): Promise<void> {
        builder.dropColumn('mig_probe', 'extra');
    }
}

async function cleanMigrationTables(db: DbContext): Promise<void> {
    await db.query('DROP TABLE IF EXISTS mig_probe').catch(() => undefined);
    await db.query('DROP TABLE IF EXISTS __MigrationHistory').catch(() => undefined);
}

describe('migrations on real databases', () => {
    // Without a real database the file would hold no test, which Jest fails.
    if (realProviders.length === 0) it.skip('needs a real database (USE_REAL_DB=true)', () => undefined);

    let logSpy: jest.SpyInstance;
    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });
    afterEach(() => logSpy.mockRestore());

    for (const providerName of realProviders) {
        it(`${providerName} adds a column, then reverts only the newest migration`, async () => {
            const db = new DbContext(createTestProvider(providerName));
            await db.connect();
            try {
                await cleanMigrationTables(db);
                const migrator = new Migrator(db);
                migrator.addMigrations([new CreateProbe(), new AddExtra()]);

                // addColumn must be valid on every dialect. SQL Server rejects ADD COLUMN.
                expect(await migrator.migrate()).toBe(2);
                await db.query('SELECT extra FROM mig_probe');

                // Both ran in one migrate() call, so on MariaDB they can share a second.
                expect(await migrator.revert()).toBe(true);
                await expect(db.query('SELECT extra FROM mig_probe')).rejects.toThrow();
                await db.query('SELECT label FROM mig_probe');

                const history = await db.query('SELECT migration_id FROM __MigrationHistory');
                expect(history.rows.map((r) => r.migration_id)).toEqual(['20260101000001']);
            } finally {
                await cleanMigrationTables(db);
                await db.disconnect();
            }
        }, 60000);
    }
});

@Entity('ea_real')
class EaReal {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

// MariaDB's MODIFY COLUMN and SQL Server's ALTER COLUMN replace the whole
// definition, so a type change used to turn a NOT NULL column nullable.
describe('ensureCreated type changes keep NOT NULL', () => {
    const create: Record<string, string> = {
        mariadb: "CREATE TABLE ea_real (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL DEFAULT 'anon')",
        mssql: 'CREATE TABLE ea_real (id INT IDENTITY(1,1) PRIMARY KEY, name INT NOT NULL)',
    };

    for (const providerName of realProviders.filter((p) => p !== 'postgres')) {
        it(`${providerName} keeps NOT NULL${providerName === 'mariadb' ? ' and the default' : ''} after the type change`, async () => {
            const db = new DbContext(createTestProvider(providerName));
            await db.connect();
            const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
            try {
                await db.query('DROP TABLE IF EXISTS ea_real').catch(() => undefined);
                await db.query(create[providerName]);

                await db.ensureCreated();

                expect(warn).not.toHaveBeenCalled();
                const nullable = await db.query(
                    "SELECT is_nullable AS nullable FROM information_schema.columns WHERE table_name = 'ea_real' AND column_name = 'name'"
                );
                expect(nullable.rows[0].nullable).toBe('NO');

                if (providerName === 'mariadb') {
                    const type = await db.query(
                        "SELECT data_type AS type, column_default AS dflt FROM information_schema.columns WHERE table_name = 'ea_real' AND column_name = 'name'"
                    );
                    expect(String(type.rows[0].type).toLowerCase()).toBe('text');
                    expect(String(type.rows[0].dflt)).toContain('anon');
                }
            } finally {
                warn.mockRestore();
                await db.query('DROP TABLE IF EXISTS ea_real').catch(() => undefined);
                await db.disconnect();
            }
        }, 60000);
    }
});
