import { DdlOperation } from '../../../src/core/query/model/DdlOperation';
import { SqlTranslator } from '../../../src/providers/translators/SqlTranslator';
import { PostgresTranslator } from '../../../src/providers/translators/PostgresTranslator';
import { MsSqlTranslator } from '../../../src/providers/translators/MsSqlTranslator';
import { MariaDbTranslator } from '../../../src/providers/translators/MariaDbTranslator';

type Dialect = 'postgresql' | 'mssql' | 'mariadb';

const translators: Record<Dialect, SqlTranslator> = {
    postgresql: new PostgresTranslator(),
    mssql: new MsSqlTranslator(),
    mariadb: new MariaDbTranslator(),
};
const dialects = Object.keys(translators) as Dialect[];

const texts = (t: SqlTranslator, op: DdlOperation): string[] => t.translateDdl(op).map((s) => s.text);

/** Expected text per dialect, with the same names quoted the way each dialect quotes them. */
function expectPerDialect(op: DdlOperation, expected: Record<Dialect, string[]>): void {
    for (const dialect of dialects) {
        expect(texts(translators[dialect], op)).toEqual(expected[dialect]);
    }
}

describe('DDL translation', () => {
    describe('createTable', () => {
        it('renders columns, primary key, not null and defaults', () => {
            expectPerDialect(
                {
                    op: 'createTable',
                    table: 'users',
                    columns: [
                        { name: 'id', type: 'integer', isPrimaryKey: true },
                        { name: 'name', type: 'varchar(100)', nullable: false, defaultValue: "O'Neil" },
                        { name: 'active', type: 'boolean', defaultValue: true },
                    ],
                },
                {
                    postgresql: [
                        "CREATE TABLE users (id integer PRIMARY KEY, name varchar(100) NOT NULL DEFAULT 'O''Neil', active boolean DEFAULT TRUE)",
                    ],
                    mssql: [
                        "CREATE TABLE [users] ([id] integer PRIMARY KEY, [name] varchar(100) NOT NULL DEFAULT 'O''Neil', [active] boolean DEFAULT 1)",
                    ],
                    mariadb: [
                        "CREATE TABLE `users` (`id` integer PRIMARY KEY, `name` varchar(100) NOT NULL DEFAULT 'O''Neil', `active` boolean DEFAULT TRUE)",
                    ],
                }
            );
        });

        it('uses each dialect auto-increment syntax', () => {
            expectPerDialect(
                {
                    op: 'createTable',
                    table: 'users',
                    columns: [{ name: 'id', type: 'integer', isPrimaryKey: true, isAutoIncrement: true }],
                },
                {
                    postgresql: ['CREATE TABLE users (id SERIAL PRIMARY KEY)'],
                    mssql: ['CREATE TABLE [users] ([id] INT IDENTITY(1,1) PRIMARY KEY)'],
                    mariadb: ['CREATE TABLE `users` (`id` INT AUTO_INCREMENT PRIMARY KEY)'],
                }
            );
        });
    });

    describe('dropTable', () => {
        it('renders DROP TABLE IF EXISTS', () => {
            expectPerDialect(
                { op: 'dropTable', table: 'users' },
                {
                    postgresql: ['DROP TABLE IF EXISTS users'],
                    mssql: ['DROP TABLE IF EXISTS [users]'],
                    mariadb: ['DROP TABLE IF EXISTS `users`'],
                }
            );
        });
    });

    describe('addColumn', () => {
        it('renders type, not null and default', () => {
            expectPerDialect(
                { op: 'addColumn', table: 'users', column: 'age', type: 'integer', nullable: false, defaultValue: 0 },
                {
                    postgresql: ['ALTER TABLE users ADD COLUMN age integer NOT NULL DEFAULT 0'],
                    mssql: ['ALTER TABLE [users] ADD COLUMN [age] integer NOT NULL DEFAULT 0'],
                    mariadb: ['ALTER TABLE `users` ADD COLUMN `age` integer NOT NULL DEFAULT 0'],
                }
            );
        });

        it('renders a boolean default as 1/0 on MSSQL and TRUE/FALSE elsewhere', () => {
            const on = { op: 'addColumn', table: 't', column: 'c', type: 'bit', defaultValue: true } as const;
            const off = { ...on, defaultValue: false };
            expect(texts(translators.mssql, on)).toEqual(['ALTER TABLE [t] ADD COLUMN [c] bit DEFAULT 1']);
            expect(texts(translators.mssql, off)).toEqual(['ALTER TABLE [t] ADD COLUMN [c] bit DEFAULT 0']);
            expect(texts(translators.postgresql, on)).toEqual(['ALTER TABLE t ADD COLUMN c bit DEFAULT TRUE']);
            expect(texts(translators.mariadb, off)).toEqual(['ALTER TABLE `t` ADD COLUMN `c` bit DEFAULT FALSE']);
        });

        it('doubles quotes in a string default so it cannot close the literal', () => {
            const op: DdlOperation = {
                op: 'addColumn',
                table: 't',
                column: 'c',
                type: 'text',
                defaultValue: "x'; DROP TABLE users; --",
            };
            for (const dialect of dialects) {
                expect(texts(translators[dialect], op)[0]).toContain("DEFAULT 'x''; DROP TABLE users; --'");
            }
        });
    });

    describe('dropColumn', () => {
        it('renders DROP COLUMN', () => {
            expectPerDialect(
                { op: 'dropColumn', table: 'users', column: 'age' },
                {
                    postgresql: ['ALTER TABLE users DROP COLUMN age'],
                    mssql: ['ALTER TABLE [users] DROP COLUMN [age]'],
                    mariadb: ['ALTER TABLE `users` DROP COLUMN `age`'],
                }
            );
        });
    });

    describe('alterColumn', () => {
        it('splits into several statements on PostgreSQL', () => {
            const op: DdlOperation = {
                op: 'alterColumn',
                table: 'users',
                column: 'name',
                type: 'varchar(200)',
                nullable: false,
                defaultValue: 'x',
            };
            expect(texts(translators.postgresql, op)).toEqual([
                'ALTER TABLE users ALTER COLUMN name TYPE varchar(200)',
                'ALTER TABLE users ALTER COLUMN name SET NOT NULL',
                "ALTER TABLE users ALTER COLUMN name SET DEFAULT 'x'",
            ]);
        });

        it('drops not null on PostgreSQL when nullable is true', () => {
            expect(
                texts(translators.postgresql, { op: 'alterColumn', table: 'users', column: 'name', type: 'text', nullable: true })
            ).toEqual([
                'ALTER TABLE users ALTER COLUMN name TYPE text',
                'ALTER TABLE users ALTER COLUMN name DROP NOT NULL',
            ]);
        });

        it('renders one statement on MSSQL and MariaDB and ignores the default', () => {
            const op: DdlOperation = {
                op: 'alterColumn',
                table: 'users',
                column: 'name',
                type: 'varchar(200)',
                nullable: false,
                defaultValue: 'x',
            };
            expect(texts(translators.mssql, op)).toEqual([
                'ALTER TABLE [users] ALTER COLUMN [name] varchar(200) NOT NULL',
            ]);
            expect(texts(translators.mariadb, op)).toEqual([
                'ALTER TABLE `users` MODIFY COLUMN `name` varchar(200) NOT NULL',
            ]);
        });
    });

    describe('renameColumn', () => {
        it('renders per dialect', () => {
            expectPerDialect(
                { op: 'renameColumn', table: 'users', from: 'a', to: 'b' },
                {
                    postgresql: ['ALTER TABLE users RENAME COLUMN a TO b'],
                    mssql: ["EXEC sp_rename 'users.a', 'b', 'COLUMN'"],
                    mariadb: ['ALTER TABLE `users` RENAME COLUMN `a` TO `b`'],
                }
            );
        });

        it('keeps a schema qualifier in the MSSQL sp_rename source', () => {
            expect(texts(translators.mssql, { op: 'renameColumn', table: 'dbo.users', from: 'a', to: 'b' })).toEqual([
                "EXEC sp_rename 'dbo.users.a', 'b', 'COLUMN'",
            ]);
        });

        it.each([
            ["b'; DROP TABLE users; --"],
            ['b c'],
            ['dbo.b'],
            [''],
        ])('rejects the new name %p on MSSQL', (to) => {
            expect(() => translators.mssql.translateDdl({ op: 'renameColumn', table: 'users', from: 'a', to })).toThrow(
                /renameColumn\(\)/
            );
        });

        it('rejects a payload in the old name or the table on MSSQL', () => {
            expect(() =>
                translators.mssql.translateDdl({ op: 'renameColumn', table: 'users', from: "a', 'x'; --", to: 'b' })
            ).toThrow(/not a valid SQL identifier/);
            expect(() =>
                translators.mssql.translateDdl({ op: 'renameColumn', table: "users'; --", from: 'a', to: 'b' })
            ).toThrow(/not a valid SQL identifier/);
            expect(() =>
                translators.mssql.translateDdl({ op: 'renameColumn', table: 'a.b.c', from: 'a', to: 'b' })
            ).toThrow(/too many qualifiers/);
        });
    });

    describe('renameTable', () => {
        it('renders per dialect', () => {
            expectPerDialect(
                { op: 'renameTable', from: 'old_t', to: 'new_t' },
                {
                    postgresql: ['ALTER TABLE old_t RENAME TO new_t'],
                    mssql: ["EXEC sp_rename 'old_t', 'new_t'"],
                    mariadb: ['RENAME TABLE `old_t` TO `new_t`'],
                }
            );
        });

        it('rejects payloads in the MSSQL sp_rename names', () => {
            expect(() => translators.mssql.translateDdl({ op: 'renameTable', from: 'a', to: "b'; DROP TABLE x; --" })).toThrow(
                /renameTable\(\)/
            );
            expect(() => translators.mssql.translateDdl({ op: 'renameTable', from: "a'; --", to: 'b' })).toThrow(
                /not a valid SQL identifier/
            );
        });
    });

    describe('createIndex', () => {
        it('renders plain and unique indexes', () => {
            expectPerDialect(
                { op: 'createIndex', table: 'users', index: 'ix_users_email', columns: ['email', 'name'], unique: true },
                {
                    postgresql: ['CREATE UNIQUE INDEX ix_users_email ON users (email, name)'],
                    mssql: ['CREATE UNIQUE INDEX [ix_users_email] ON [users] ([email], [name])'],
                    mariadb: ['CREATE UNIQUE INDEX `ix_users_email` ON `users` (`email`, `name`)'],
                }
            );
            expect(
                texts(translators.postgresql, { op: 'createIndex', table: 'users', index: 'ix', columns: ['a'], unique: false })
            ).toEqual(['CREATE INDEX ix ON users (a)']);
        });
    });

    describe('dropIndex', () => {
        it('uses DROP INDEX ... ON on MSSQL and MariaDB, IF EXISTS on PostgreSQL', () => {
            expectPerDialect(
                { op: 'dropIndex', table: 'users', index: 'ix_users_email' },
                {
                    postgresql: ['DROP INDEX IF EXISTS ix_users_email'],
                    mssql: ['DROP INDEX [ix_users_email] ON [users]'],
                    mariadb: ['DROP INDEX `ix_users_email` ON `users`'],
                }
            );
        });
    });

    describe('foreign keys', () => {
        it('renders addForeignKey', () => {
            expectPerDialect(
                {
                    op: 'addForeignKey',
                    table: 'posts',
                    constraint: 'fk_posts_user',
                    column: 'user_id',
                    referencedTable: 'users',
                    referencedColumn: 'id',
                    onDelete: 'CASCADE',
                },
                {
                    postgresql: [
                        'ALTER TABLE posts ADD CONSTRAINT fk_posts_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE',
                    ],
                    mssql: [
                        'ALTER TABLE [posts] ADD CONSTRAINT [fk_posts_user] FOREIGN KEY ([user_id]) REFERENCES [users]([id]) ON DELETE CASCADE',
                    ],
                    mariadb: [
                        'ALTER TABLE `posts` ADD CONSTRAINT `fk_posts_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE',
                    ],
                }
            );
        });

        it('rejects an ON DELETE action outside the four SQL actions', () => {
            expect(() =>
                translators.postgresql.translateDdl({
                    op: 'addForeignKey',
                    table: 'a',
                    constraint: 'c',
                    column: 'x',
                    referencedTable: 'b',
                    referencedColumn: 'y',
                    onDelete: 'CASCADE; DROP TABLE a' as any,
                })
            ).toThrow(/ON DELETE action/);
        });

        it('renders dropForeignKey', () => {
            expectPerDialect(
                { op: 'dropForeignKey', table: 'posts', constraint: 'fk_posts_user' },
                {
                    postgresql: ['ALTER TABLE posts DROP CONSTRAINT fk_posts_user'],
                    mssql: ['ALTER TABLE [posts] DROP CONSTRAINT [fk_posts_user]'],
                    mariadb: ['ALTER TABLE `posts` DROP CONSTRAINT `fk_posts_user`'],
                }
            );
        });
    });

    describe('migration history', () => {
        const op: DdlOperation = { op: 'createMigrationHistory', table: '__MigrationHistory' };

        it('creates the table if missing', () => {
            expectPerDialect(op, {
                postgresql: [
                    'CREATE TABLE IF NOT EXISTS __MigrationHistory (migration_id VARCHAR(255) PRIMARY KEY, migration_name VARCHAR(255) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)',
                ],
                mssql: [
                    "IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '__MigrationHistory')\nCREATE TABLE __MigrationHistory (migration_id NVARCHAR(255) PRIMARY KEY, migration_name NVARCHAR(255) NOT NULL, applied_at DATETIME2 NOT NULL DEFAULT GETDATE())",
                ],
                mariadb: [
                    'CREATE TABLE IF NOT EXISTS __MigrationHistory (migration_id VARCHAR(255) PRIMARY KEY, migration_name VARCHAR(255) NOT NULL, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)',
                ],
            });
        });
    });

    describe('PostgreSQL quoting', () => {
        const t = translators.postgresql;

        it('leaves lower-case names bare', () => {
            expect(texts(t, { op: 'dropTable', table: 'user_accounts' })).toEqual(['DROP TABLE IF EXISTS user_accounts']);
        });

        it('quotes reserved words and mixed-case names', () => {
            expect(texts(t, { op: 'dropTable', table: 'order' })).toEqual(['DROP TABLE IF EXISTS "order"']);
            expect(texts(t, { op: 'dropTable', table: 'Users' })).toEqual(['DROP TABLE IF EXISTS "Users"']);
        });

        it('quotes each part of a schema-qualified name', () => {
            expect(texts(t, { op: 'dropTable', table: 'app.order' })).toEqual(['DROP TABLE IF EXISTS app."order"']);
        });
    });

    describe('validation', () => {
        it.each(dialects)('rejects bad identifiers, types and literals on %s', (dialect) => {
            const t = translators[dialect];
            expect(() => t.translateDdl({ op: 'dropTable', table: 'users; DROP TABLE x' })).toThrow(
                /dropTable\(\): .* is not a valid SQL identifier/
            );
            expect(() => t.translateDdl({ op: 'dropTable', table: 'a.b.c' })).toThrow(/too many qualifiers/);
            expect(() => t.translateDdl({ op: 'dropTable', table: '' })).toThrow(/identifier is required/);
            expect(() =>
                t.translateDdl({ op: 'addColumn', table: 't', column: 'c', type: 'int); DROP TABLE t; --' })
            ).toThrow(/not a valid column type/);
            expect(() =>
                t.translateDdl({ op: 'addColumn', table: 't', column: 'c', type: 'int', defaultValue: { a: 1 } })
            ).toThrow(/addColumn\(\)/);
        });
    });

    describe('totality', () => {
        const ops: DdlOperation[] = [
            { op: 'createTable', table: 't', columns: [{ name: 'a', type: 'int' }] },
            { op: 'dropTable', table: 't' },
            { op: 'addColumn', table: 't', column: 'c', type: 'int' },
            { op: 'dropColumn', table: 't', column: 'c' },
            { op: 'alterColumn', table: 't', column: 'c', type: 'int' },
            { op: 'renameColumn', table: 't', from: 'a', to: 'b' },
            { op: 'renameTable', from: 'a', to: 'b' },
            { op: 'createIndex', table: 't', index: 'i', columns: ['a'], unique: false },
            { op: 'dropIndex', table: 't', index: 'i' },
            { op: 'addForeignKey', table: 't', constraint: 'f', column: 'a', referencedTable: 'u', referencedColumn: 'id', onDelete: 'NO ACTION' },
            { op: 'dropForeignKey', table: 't', constraint: 'f' },
            { op: 'createMigrationHistory', table: '__MigrationHistory' },
        ];

        it.each(dialects)('renders every operation on %s', (dialect) => {
            for (const op of ops) {
                const statements = translators[dialect].translateDdl(op);
                expect(statements.length).toBeGreaterThan(0);
                for (const s of statements) {
                    expect(s.text.length).toBeGreaterThan(0);
                    expect(s.params).toEqual([]);
                }
            }
        });

        it('throws on an operation outside the union', () => {
            expect(() => translators.postgresql.translateDdl({ op: 'truncate' } as any)).toThrow();
        });
    });
});
