import "reflect-metadata";
import { MigrationBuilder } from '../../src/migrations/MigrationBuilder';
import { IDatabaseProvider, QueryResult } from '../../src/providers/IDatabaseProvider';
import { ColumnMetadata, EntityMetadata } from '../../src/core/MetadataStorage';

/**
 * Minimal fake provider that records every query() call so tests can
 * assert on the exact SQL/DDL strings the MigrationBuilder produces.
 * (MockDatabaseProvider is not used because it reports dialect 'mock'
 * and the builder branches on 'postgresql' | 'mssql' | 'mariadb'.)
 */
class RecordingProvider implements IDatabaseProvider {
    public queries: Array<{ sql: string; params?: any[] }> = [];

    constructor(private dialect: string) {}

    getDialect(): string { return this.dialect; }
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}

    async query(text: string, params?: any[]): Promise<QueryResult> {
        this.queries.push({ sql: text, params });
        return { rows: [], rowCount: 0 };
    }

    async beginTransaction(): Promise<void> {}
    async commitTransaction(): Promise<void> {}
    async rollbackTransaction(): Promise<void> {}

    mapType(tsType: string): string { return tsType; }
    generateCreateTableSql(_entity: EntityMetadata): string { return ''; }
    generateAddColumnSql(_t: string, _c: ColumnMetadata): string { return ''; }
    generateAlterColumnTypeSql(_t: string, _c: ColumnMetadata): string { return ''; }
    generateInsertSql(_t: string, _c: ColumnMetadata[]): string { return ''; }
    generateUpdateSql(_t: string, _c: ColumnMetadata[], _pk: ColumnMetadata): string { return ''; }
    generateDeleteSql(_t: string, _pk: ColumnMetadata): string { return ''; }
    generateSelectSql(tableName: string, whereClause?: string): string {
        return whereClause ? `SELECT * FROM ${tableName} WHERE ${whereClause}` : `SELECT * FROM ${tableName}`;
    }
    getParameterPlaceholder(index: number): string { return `$${index}`; }
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
 * Helper: build operations against a fresh provider for the given dialect,
 * execute them, and return the recorded SQL strings.
 */
async function runBuilder(
    dialect: string,
    define: (builder: MigrationBuilder) => void
): Promise<Array<{ sql: string; params?: any[] }>> {
    const provider = new RecordingProvider(dialect);
    const builder = new MigrationBuilder(provider);
    define(builder);
    await builder.execute();
    return provider.queries;
}

