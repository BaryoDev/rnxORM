import { DdlOperation } from '../../../src/core/query/model/DdlOperation';
import { SqliteTranslator } from './SqliteTranslator';

const t = new SqliteTranslator();

function ddl(op: DdlOperation): string[] {
    return t.translateDdl(op).map((s) => {
        expect(s.params).toEqual([]);
        return s.text;
    });
}

describe('SqliteTranslator', () => {
    describe('select', () => {
        it('binds positional ? in text order', () => {
            const stmt = t.translateSelect({
                table: 'users',
                where: {
                    op: 'and',
                    parts: [
                        { op: 'gte', left: { kind: 'column', name: 'age' }, value: 18 },
                        { op: 'between', left: { kind: 'column', name: 'score' }, low: 1, high: 9 },
                        { op: 'in', left: { kind: 'column', name: 'id' }, values: [1, 2] },
                    ],
                },
            });
            expect(stmt.text).toBe('SELECT * FROM users WHERE age >= ? AND score BETWEEN ? AND ? AND id IN (?, ?)');
            expect(stmt.params).toEqual([18, 1, 9, 1, 2]);
        });

        it('paginates with LIMIT and OFFSET, using LIMIT -1 for skip alone', () => {
            const base = { table: 'users', orderBy: [{ operand: { kind: 'column' as const, name: 'id' }, direction: 'asc' as const }] };
            expect(t.translateSelect({ ...base, skip: 5, take: 10 }).text).toBe(
                'SELECT * FROM users ORDER BY id ASC LIMIT 10 OFFSET 5'
            );
            expect(t.translateSelect({ ...base, take: 10 }).text).toBe('SELECT * FROM users ORDER BY id ASC LIMIT 10');
            expect(t.translateSelect({ ...base, skip: 5 }).text).toBe('SELECT * FROM users ORDER BY id ASC LIMIT -1 OFFSET 5');
        });

        it('renders ilike through LOWER', () => {
            const stmt = t.translateSelect({
                table: 'users',
                where: { op: 'ilike', left: { kind: 'column', name: 'name' }, value: 'a%' },
            });
            expect(stmt.text).toBe('SELECT * FROM users WHERE LOWER(name) LIKE LOWER(?)');
            expect(stmt.params).toEqual(['a%']);
        });
    });

    describe('insert', () => {
        it('uses RETURNING for a generated key', () => {
            const stmt = t.translateInsert({ table: 'users', columns: ['name', 'age'], values: ['a', 3], returning: 'id' });
            expect(stmt.text).toBe('INSERT INTO users (name, age) VALUES (?, ?) RETURNING id');
            expect(stmt.params).toEqual(['a', 3]);
        });

        it('ignores identityInsert and omits RETURNING when no key is read back', () => {
            const stmt = t.translateInsert({ table: 'users', columns: ['id'], values: [1], identityInsert: true });
            expect(stmt.text).toBe('INSERT INTO users (id) VALUES (?)');
        });
    });

    describe('DDL', () => {
        it('creates a table with an autoincrement key, defaults and quoted names', () => {
            expect(
                ddl({
                    op: 'createTable',
                    table: 'users',
                    columns: [
                        { name: 'id', type: 'INTEGER', isPrimaryKey: true, isAutoIncrement: true },
                        { name: 'name', type: 'TEXT', nullable: false },
                        { name: 'active', type: 'BOOLEAN', defaultValue: true },
                    ],
                })
            ).toEqual([
                'CREATE TABLE "users" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "name" TEXT NOT NULL, "active" BOOLEAN DEFAULT 1)',
            ]);
        });

        it('adds a column and creates an index', () => {
            expect(ddl({ op: 'addColumn', table: 'users', column: 'age', type: 'INTEGER', nullable: false, defaultValue: 0 })).toEqual([
                'ALTER TABLE "users" ADD COLUMN "age" INTEGER NOT NULL DEFAULT 0',
            ]);
            expect(ddl({ op: 'createIndex', table: 'users', index: 'ix_users_name', columns: ['name'], unique: true })).toEqual([
                'CREATE UNIQUE INDEX "ix_users_name" ON "users" ("name")',
            ]);
            expect(ddl({ op: 'dropIndex', table: 'users', index: 'ix_users_name' })).toEqual([
                'DROP INDEX IF EXISTS "ix_users_name"',
            ]);
        });

        it('renames a column and a table natively', () => {
            expect(ddl({ op: 'renameColumn', table: 'users', from: 'a', to: 'b' })).toEqual([
                'ALTER TABLE "users" RENAME COLUMN "a" TO "b"',
            ]);
            expect(ddl({ op: 'renameTable', from: 'users', to: 'people' })).toEqual(['ALTER TABLE "users" RENAME TO "people"']);
        });

        it('refuses a foreign key on an existing table', () => {
            const op: DdlOperation = {
                op: 'addForeignKey',
                table: 'posts',
                constraint: 'fk',
                column: 'user_id',
                referencedTable: 'users',
                referencedColumn: 'id',
                onDelete: 'CASCADE',
            };
            expect(() => t.translateDdl(op)).toThrow(/cannot add a foreign key/);
        });

        it('throws a clear error for alterColumn, which needs a table definition', () => {
            expect(() => t.translateDdl({ op: 'alterColumn', table: 'users', column: 'age', type: 'BIGINT' })).toThrow(
                /alterColumn needs the full table definition/
            );
        });
    });

    describe('ensureCreated operations', () => {
        it('creates tables with declared types SQLite readers can map back', () => {
            expect(
                ddl({
                    op: 'ensureTable',
                    table: 't',
                    columns: [
                        { name: 'id', type: 'integer', isPrimaryKey: true, nullable: false },
                        { name: 'name', type: 'varchar(50)', isPrimaryKey: false, nullable: false },
                        { name: 'ok', type: 'boolean', isPrimaryKey: false, nullable: true },
                        { name: 'at', type: 'timestamp', isPrimaryKey: false, nullable: true },
                    ],
                })
            ).toEqual([
                'CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY AUTOINCREMENT, name VARCHAR(50) NOT NULL, ok BOOLEAN, at DATETIME);',
            ]);
        });

        it('puts the foreign keys of a join table inline', () => {
            const [text] = ddl({
                op: 'ensureJoinTable',
                table: 'a_b',
                column1: 'a_id',
                column2: 'b_id',
                referencedTable1: 'a',
                referencedTable2: 'b',
            });
            expect(text).toContain('a_id INTEGER NOT NULL');
            expect(text).toContain('PRIMARY KEY (a_id, b_id)');
            expect(text).toContain('FOREIGN KEY (a_id) REFERENCES a(id) ON DELETE CASCADE');
        });

        it('adds columns and indexes, and turns a unique constraint into a unique index', () => {
            expect(ddl({ op: 'ensureAddColumn', table: 't', column: 'c', type: 'integer' })).toEqual([
                'ALTER TABLE t ADD COLUMN c INTEGER',
            ]);
            expect(ddl({ op: 'ensureIndex', table: 't', index: 'ix', columns: ['a', 'b'], unique: false })).toEqual([
                'CREATE INDEX ix ON t (a, b)',
            ]);
            expect(ddl({ op: 'ensureUniqueConstraint', table: 't', constraint: 'uq', columns: ['a'] })).toEqual([
                'CREATE UNIQUE INDEX uq ON t (a)',
            ]);
        });

        it('emits nothing for a late foreign key or a column type change', () => {
            expect(
                ddl({ op: 'ensureForeignKey', table: 't', column: 'c', referencedTable: 'r', referencedColumn: 'id' })
            ).toEqual([]);
            expect(ddl({ op: 'ensureAlterColumnType', table: 't', column: 'c', type: 'text' })).toEqual([]);
        });
    });
});
