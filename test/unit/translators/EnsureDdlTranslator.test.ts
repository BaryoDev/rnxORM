import { DdlOperation, EnsureColumn } from '../../../src/core/query/model/DdlOperation';
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

/** The statement text for a single-statement operation, with no parameters. */
function render(dialect: Dialect, op: DdlOperation): string {
    const statements = translators[dialect].translateDdl(op);
    expect(statements).toHaveLength(1);
    expect(statements[0].params).toEqual([]);
    return statements[0].text;
}

function expectPerDialect(op: DdlOperation, expected: Record<Dialect, string>): void {
    for (const dialect of dialects) {
        expect(render(dialect, op)).toBe(expected[dialect]);
    }
}

const col = (name: string, type: string, isPrimaryKey = false, nullable = true): EnsureColumn => ({
    name,
    type,
    isPrimaryKey,
    nullable,
});

const MSSQL_GUARD = (table: string) => `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${table}')\n                `;

describe('ensureCreated DDL translation', () => {
    describe('ensureTable', () => {
        it('maps types, makes an integer key auto-increment and marks required columns NOT NULL', () => {
            expectPerDialect(
                {
                    op: 'ensureTable',
                    table: 't',
                    columns: [
                        col('id', 'integer', true, false),
                        col('name', 'text'),
                        col('email', 'varchar(50)', false, false),
                        col('price', 'decimal', false, false),
                        col('ok', 'boolean'),
                        col('data', 'json', false, false),
                    ],
                },
                {
                    postgresql:
                        'CREATE TABLE IF NOT EXISTS t (id SERIAL PRIMARY KEY, name TEXT, email VARCHAR(50) NOT NULL, price DECIMAL(18,2) NOT NULL, ok BOOLEAN, data JSONB NOT NULL);',
                    mssql:
                        MSSQL_GUARD('t') +
                        'CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(MAX), email NVARCHAR(50) NOT NULL, price DECIMAL(18,2) NOT NULL, ok BIT, data NVARCHAR(MAX) NOT NULL);',
                    mariadb:
                        'CREATE TABLE IF NOT EXISTS t (id INT AUTO_INCREMENT PRIMARY KEY, name TEXT, email VARCHAR(50) NOT NULL, price DECIMAL(18,2) NOT NULL, ok TINYINT(1), data JSON NOT NULL);',
                }
            );
        });

        it('leaves a non-integer primary key as a plain PRIMARY KEY column', () => {
            expectPerDialect(
                { op: 'ensureTable', table: 't', columns: [col('code', 'varchar(10)', true, false), col('n', 'integer', false, false)] },
                {
                    postgresql: 'CREATE TABLE IF NOT EXISTS t (code VARCHAR(10) PRIMARY KEY, n INTEGER NOT NULL);',
                    mssql: MSSQL_GUARD('t') + 'CREATE TABLE t (code NVARCHAR(10) PRIMARY KEY, n INT NOT NULL);',
                    mariadb: 'CREATE TABLE IF NOT EXISTS t (code VARCHAR(10) PRIMARY KEY, n INT NOT NULL);',
                }
            );
        });

        it('emits nullable columns bare and never adds NOT NULL to a key', () => {
            expectPerDialect(
                { op: 'ensureTable', table: 't', columns: [col('id', 'integer', true, false), col('note', 'text', false, true)] },
                {
                    postgresql: 'CREATE TABLE IF NOT EXISTS t (id SERIAL PRIMARY KEY, note TEXT);',
                    mssql: MSSQL_GUARD('t') + 'CREATE TABLE t (id INT IDENTITY(1,1) PRIMARY KEY, note NVARCHAR(MAX));',
                    mariadb: 'CREATE TABLE IF NOT EXISTS t (id INT AUTO_INCREMENT PRIMARY KEY, note TEXT);',
                }
            );
        });

        // Today's output for a composite key: each integer key column is
        // rendered as its own auto-increment primary key. Pinned so a change
        // to it is deliberate.
        it('renders each key column of a composite key on its own', () => {
            expectPerDialect(
                {
                    op: 'ensureTable',
                    table: 't',
                    columns: [col('a', 'integer', true, false), col('b', 'integer', true, false), col('c', 'text')],
                },
                {
                    postgresql: 'CREATE TABLE IF NOT EXISTS t (a SERIAL PRIMARY KEY, b SERIAL PRIMARY KEY, c TEXT);',
                    mssql:
                        MSSQL_GUARD('t') +
                        'CREATE TABLE t (a INT IDENTITY(1,1) PRIMARY KEY, b INT IDENTITY(1,1) PRIMARY KEY, c NVARCHAR(MAX));',
                    mariadb:
                        'CREATE TABLE IF NOT EXISTS t (a INT AUTO_INCREMENT PRIMARY KEY, b INT AUTO_INCREMENT PRIMARY KEY, c TEXT);',
                }
            );
        });

        it('does not quote or validate names', () => {
            const text = render('mssql', { op: 'ensureTable', table: 'dbo.t', columns: [col('id', 'integer', true, false)] });
            expect(text).toContain("name = 'dbo.t'");
            expect(text).toContain('CREATE TABLE dbo.t (');
        });
    });

    describe('ensureJoinTable', () => {
        const base = {
            op: 'ensureJoinTable' as const,
            table: 'student_course',
            column1: 'student_id',
            column2: 'course_id',
            referencedTable1: 'students',
            referencedTable2: 'courses',
        };
        const lines = (type: string, ref1: string, ref2: string, action: string, indent: string) =>
            [
                `student_id ${type} NOT NULL,`,
                `course_id ${type} NOT NULL,`,
                'PRIMARY KEY (student_id, course_id),',
                `FOREIGN KEY (student_id) REFERENCES students(${ref1}) ON DELETE ${action},`,
                `FOREIGN KEY (course_id) REFERENCES courses(${ref2}) ON DELETE ${action}`,
            ]
                .map((l) => indent + l)
                .join('\n');

        it('defaults referenced columns to id and the delete action to CASCADE', () => {
            expectPerDialect(base, {
                postgresql:
                    'CREATE TABLE IF NOT EXISTS student_course (\n' +
                    lines('INTEGER', 'id', 'id', 'CASCADE', ' '.repeat(12)) +
                    '\n        )',
                mssql:
                    MSSQL_GUARD('student_course') +
                    'CREATE TABLE student_course (\n' +
                    lines('INT', 'id', 'id', 'CASCADE', ' '.repeat(20)) +
                    '\n                )',
                mariadb:
                    'CREATE TABLE IF NOT EXISTS student_course (\n' +
                    lines('INT', 'id', 'id', 'CASCADE', ' '.repeat(12)) +
                    '\n        )',
            });
        });

        it('uses the given referenced columns and delete action', () => {
            expectPerDialect(
                { ...base, onDelete: 'SET NULL', referencedColumn1: 'sid', referencedColumn2: 'cid' },
                {
                    postgresql:
                        'CREATE TABLE IF NOT EXISTS student_course (\n' +
                        lines('INTEGER', 'sid', 'cid', 'SET NULL', ' '.repeat(12)) +
                        '\n        )',
                    mssql:
                        MSSQL_GUARD('student_course') +
                        'CREATE TABLE student_course (\n' +
                        lines('INT', 'sid', 'cid', 'SET NULL', ' '.repeat(20)) +
                        '\n                )',
                    mariadb:
                        'CREATE TABLE IF NOT EXISTS student_course (\n' +
                        lines('INT', 'sid', 'cid', 'SET NULL', ' '.repeat(12)) +
                        '\n        )',
                }
            );
        });
    });

    describe('ensureForeignKey', () => {
        const base = {
            op: 'ensureForeignKey' as const,
            table: 'orders',
            column: 'user_id',
            referencedTable: 'users',
            referencedColumn: 'id',
        };
        const head =
            'ALTER TABLE orders ADD CONSTRAINT fk_orders_user_id FOREIGN KEY (user_id) REFERENCES users(id)';
        const same = (suffix: string): Record<Dialect, string> => ({
            postgresql: head + suffix,
            mssql: head + suffix,
            mariadb: head + suffix,
        });

        it('names the constraint fk_<table>_<column> and adds no action by default', () => {
            expectPerDialect(base, same(''));
        });

        it('adds ON DELETE', () => {
            expectPerDialect({ ...base, onDelete: 'CASCADE' }, same(' ON DELETE CASCADE'));
        });

        it('adds ON UPDATE alone', () => {
            expectPerDialect({ ...base, onUpdate: 'CASCADE' }, same(' ON UPDATE CASCADE'));
        });

        it('adds ON DELETE before ON UPDATE', () => {
            expectPerDialect(
                { ...base, onDelete: 'SET NULL', onUpdate: 'NO ACTION' },
                same(' ON DELETE SET NULL ON UPDATE NO ACTION')
            );
        });
    });

    describe('ensureIndex', () => {
        it('renders a plain index over several columns', () => {
            const sql = 'CREATE INDEX idx_t_a_b ON t (a, b)';
            expectPerDialect(
                { op: 'ensureIndex', table: 't', index: 'idx_t_a_b', columns: ['a', 'b'], unique: false },
                { postgresql: sql, mssql: sql, mariadb: sql }
            );
        });

        it('renders a unique index', () => {
            const sql = 'CREATE UNIQUE INDEX idx_t_a ON t (a)';
            expectPerDialect(
                { op: 'ensureIndex', table: 't', index: 'idx_t_a', columns: ['a'], unique: true },
                { postgresql: sql, mssql: sql, mariadb: sql }
            );
        });
    });

    describe('ensureUniqueConstraint', () => {
        it('adds a named unique constraint over its columns', () => {
            const sql = 'ALTER TABLE t ADD CONSTRAINT uq_t_a_b UNIQUE (a, b)';
            expectPerDialect(
                { op: 'ensureUniqueConstraint', table: 't', constraint: 'uq_t_a_b', columns: ['a', 'b'] },
                { postgresql: sql, mssql: sql, mariadb: sql }
            );
        });
    });

    describe('ensureAddColumn', () => {
        it('uses ADD COLUMN, except on SQL Server which uses ADD', () => {
            expectPerDialect(
                { op: 'ensureAddColumn', table: 't', column: 'name', type: 'text' },
                {
                    postgresql: 'ALTER TABLE t ADD COLUMN name TEXT',
                    mssql: 'ALTER TABLE t ADD name NVARCHAR(MAX)',
                    mariadb: 'ALTER TABLE t ADD COLUMN name TEXT',
                }
            );
        });

        it('maps varchar with its length, N-prefixed on SQL Server', () => {
            expectPerDialect(
                { op: 'ensureAddColumn', table: 't', column: 'name', type: 'varchar(20)' },
                {
                    postgresql: 'ALTER TABLE t ADD COLUMN name VARCHAR(20)',
                    mssql: 'ALTER TABLE t ADD name NVARCHAR(20)',
                    mariadb: 'ALTER TABLE t ADD COLUMN name VARCHAR(20)',
                }
            );
        });
    });

    describe('ensureAlterColumnType', () => {
        it('converts with USING on PostgreSQL, MODIFY COLUMN on MariaDB, plain ALTER COLUMN on SQL Server', () => {
            expectPerDialect(
                { op: 'ensureAlterColumnType', table: 't', column: 'name', type: 'text' },
                {
                    postgresql: 'ALTER TABLE t ALTER COLUMN name TYPE TEXT USING name::TEXT',
                    mssql: 'ALTER TABLE t ALTER COLUMN name NVARCHAR(MAX)',
                    mariadb: 'ALTER TABLE t MODIFY COLUMN name TEXT',
                }
            );
        });

        it('repeats the mapped type in the PostgreSQL cast', () => {
            expectPerDialect(
                { op: 'ensureAlterColumnType', table: 't', column: 'name', type: 'varchar(20)' },
                {
                    postgresql: 'ALTER TABLE t ALTER COLUMN name TYPE VARCHAR(20) USING name::VARCHAR(20)',
                    mssql: 'ALTER TABLE t ALTER COLUMN name NVARCHAR(20)',
                    mariadb: 'ALTER TABLE t MODIFY COLUMN name VARCHAR(20)',
                }
            );
        });
    });
});