describe('MigrationBuilder', () => {
    describe('operation accumulation and execute()', () => {
        it('does not execute any SQL until execute() is called', () => {
            const provider = new RecordingProvider('postgresql');
            const builder = new MigrationBuilder(provider);

            builder.dropTable('mig_lazy').createIndex('mig_lazy', 'ix_mig_lazy', ['a']);

            expect(provider.queries).toHaveLength(0);
        });

        it('executes accumulated operations in order and clears the queue', async () => {
            const provider = new RecordingProvider('postgresql');
            const builder = new MigrationBuilder(provider);

            builder
                .dropTable('mig_first')
                .dropTable('mig_second')
                .sql('SELECT 1');

            await builder.execute();

            expect(provider.queries.map(q => q.sql)).toEqual([
                'DROP TABLE IF EXISTS mig_first',
                'DROP TABLE IF EXISTS mig_second',
                'SELECT 1'
            ]);

            // Queue must be cleared: a second execute() runs nothing.
            await builder.execute();
            expect(provider.queries).toHaveLength(3);
        });

        it('supports fluent chaining (each method returns the builder)', () => {
            const provider = new RecordingProvider('mariadb');
            const builder = new MigrationBuilder(provider);

            const result = builder
                .createTable('mig_chain', [{ name: 'id', type: 'INT' }])
                .addColumn('mig_chain', 'x', 'INT')
                .dropColumn('mig_chain', 'x')
                .renameTable('mig_chain', 'mig_chain2')
                .dropTable('mig_chain2');

            expect(result).toBe(builder);
        });
    });

    describe('createTable', () => {
        it('emits column name and type, comma-separated', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.createTable('mig_users', [
                    { name: 'id', type: 'INTEGER' },
                    { name: 'name', type: 'VARCHAR(100)' }
                ])
            );

            expect(queries).toHaveLength(1);
            expect(queries[0].sql).toBe('CREATE TABLE mig_users (id INTEGER, name VARCHAR(100))');
        });

        it('adds NOT NULL for nullable: false and omits it for nullable columns', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.createTable('mig_users', [
                    { name: 'email', type: 'VARCHAR(255)', nullable: false },
                    { name: 'nickname', type: 'VARCHAR(50)', nullable: true },
                    { name: 'bio', type: 'TEXT' }
                ])
            );

            expect(queries[0].sql).toContain('email VARCHAR(255) NOT NULL');
            expect(queries[0].sql).toContain('nickname VARCHAR(50)');
            expect(queries[0].sql).not.toContain('nickname VARCHAR(50) NOT NULL');
            expect(queries[0].sql).not.toContain('bio TEXT NOT NULL');
        });

        it('emits PRIMARY KEY for non-auto-increment primary keys without NOT NULL', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.createTable('mig_codes', [
                    { name: 'code', type: 'VARCHAR(10)', isPrimaryKey: true, nullable: false }
                ])
            );

            expect(queries[0].sql).toBe('CREATE TABLE mig_codes (code VARCHAR(10) PRIMARY KEY)');
        });

        it('quotes string default values and leaves numeric/boolean defaults unquoted', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.createTable('mig_settings', [
                    { name: 'status', type: 'VARCHAR(20)', defaultValue: 'active' },
                    { name: 'retries', type: 'INTEGER', defaultValue: 3 },
                    { name: 'enabled', type: 'BOOLEAN', defaultValue: true }
                ])
            );

            expect(queries[0].sql).toContain("status VARCHAR(20) DEFAULT 'active'");
            expect(queries[0].sql).toContain('retries INTEGER DEFAULT 3');
            expect(queries[0].sql).toContain('enabled BOOLEAN DEFAULT true');
        });

        it('combines NOT NULL and DEFAULT on the same column', async () => {
            const queries = await runBuilder('mariadb', b =>
                b.createTable('mig_settings', [
                    { name: 'level', type: 'INT', nullable: false, defaultValue: 0 }
                ])
            );

            expect(queries[0].sql).toBe('CREATE TABLE mig_settings (level INT NOT NULL DEFAULT 0)');
        });

        describe('auto-increment primary key syntax per dialect', () => {
            const autoIdColumns = [
                { name: 'id', type: 'integer', isPrimaryKey: true, isAutoIncrement: true },
                { name: 'name', type: 'VARCHAR(100)', nullable: false }
            ];

            it('postgresql uses SERIAL PRIMARY KEY', async () => {
                const queries = await runBuilder('postgresql', b =>
                    b.createTable('mig_pg', autoIdColumns)
                );
                expect(queries[0].sql).toBe(
                    'CREATE TABLE mig_pg (id SERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL)'
                );
            });

            it('mssql uses INT IDENTITY(1,1) PRIMARY KEY', async () => {
                const queries = await runBuilder('mssql', b =>
                    b.createTable('mig_ms', autoIdColumns)
                );
                expect(queries[0].sql).toBe(
                    'CREATE TABLE mig_ms (id INT IDENTITY(1,1) PRIMARY KEY, name VARCHAR(100) NOT NULL)'
                );
            });

            it('mariadb uses INT AUTO_INCREMENT PRIMARY KEY', async () => {
                const queries = await runBuilder('mariadb', b =>
                    b.createTable('mig_mdb', autoIdColumns)
                );
                expect(queries[0].sql).toBe(
                    'CREATE TABLE mig_mdb (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL)'
                );
            });
        });
    });

    describe('dropTable', () => {
        it.each(['postgresql', 'mssql', 'mariadb'])(
            'emits DROP TABLE IF EXISTS for %s',
            async dialect => {
                const queries = await runBuilder(dialect, b => b.dropTable('mig_old'));
                expect(queries.map(q => q.sql)).toEqual(['DROP TABLE IF EXISTS mig_old']);
            }
        );
    });

    describe('renameTable', () => {
        it('postgresql uses ALTER TABLE ... RENAME TO', async () => {
            const queries = await runBuilder('postgresql', b => b.renameTable('mig_a', 'mig_b'));
            expect(queries.map(q => q.sql)).toEqual(['ALTER TABLE mig_a RENAME TO mig_b']);
        });

        it('mssql uses EXEC sp_rename', async () => {
            const queries = await runBuilder('mssql', b => b.renameTable('mig_a', 'mig_b'));
            expect(queries.map(q => q.sql)).toEqual([`EXEC sp_rename 'mig_a', 'mig_b'`]);
        });

        it('mariadb uses RENAME TABLE ... TO', async () => {
            const queries = await runBuilder('mariadb', b => b.renameTable('mig_a', 'mig_b'));
            expect(queries.map(q => q.sql)).toEqual(['RENAME TABLE mig_a TO mig_b']);
        });
    });

    describe('addColumn', () => {
        it.each(['postgresql', 'mssql', 'mariadb'])(
            'emits ALTER TABLE ... ADD COLUMN for %s',
            async dialect => {
                const queries = await runBuilder(dialect, b =>
                    b.addColumn('mig_users', 'age', 'INTEGER')
                );
                expect(queries.map(q => q.sql)).toEqual([
                    'ALTER TABLE mig_users ADD COLUMN age INTEGER'
                ]);
            }
        );

        it('appends NOT NULL when nullable: false', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.addColumn('mig_users', 'age', 'INTEGER', { nullable: false })
            );
            expect(queries[0].sql).toBe('ALTER TABLE mig_users ADD COLUMN age INTEGER NOT NULL');
        });

        it('appends quoted DEFAULT for string values', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.addColumn('mig_users', 'role', 'VARCHAR(20)', { defaultValue: 'user' })
            );
            expect(queries[0].sql).toBe(
                "ALTER TABLE mig_users ADD COLUMN role VARCHAR(20) DEFAULT 'user'"
            );
        });

        it('appends unquoted DEFAULT for numeric values, combined with NOT NULL', async () => {
            const queries = await runBuilder('mariadb', b =>
                b.addColumn('mig_users', 'score', 'INT', { nullable: false, defaultValue: 0 })
            );
            expect(queries[0].sql).toBe(
                'ALTER TABLE mig_users ADD COLUMN score INT NOT NULL DEFAULT 0'
            );
        });
    });

    describe('dropColumn', () => {
        it.each(['postgresql', 'mssql', 'mariadb'])(
            'emits ALTER TABLE ... DROP COLUMN for %s',
            async dialect => {
                const queries = await runBuilder(dialect, b =>
                    b.dropColumn('mig_users', 'age')
                );
                expect(queries.map(q => q.sql)).toEqual([
                    'ALTER TABLE mig_users DROP COLUMN age'
                ]);
            }
        );
    });

    describe('alterColumn', () => {
        it('postgresql emits ALTER COLUMN ... TYPE as a single statement when no options given', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.alterColumn('mig_users', 'name', 'VARCHAR(200)')
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users ALTER COLUMN name TYPE VARCHAR(200)'
            ]);
        });

        it('postgresql emits SET NOT NULL as a separate statement for nullable: false', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.alterColumn('mig_users', 'name', 'VARCHAR(200)', { nullable: false })
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users ALTER COLUMN name TYPE VARCHAR(200)',
                'ALTER TABLE mig_users ALTER COLUMN name SET NOT NULL'
            ]);
        });

        it('postgresql emits DROP NOT NULL for nullable: true', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.alterColumn('mig_users', 'name', 'VARCHAR(200)', { nullable: true })
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users ALTER COLUMN name TYPE VARCHAR(200)',
                'ALTER TABLE mig_users ALTER COLUMN name DROP NOT NULL'
            ]);
        });

        it('postgresql emits SET DEFAULT (quoted for strings) as a separate statement', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.alterColumn('mig_users', 'status', 'VARCHAR(20)', {
                    nullable: false,
                    defaultValue: 'active'
                })
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users ALTER COLUMN status TYPE VARCHAR(20)',
                'ALTER TABLE mig_users ALTER COLUMN status SET NOT NULL',
                "ALTER TABLE mig_users ALTER COLUMN status SET DEFAULT 'active'"
            ]);
        });

        it('postgresql emits unquoted SET DEFAULT for numeric values', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.alterColumn('mig_users', 'retries', 'INTEGER', { defaultValue: 5 })
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users ALTER COLUMN retries TYPE INTEGER',
                'ALTER TABLE mig_users ALTER COLUMN retries SET DEFAULT 5'
            ]);
        });

        it('mssql emits a single ALTER COLUMN statement', async () => {
            const queries = await runBuilder('mssql', b =>
                b.alterColumn('mig_users', 'name', 'NVARCHAR(200)')
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users ALTER COLUMN name NVARCHAR(200)'
            ]);
        });

        it('mssql appends NOT NULL inline for nullable: false', async () => {
            const queries = await runBuilder('mssql', b =>
                b.alterColumn('mig_users', 'name', 'NVARCHAR(200)', { nullable: false })
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users ALTER COLUMN name NVARCHAR(200) NOT NULL'
            ]);
        });

        it('mariadb uses MODIFY COLUMN', async () => {
            const queries = await runBuilder('mariadb', b =>
                b.alterColumn('mig_users', 'name', 'VARCHAR(200)')
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users MODIFY COLUMN name VARCHAR(200)'
            ]);
        });

        it('mariadb appends NOT NULL inline for nullable: false', async () => {
            const queries = await runBuilder('mariadb', b =>
                b.alterColumn('mig_users', 'name', 'VARCHAR(200)', { nullable: false })
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users MODIFY COLUMN name VARCHAR(200) NOT NULL'
            ]);
        });
    });

    describe('renameColumn', () => {
        it('postgresql uses ALTER TABLE ... RENAME COLUMN', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.renameColumn('mig_users', 'name', 'full_name')
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users RENAME COLUMN name TO full_name'
            ]);
        });

        it('mssql uses EXEC sp_rename with COLUMN object type', async () => {
            const queries = await runBuilder('mssql', b =>
                b.renameColumn('mig_users', 'name', 'full_name')
            );
            expect(queries.map(q => q.sql)).toEqual([
                `EXEC sp_rename 'mig_users.name', 'full_name', 'COLUMN'`
            ]);
        });

        it('mariadb uses ALTER TABLE ... RENAME COLUMN', async () => {
            const queries = await runBuilder('mariadb', b =>
                b.renameColumn('mig_users', 'name', 'full_name')
            );
            expect(queries.map(q => q.sql)).toEqual([
                'ALTER TABLE mig_users RENAME COLUMN name TO full_name'
            ]);
        });
    });

    describe('createIndex', () => {
        it.each(['postgresql', 'mssql', 'mariadb'])(
            'emits CREATE INDEX (non-unique, default) for %s',
            async dialect => {
                const queries = await runBuilder(dialect, b =>
                    b.createIndex('mig_users', 'ix_mig_users_email', ['email'])
                );
                expect(queries.map(q => q.sql)).toEqual([
                    'CREATE INDEX ix_mig_users_email ON mig_users (email)'
                ]);
            }
        );

        it('emits CREATE UNIQUE INDEX when unique is true', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.createIndex('mig_users', 'ux_mig_users_email', ['email'], true)
            );
            expect(queries[0].sql).toBe(
                'CREATE UNIQUE INDEX ux_mig_users_email ON mig_users (email)'
            );
        });

        it('joins multiple columns with a comma', async () => {
            const queries = await runBuilder('mariadb', b =>
                b.createIndex('mig_users', 'ix_mig_users_name_dob', ['last_name', 'dob'])
            );
            expect(queries[0].sql).toBe(
                'CREATE INDEX ix_mig_users_name_dob ON mig_users (last_name, dob)'
            );
        });
    });

    describe('dropIndex', () => {
        it('postgresql uses DROP INDEX IF EXISTS without the table name', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.dropIndex('mig_users', 'ix_mig_users_email')
            );
            expect(queries.map(q => q.sql)).toEqual(['DROP INDEX IF EXISTS ix_mig_users_email']);
        });

        it('mssql uses DROP INDEX ... ON table', async () => {
            const queries = await runBuilder('mssql', b =>
                b.dropIndex('mig_users', 'ix_mig_users_email')
            );
            expect(queries.map(q => q.sql)).toEqual([
                'DROP INDEX ix_mig_users_email ON mig_users'
            ]);
        });

        it('mariadb uses DROP INDEX ... ON table', async () => {
            const queries = await runBuilder('mariadb', b =>
                b.dropIndex('mig_users', 'ix_mig_users_email')
            );
            expect(queries.map(q => q.sql)).toEqual([
                'DROP INDEX ix_mig_users_email ON mig_users'
            ]);
        });
    });

    describe('addForeignKey', () => {
        it.each(['postgresql', 'mssql', 'mariadb'])(
            'emits ADD CONSTRAINT ... FOREIGN KEY with default ON DELETE NO ACTION for %s',
            async dialect => {
                const queries = await runBuilder(dialect, b =>
                    b.addForeignKey('mig_orders', 'fk_mig_orders_user', 'user_id', 'mig_users', 'id')
                );
                expect(queries.map(q => q.sql)).toEqual([
                    'ALTER TABLE mig_orders ADD CONSTRAINT fk_mig_orders_user ' +
                    'FOREIGN KEY (user_id) REFERENCES mig_users(id) ' +
                    'ON DELETE NO ACTION'
                ]);
            }
        );

        it('emits the requested ON DELETE action (CASCADE)', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.addForeignKey(
                    'mig_orders', 'fk_mig_orders_user', 'user_id', 'mig_users', 'id', 'CASCADE'
                )
            );
            expect(queries[0].sql).toContain('ON DELETE CASCADE');
        });

        it('emits the requested ON DELETE action (SET NULL)', async () => {
            const queries = await runBuilder('mariadb', b =>
                b.addForeignKey(
                    'mig_orders', 'fk_mig_orders_user', 'user_id', 'mig_users', 'id', 'SET NULL'
                )
            );
            expect(queries[0].sql).toContain('ON DELETE SET NULL');
        });
    });

    describe('dropForeignKey', () => {
        it.each(['postgresql', 'mssql', 'mariadb'])(
            'emits ALTER TABLE ... DROP CONSTRAINT for %s',
            async dialect => {
                const queries = await runBuilder(dialect, b =>
                    b.dropForeignKey('mig_orders', 'fk_mig_orders_user')
                );
                expect(queries.map(q => q.sql)).toEqual([
                    'ALTER TABLE mig_orders DROP CONSTRAINT fk_mig_orders_user'
                ]);
            }
        );
    });

    describe('sql (raw passthrough)', () => {
        it('passes the SQL text through unchanged with no params', async () => {
            const queries = await runBuilder('postgresql', b =>
                b.sql('UPDATE mig_users SET migrated = 1')
            );
            expect(queries).toEqual([
                { sql: 'UPDATE mig_users SET migrated = 1', params: undefined }
            ]);
        });

        it('passes params through to the provider', async () => {
            const queries = await runBuilder('mssql', b =>
                b.sql('UPDATE mig_users SET role = @p1 WHERE id = @p2', ['admin', 42])
            );
            expect(queries).toEqual([
                { sql: 'UPDATE mig_users SET role = @p1 WHERE id = @p2', params: ['admin', 42] }
            ]);
        });
    });
});
