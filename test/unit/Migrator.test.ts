import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Migration } from '../../src/migrations/Migration';
import { MigrationBuilder } from '../../src/migrations/MigrationBuilder';
import { Migrator } from '../../src/migrations/Migrator';
import { IDatabaseProvider, ITransaction, QueryResult } from '../../src/providers/IDatabaseProvider';
import { ColumnMetadata, EntityMetadata } from '../../src/core/MetadataStorage';
import { Dialect } from '../../src/core/types';
import { SqlTranslator } from '../../src/providers/translators/SqlTranslator';
import { translatorFor } from '../mocks/translatorFor';

const HISTORY_TABLE = '__MigrationHistory';

/**
 * Fake provider for Migrator tests. Records every query and transaction
 * event in a single ordered `events` list, keeps an in-memory
 * __MigrationHistory table so SELECT/INSERT/DELETE against it behave
 * consistently, and can be told to fail on a specific SQL fragment to
 * exercise rollback paths.
 */
class FakeHistoryProvider implements IDatabaseProvider {
    /** Ordered stream of 'BEGIN' | 'COMMIT' | 'ROLLBACK' | <sql text> */
    public events: string[] = [];
    public queries: Array<{ sql: string; params?: any[] }> = [];
    /**
     * Rows in the fake __MigrationHistory table.
     *
     * `applied_at` is `Date | string` because the drivers disagree: `pg`
     * returns a Date, while MariaDB and SQL Server can return a string
     * depending on driver options.
     */
    public historyRows: Array<{ migration_id: string; migration_name: string; applied_at: Date | string }> = [];
    /** When set, query() throws if the SQL contains this fragment */
    public failOnSqlContaining?: string;
    /** When set, a transaction's commit() throws and applies nothing. */
    public failOnCommit = false;
    /** Which connection ran each query: 'pool' or 'tx1', 'tx2', ... */
    public connections: Array<{ sql: string; connection: string }> = [];
    private transactionCount = 0;

    constructor(private dialect: string = 'postgresql') {}

    getDialect(): Dialect { return this.dialect as Dialect; }
    getTranslator(): SqlTranslator { return translatorFor(this.dialect); }
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}

    async query(text: string, params?: any[]): Promise<QueryResult> {
        return this.execute('pool', text, params, this.historyRows, rows => { this.historyRows = rows; });
    }

    private async execute(
        connection: string,
        text: string,
        params: any[] | undefined,
        history: FakeHistoryProvider['historyRows'],
        setHistory: (rows: FakeHistoryProvider['historyRows']) => void
    ): Promise<QueryResult> {
        const sql = text.trim();
        this.events.push(sql);
        this.queries.push({ sql, params });
        this.connections.push({ sql, connection });

        if (this.failOnSqlContaining && sql.includes(this.failOnSqlContaining)) {
            throw new Error(`Simulated failure on: ${this.failOnSqlContaining}`);
        }

        if (sql.startsWith(`SELECT migration_id, migration_name, applied_at FROM ${HISTORY_TABLE}`)) {
            return { rows: [...history], rowCount: history.length };
        }

        if (sql.startsWith(`INSERT INTO ${HISTORY_TABLE}`) && params) {
            history.push({
                migration_id: params[0],
                migration_name: params[1],
                applied_at: new Date().toISOString()
            });
            return { rows: [], rowCount: 1 };
        }

        if (sql.startsWith(`DELETE FROM ${HISTORY_TABLE}`) && params) {
            setHistory(history.filter(r => r.migration_id !== params[0]));
            return { rows: [], rowCount: 1 };
        }

        return { rows: [], rowCount: 0 };
    }

    /**
     * A handle works on a copy of the history table and publishes it on
     * commit, so a rolled back migration leaves no history row behind.
     */
    async beginTransaction(): Promise<ITransaction> {
        this.events.push('BEGIN');
        const id = `tx${++this.transactionCount}`;
        let rows = [...this.historyRows];
        let open = true;
        return {
            get isOpen() { return open; },
            query: (text: string, params?: any[]) =>
                this.execute(id, text, params, rows, next => { rows = next; }),
            commit: async () => {
                if (!open) return;
                open = false;
                if (this.failOnCommit) throw new Error('Simulated failure on commit');
                this.events.push('COMMIT');
                this.historyRows = rows;
            },
            rollback: async () => {
                if (!open) return;
                open = false;
                this.events.push('ROLLBACK');
            },
        };
    }

    getParameterPlaceholder(index: number): string { return `$${index}`; }

    mapType(tsType: string): string { return tsType; }
    generateCreateTableSql(_entity: EntityMetadata): string { return ''; }
    generateAddColumnSql(_t: string, _c: ColumnMetadata): string { return ''; }
    generateAlterColumnTypeSql(_t: string, _c: ColumnMetadata): string { return ''; }
    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] } {
        return { sql: '', params: [tableName] };
    }
    normalizeType(dbType: string): string { return dbType.toLowerCase(); }
    getAutoIncrementType(): string { return 'INTEGER'; }
    isTypeMismatch(a: string, b: string): boolean { return a !== b; }
    generateAddForeignKeySql(): string { return ''; }
    generateCreateIndexSql(): string { return ''; }
    generateCreateUniqueConstraintSql(): string { return ''; }
    generateCreateJoinTableSql(): string { return ''; }
}

