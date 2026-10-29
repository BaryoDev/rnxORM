import { InsertModel } from '../../../src/core/query/model/InsertModel';
import { UpdateModel } from '../../../src/core/query/model/UpdateModel';
import { DeleteModel } from '../../../src/core/query/model/DeleteModel';
import { Predicate } from '../../../src/core/query/model/Predicate';
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

/** Expected text uses {n} for the nth placeholder; this fills in the dialect's form. */
function fill(template: string, dialect: Dialect): string {
    return template.replace(/\{(\d+)\}/g, (_m, n: string) => {
        if (dialect === 'postgresql') return `$${n}`;
        if (dialect === 'mssql') return `@p${Number(n) - 1}`;
        return '?';
    });
}

const eq = (name: string, value: any): Predicate => ({
    op: 'eq',
    left: { kind: 'column', name },
    value,
});

describe('DML translation', () => {
    describe.each(dialects)('%s', (dialect) => {
        const t = translators[dialect];

        describe('insert', () => {
            const model: InsertModel = {
                table: 'users',
                columns: ['name', 'age'],
                values: ['Ann', 30],
            };

            it('renders a plain insert without returning', () => {
                const stmt = t.translateInsert(model);
                expect(stmt.text).toBe(fill('INSERT INTO users (name, age) VALUES ({1}, {2})', dialect));
                expect(stmt.params).toEqual(['Ann', 30]);
            });

            it('asks for the generated key when returning is set', () => {
                const stmt = t.translateInsert({ ...model, returning: 'id' });
                const expected = {
                    postgresql: 'INSERT INTO users (name, age) VALUES ({1}, {2}) RETURNING id',
                    mssql: 'INSERT INTO users (name, age) OUTPUT INSERTED.id VALUES ({1}, {2})',
                    mariadb: 'INSERT INTO users (name, age) VALUES ({1}, {2})',
                }[dialect];
                expect(stmt.text).toBe(fill(expected, dialect));
                expect(stmt.params).toEqual(['Ann', 30]);
            });

            it('wraps an explicit key insert in IDENTITY_INSERT on mssql only', () => {
                const stmt = t.translateInsert({
                    table: 'users',
                    columns: ['id', 'name'],
                    values: [7, 'Ann'],
                    identityInsert: true,
                });
                const expected =
                    dialect === 'mssql'
                        ? 'SET IDENTITY_INSERT users ON; INSERT INTO users (id, name) VALUES ({1}, {2}); SET IDENTITY_INSERT users OFF'
                        : 'INSERT INTO users (id, name) VALUES ({1}, {2})';
                expect(stmt.text).toBe(fill(expected, dialect));
                expect(stmt.params).toEqual([7, 'Ann']);
            });
        });

        describe('update', () => {
            it('numbers SET first, then the where list in order', () => {
                const model: UpdateModel = {
                    table: 'users',
                    set: [
                        { column: 'name', value: 'Bob' },
                        { column: 'version', value: 3 },
                    ],
                    where: { op: 'and', parts: [eq('id', 5), eq('version', 2)] },
                };
                const stmt = t.translateUpdate(model);
                expect(stmt.text).toBe(
                    fill('UPDATE users SET name = {1}, version = {2} WHERE id = {3} AND version = {4}', dialect)
                );
                expect(stmt.params).toEqual(['Bob', 3, 5, 2]);
            });

            it('renders a single key predicate', () => {
                const stmt = t.translateUpdate({
                    table: 'users',
                    set: [{ column: 'name', value: 'Bob' }],
                    where: { op: 'and', parts: [eq('id', 5)] },
                });
                expect(stmt.text).toBe(fill('UPDATE users SET name = {1} WHERE id = {2}', dialect));
                expect(stmt.params).toEqual(['Bob', 5]);
            });

            it('rejects an empty set list', () => {
                expect(() => t.translateUpdate({ table: 'users', set: [] })).toThrow('no columns to set');
            });
        });

        describe('delete', () => {
            it('renders the key predicate', () => {
                const model: DeleteModel = { table: 'users', where: { op: 'and', parts: [eq('id', 5)] } };
                const stmt = t.translateDelete(model);
                expect(stmt.text).toBe(fill('DELETE FROM users WHERE id = {1}', dialect));
                expect(stmt.params).toEqual([5]);
            });

            it('appends concurrency token predicates after the key', () => {
                const stmt = t.translateDelete({
                    table: 'users',
                    where: { op: 'and', parts: [eq('id', 5), eq('version', 2)] },
                });
                expect(stmt.text).toBe(fill('DELETE FROM users WHERE id = {1} AND version = {2}', dialect));
                expect(stmt.params).toEqual([5, 2]);
            });
        });
    });

    it('uses bare ? marks in param order on mariadb', () => {
        const stmt = translators.mariadb.translateUpdate({
            table: 'users',
            set: [{ column: 'name', value: 'Bob' }],
            where: { op: 'and', parts: [eq('id', 5), eq('version', 2)] },
        });
        expect(stmt.text).toBe('UPDATE users SET name = ? WHERE id = ? AND version = ?');
        expect(stmt.params).toEqual(['Bob', 5, 2]);
    });
});
