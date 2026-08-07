import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';
import { MockDatabaseProvider } from '../mocks/MockDatabaseProvider';

@Entity('tt_items')
class TtItem {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

@Entity('tt_audited')
class TtAudited {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;
}

@Entity('tt_evolving')
class TtEvolving {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

beforeAll(() => {
    new ModelBuilder().entity(TtAudited)
        .shadowProperty('createdBy', 'text', { defaultValue: 'system' });
});

function makeDb(): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider('postgresql');
    const db = new DbContext(provider);
    return { db, provider };
}

describe('asNoTracking()', () => {
    it('does not register returned entities in the change tracker', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'A' }], rowCount: 1 });

        const [item] = await db.set(TtItem).asNoTracking().toList();

        expect(db.changeTracker.entry(item)).toBeFalsy();
    });

    it('does not persist modifications to untracked entities', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'A' }], rowCount: 1 });

        const [item] = await db.set(TtItem).asNoTracking().toList();
        item.name = 'B';
        const saved = await db.saveChanges();

        expect(saved).toBe(0);
        expect(provider.calls.some(c => c.sql.startsWith('UPDATE'))).toBe(false);
    });

    it('persists modifications to tracked entities (contrast)', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'A' }], rowCount: 1 });

        const [item] = await db.set(TtItem).toList();
        item.name = 'B';
        const saved = await db.saveChanges();

        expect(saved).toBe(1);
        const update = provider.calls.find(c => c.sql.startsWith('UPDATE tt_items'))!;
        expect(update.params).toContain('B');
    });
});

describe('saveChanges() transaction wrapping', () => {
    it('wraps changes in begin/commit', async () => {
        const { db, provider } = makeDb();
        const beginSpy = jest.spyOn(provider, 'beginTransaction');
        const commitSpy = jest.spyOn(provider, 'commitTransaction');
        const rollbackSpy = jest.spyOn(provider, 'rollbackTransaction');

        const item = new TtItem();
        item.id = 1;
        item.name = 'A';
        db.set(TtItem).add(item);
        await db.saveChanges();

        expect(beginSpy).toHaveBeenCalledTimes(1);
        expect(commitSpy).toHaveBeenCalledTimes(1);
        expect(rollbackSpy).not.toHaveBeenCalled();
        expect(provider.calls.some(c => c.sql.startsWith('INSERT INTO tt_items'))).toBe(true);
    });

    it('rolls back and rethrows when a statement fails', async () => {
        const { db, provider } = makeDb();
        const commitSpy = jest.spyOn(provider, 'commitTransaction');
        const rollbackSpy = jest.spyOn(provider, 'rollbackTransaction');
        const original = provider.query.bind(provider);
        jest.spyOn(provider, 'query').mockImplementation(async (sql: string, params?: any[]) => {
            if (sql.startsWith('INSERT')) {
                throw new Error('boom');
            }
            return original(sql, params);
        });

        const item = new TtItem();
        item.id = 1;
        item.name = 'A';
        db.set(TtItem).add(item);

        await expect(db.saveChanges()).rejects.toThrow('boom');
        expect(rollbackSpy).toHaveBeenCalledTimes(1);
        expect(commitSpy).not.toHaveBeenCalled();
    });
});

describe('executeSqlRaw()', () => {
    it('executes the statement and returns the affected row count', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 5 });

        const affected = await db.executeSqlRaw('UPDATE tt_items SET name = $1', ['x']);

        expect(affected).toBe(5);
        expect(provider.lastCall!.sql).toBe('UPDATE tt_items SET name = $1');
        expect(provider.lastCall!.params).toEqual(['x']);
    });
});

describe('shadow properties on insert', () => {
    it('includes shadow columns with their default values in INSERT', async () => {
        const { db, provider } = makeDb();

        const audited = new TtAudited();
        audited.id = 1;
        audited.title = 'Report';
        db.set(TtAudited).add(audited);
        await db.saveChanges();

        const insert = provider.calls.find(c => c.sql.startsWith('INSERT INTO tt_audited'))!;
        expect(insert.sql).toContain('createdBy');
        expect(insert.params).toContain('system');
    });
});

describe('ensureCreated() schema evolution', () => {
    it('adds columns missing from the database schema', async () => {
        const provider = new MockDatabaseProvider();
        const db = new DbContext(provider);
        await db.connect();

        const querySpy = jest.spyOn(provider, 'query');
        await db.ensureCreated();

        // The mock reports no existing columns, so every column is added
        const alterCalls = querySpy.mock.calls
            .map(([sql]) => sql as string)
            .filter(sql => sql.includes('ADD COLUMN'));
        expect(alterCalls.some(sql => sql.includes('tt_evolving') && sql.includes('name'))).toBe(true);

        await db.disconnect();
    });

    it('attempts a type migration when the database type mismatches', async () => {
        const provider = new MockDatabaseProvider();
        const db = new DbContext(provider);
        await db.connect();

        const original = provider.query.bind(provider);
        const querySpy = jest.spyOn(provider, 'query').mockImplementation(async (sql: string, params?: any[]) => {
            if (sql.includes('information_schema')) {
                // Report 'name' as integer in the database; the entity declares text
                return {
                    rows: [
                        { column_name: 'id', data_type: 'integer' },
                        { column_name: 'name', data_type: 'integer' },
                    ],
                    rowCount: 2,
                };
            }
            return original(sql, params);
        });

        await db.ensureCreated();

        const alterTypeCalls = querySpy.mock.calls
            .map(([sql]) => sql as string)
            .filter(sql => sql.includes('ALTER COLUMN'));
        expect(alterTypeCalls.some(sql => sql.includes('tt_evolving') && sql.includes('name'))).toBe(true);

        await db.disconnect();
    });
});