/**
 * Simple test migration whose up/down run distinctive raw SQL so tests
 * can observe exactly which migrations executed and in what order.
 */
class TestMigration extends Migration {
    constructor(id: string, name: string) {
        super(id, name);
    }

    async up(builder: MigrationBuilder): Promise<void> {
        builder.sql(`-- up ${this.id}`);
    }

    async down(builder: MigrationBuilder): Promise<void> {
        builder.sql(`-- down ${this.id}`);
    }
}

function createMigrator(dialect: string = 'postgresql'): { migrator: Migrator; provider: FakeHistoryProvider } {
    const provider = new FakeHistoryProvider(dialect);
    const context = new DbContext(provider);
    const migrator = new Migrator(context);
    return { migrator, provider };
}

describe('Migrator', () => {
    let logSpy: jest.SpyInstance;
    let errorSpy: jest.SpyInstance;

    beforeEach(() => {
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        logSpy.mockRestore();
        errorSpy.mockRestore();
    });

    describe('migration history table creation', () => {
        it('postgresql uses CREATE TABLE IF NOT EXISTS with TIMESTAMP/CURRENT_TIMESTAMP', async () => {
            const { migrator, provider } = createMigrator('postgresql');
            await migrator.getPendingMigrations();

            const createSql = provider.queries[0].sql;
            expect(createSql).toContain(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE}`);
            expect(createSql).toContain('migration_id VARCHAR(255) PRIMARY KEY');
            expect(createSql).toContain('migration_name VARCHAR(255) NOT NULL');
            expect(createSql).toContain('applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
        });

        it('mssql guards with sys.tables check and uses NVARCHAR/DATETIME2/GETDATE()', async () => {
            const { migrator, provider } = createMigrator('mssql');
            await migrator.getPendingMigrations();

            const createSql = provider.queries[0].sql;
            expect(createSql).toContain(
                `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${HISTORY_TABLE}')`
            );
            expect(createSql).toContain(`CREATE TABLE ${HISTORY_TABLE}`);
            expect(createSql).toContain('migration_id NVARCHAR(255) PRIMARY KEY');
            expect(createSql).toContain('migration_name NVARCHAR(255) NOT NULL');
            expect(createSql).toContain('applied_at DATETIME2 NOT NULL DEFAULT GETDATE()');
        });

        it('mariadb uses CREATE TABLE IF NOT EXISTS with TIMESTAMP/CURRENT_TIMESTAMP', async () => {
            const { migrator, provider } = createMigrator('mariadb');
            await migrator.getPendingMigrations();

            const createSql = provider.queries[0].sql;
            expect(createSql).toContain(`CREATE TABLE IF NOT EXISTS ${HISTORY_TABLE}`);
            expect(createSql).toContain('applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP');
        });
    });

    describe('getPendingMigrations', () => {
        it('returns registered migrations sorted by id even when registered out of order', async () => {
            const { migrator } = createMigrator();
            migrator.addMigrations([
                new TestMigration('20240103', 'third'),
                new TestMigration('20240101', 'first'),
                new TestMigration('20240102', 'second')
            ]);

            const pending = await migrator.getPendingMigrations();
            expect(pending.map(m => m.id)).toEqual(['20240101', '20240102', '20240103']);
        });

        it('excludes migrations already recorded in the history table', async () => {
            const { migrator, provider } = createMigrator();
            provider.historyRows.push({
                migration_id: '20240101',
                migration_name: 'first',
                applied_at: new Date().toISOString()
            });

            migrator
                .addMigration(new TestMigration('20240101', 'first'))
                .addMigration(new TestMigration('20240102', 'second'));

            const pending = await migrator.getPendingMigrations();
            expect(pending.map(m => m.id)).toEqual(['20240102']);
        });

        // The three drivers return applied_at as either a Date or a string.
        // Both reach the same Date, so history is read the same way whichever
        // provider is underneath.
        it.each([
            ['a Date, as pg returns it', new Date('2024-01-01T10:00:00.000Z')],
            ['a string, as MariaDB and SQL Server can', '2024-01-01T10:00:00.000Z'],
        ])('reads applied_at when the driver returns %s', async (_label, appliedAt) => {
            const { migrator, provider } = createMigrator();
            provider.historyRows.push({
                migration_id: '20240101',
                migration_name: 'first',
                applied_at: appliedAt
            });

            migrator
                .addMigration(new TestMigration('20240101', 'first'))
                .addMigration(new TestMigration('20240102', 'second'));

            const pending = await migrator.getPendingMigrations();
            expect(pending.map(m => m.id)).toEqual(['20240102']);
        });

        it('rejects an applied_at the driver could not have produced', async () => {
            const { migrator, provider } = createMigrator();
            provider.historyRows.push({
                migration_id: '20240101',
                migration_name: 'first',
                applied_at: null as unknown as string
            });
            migrator.addMigration(new TestMigration('20240101', 'first'));

            await expect(migrator.getPendingMigrations()).rejects.toThrow(
                'cannot read applied_at'
            );
        });
    });

    describe('migrate', () => {
        it('returns 0 and starts no transaction when nothing is pending', async () => {
            const { migrator, provider } = createMigrator();
            const count = await migrator.migrate();

            expect(count).toBe(0);
            expect(provider.events).not.toContain('BEGIN');
        });

        it('applies each pending migration in id order inside its own begin/commit', async () => {
            const { migrator, provider } = createMigrator();
            migrator
                .addMigration(new TestMigration('20240102', 'second'))
                .addMigration(new TestMigration('20240101', 'first'));

            const count = await migrator.migrate();
            expect(count).toBe(2);

            // Ignore the history-table bootstrap and the pending-check SELECT.
            const relevant = provider.events.filter(
                e => e === 'BEGIN' || e === 'COMMIT' || e === 'ROLLBACK' ||
                     e.startsWith('-- up') || e.startsWith(`INSERT INTO ${HISTORY_TABLE}`)
            );

            expect(relevant).toEqual([
                'BEGIN',
                '-- up 20240101',
                `INSERT INTO ${HISTORY_TABLE} (migration_id, migration_name) VALUES ($1, $2)`,
                'COMMIT',
                'BEGIN',
                '-- up 20240102',
                `INSERT INTO ${HISTORY_TABLE} (migration_id, migration_name) VALUES ($1, $2)`,
                'COMMIT'
            ]);
        });

        it('records each migration id and name as insert parameters', async () => {
            const { migrator, provider } = createMigrator();
            migrator.addMigration(new TestMigration('20240101', 'create_users'));

            await migrator.migrate();

            const insert = provider.queries.find(q =>
                q.sql.startsWith(`INSERT INTO ${HISTORY_TABLE}`)
            );
            expect(insert).toBeDefined();
            expect(insert!.params).toEqual(['20240101', 'create_users']);
            expect(provider.historyRows.map(r => r.migration_id)).toEqual(['20240101']);
        });

        it('is idempotent: a second migrate() applies nothing', async () => {
            const { migrator, provider } = createMigrator();
            migrator.addMigration(new TestMigration('20240101', 'first'));

            expect(await migrator.migrate()).toBe(1);
            expect(await migrator.migrate()).toBe(0);
            expect(provider.events.filter(e => e === 'BEGIN')).toHaveLength(1);
        });

        it('rolls back and rethrows when a migration fails, without recording it', async () => {
            const { migrator, provider } = createMigrator();
            provider.failOnSqlContaining = '-- up 20240102';

            migrator
                .addMigration(new TestMigration('20240101', 'first'))
                .addMigration(new TestMigration('20240102', 'second'));

            await expect(migrator.migrate()).rejects.toThrow('Simulated failure');

            // First migration committed, second rolled back.
            const txEvents = provider.events.filter(
                e => e === 'BEGIN' || e === 'COMMIT' || e === 'ROLLBACK'
            );
            expect(txEvents).toEqual(['BEGIN', 'COMMIT', 'BEGIN', 'ROLLBACK']);

            // Failed migration must not be recorded in history.
            expect(provider.historyRows.map(r => r.migration_id)).toEqual(['20240101']);
        });

        it('runs a migration and its history row on its own transaction connection', async () => {
            const { migrator, provider } = createMigrator();
            migrator.addMigration(new TestMigration('20240101', 'first'));

            await migrator.migrate();

            const on = (prefix: string) =>
                provider.connections.find(c => c.sql.startsWith(prefix))!.connection;
            expect(on('-- up 20240101')).toBe('tx1');
            expect(on(`INSERT INTO ${HISTORY_TABLE}`)).toBe('tx1');
            // The history read stays on the pool.
            expect(on(`SELECT migration_id`)).toBe('pool');
        });

        it('leaves no history row when the commit fails after the row was written', async () => {
            const { migrator, provider } = createMigrator();
            provider.failOnCommit = true;
            migrator.addMigration(new TestMigration('20240101', 'first'));

            await expect(migrator.migrate()).rejects.toThrow('Simulated failure on commit');

            expect(provider.queries.some(q => q.sql.startsWith(`INSERT INTO ${HISTORY_TABLE}`))).toBe(true);
            expect(provider.historyRows).toEqual([]);
        });
    });

    describe('revert', () => {
        it('returns false and starts no transaction when nothing is applied', async () => {
            const { migrator, provider } = createMigrator();
            migrator.addMigration(new TestMigration('20240101', 'first'));

            expect(await migrator.revert()).toBe(false);
            expect(provider.events).not.toContain('BEGIN');
        });

        it('runs down() of only the last applied migration inside begin/commit and deletes its record', async () => {
            const { migrator, provider } = createMigrator();
            migrator
                .addMigration(new TestMigration('20240101', 'first'))
                .addMigration(new TestMigration('20240102', 'second'));
            await migrator.migrate();

            const migrateEventCount = provider.events.length;
            expect(await migrator.revert()).toBe(true);

            const revertEvents = provider.events.slice(migrateEventCount).filter(
                e => e === 'BEGIN' || e === 'COMMIT' || e === 'ROLLBACK' ||
                     e.startsWith('-- down') || e.startsWith(`DELETE FROM ${HISTORY_TABLE}`)
            );
            expect(revertEvents).toEqual([
                'BEGIN',
                '-- down 20240102',
                `DELETE FROM ${HISTORY_TABLE} WHERE migration_id = $1`,
                'COMMIT'
            ]);

            const deleteQuery = provider.queries.find(q =>
                q.sql.startsWith(`DELETE FROM ${HISTORY_TABLE}`)
            );
            expect(deleteQuery!.params).toEqual(['20240102']);
            expect(provider.historyRows.map(r => r.migration_id)).toEqual(['20240101']);
        });

        it('rolls back and rethrows when down() fails, keeping the history record', async () => {
            const { migrator, provider } = createMigrator();
            migrator.addMigration(new TestMigration('20240101', 'first'));
            await migrator.migrate();

            provider.failOnSqlContaining = '-- down 20240101';
            await expect(migrator.revert()).rejects.toThrow('Simulated failure');

            expect(provider.events[provider.events.length - 1]).toBe('ROLLBACK');
            expect(provider.historyRows.map(r => r.migration_id)).toEqual(['20240101']);
        });
    });

    describe('revertTo', () => {
        it('reverts from the last applied migration down to the target (inclusive), newest first', async () => {
            const { migrator, provider } = createMigrator();
            migrator.addMigrations([
                new TestMigration('20240101', 'first'),
                new TestMigration('20240102', 'second'),
                new TestMigration('20240103', 'third')
            ]);
            await migrator.migrate();

            const reverted = await migrator.revertTo('20240102');
            expect(reverted).toBe(2);

            const downs = provider.events.filter(e => e.startsWith('-- down'));
            expect(downs).toEqual(['-- down 20240103', '-- down 20240102']);
            expect(provider.historyRows.map(r => r.migration_id)).toEqual(['20240101']);
        });

        it('throws when the target migration is not in the applied list', async () => {
            const { migrator } = createMigrator();
            migrator.addMigration(new TestMigration('20240101', 'first'));

            await expect(migrator.revertTo('20240199')).rejects.toThrow(
                'Migration 20240199 not found in applied migrations.'
            );
        });
    });

    describe('status', () => {
        it('lists applied and pending migrations', async () => {
            const { migrator } = createMigrator();
            migrator
                .addMigration(new TestMigration('20240101', 'first'))
                .addMigration(new TestMigration('20240102', 'second'));
            await migrator.migrate();
            migrator.addMigration(new TestMigration('20240103', 'third'));

            logSpy.mockClear();
            await migrator.status();

            const output = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
            expect(output).toContain('Applied Migrations:');
            expect(output).toContain('20240101_first');
            expect(output).toContain('20240102_second');
            expect(output).toContain('Pending Migrations:');
            expect(output).toContain('20240103_third');
        });

        it('reports when no migrations are registered', async () => {
            const { migrator } = createMigrator();
            logSpy.mockClear();

            await migrator.status();

            const output = logSpy.mock.calls.map(args => args.join(' ')).join('\n');
            expect(output).toContain('No migrations registered.');
        });
    });
});
