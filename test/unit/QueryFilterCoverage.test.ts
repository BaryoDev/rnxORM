import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

/**
 * Coverage for structured (SQL-translated) global query filters
 * (metadata.queryFilterConditions, configured via ModelBuilder.hasQueryFilter)
 * across every DbSet/QueryBuilder read path (GitHub issues #23 / #19).
 *
 * The original shipped bug was that count() silently ignored query filters.
 * This file pins that count() (and every other read path) now includes the
 * filter, and separately documents where the filter is still NOT applied:
 * groupBy(), and the legacy predicate form of hasQueryFilter() on any
 * SQL-aggregating path (count/sum/average/min/max).
 */

@Entity('qfc_users')
class QfcUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    salary!: number;

    @Column()
    isdeleted!: boolean;
}

// Legacy (predicate) form of hasQueryFilter - evaluated in memory, not
// translated to SQL. See "legacy lambda form" describe block below.
@Entity('qfc_legacy_users')
class QfcLegacyUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    isdeleted!: boolean;
}

new ModelBuilder()
    .entity(QfcUser)
    .hasQueryFilter({ property: 'isdeleted', operator: '=', value: false });

new ModelBuilder()
    .entity(QfcLegacyUser)
    .hasQueryFilter((u) => !u.isdeleted);

function makeDb(dialect: CaptureDialect = 'postgresql'): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider(dialect);
    const db = new DbContext(provider);
    return { db, provider };
}

describe('structured query filter: count()', () => {
    it('includes the filter in COUNT SQL (the originally-shipped bug: count() ignored filters)', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '5' }], rowCount: 1 });

        const count = await db.set(QfcUser).count();

        expect(provider.lastCall!.sql).toBe('SELECT COUNT(*) as count FROM qfc_users WHERE isdeleted = $1');
        expect(provider.lastCall!.params).toEqual([false]);
        expect(count).toBe(5);
    });

    it('includes the filter in QueryBuilder count() alongside a where() condition', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '2' }], rowCount: 1 });

        await db.set(QfcUser).where('salary', '>', 1000).count();

        expect(provider.lastCall!.sql).toBe(
            'SELECT COUNT(*) as count FROM qfc_users WHERE salary > $1 AND isdeleted = $2'
        );
        expect(provider.lastCall!.params).toEqual([1000, false]);
    });
});

describe('structured query filter: skip()/take() pagination', () => {
    it('includes the filter in the WHERE clause alongside LIMIT/OFFSET on postgresql', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(QfcUser).skip(5).take(10).toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM qfc_users WHERE isdeleted = $1 LIMIT 10 OFFSET 5'
        );
        expect(provider.lastCall!.params).toEqual([false]);
    });

    it('includes the filter in the WHERE clause alongside OFFSET/FETCH on mssql', async () => {
        const { db, provider } = makeDb('mssql');
        await db.set(QfcUser).skip(5).take(10).toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM qfc_users WHERE isdeleted = @p0 ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY'
        );
        expect(provider.lastCall!.params).toEqual([false]);
    });
});

describe('structured query filter: all()', () => {
    it('all() delegates to toList().every(), so the filter is present in the underlying fetch SQL', async () => {
        // all() only exists on QueryBuilder (not directly on DbSet), so reach it
        // via where(); QueryBuilder.all() is `(await this.toList()).every(predicate)`.
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', salary: 100, isdeleted: false }],
            rowCount: 1,
        });

        const result = await db.set(QfcUser).where('id', '>', 0).all((u: QfcUser) => u.salary > 0);

        // all() issues exactly one query, which is the normal filtered toList() SQL.
        expect(provider.calls).toHaveLength(1);
        expect(provider.lastCall!.sql).toBe('SELECT * FROM qfc_users WHERE id > $1 AND isdeleted = $2');
        expect(result).toBe(true);
    });
});

describe('structured query filter: sum/average/min/max', () => {
    it('includes the filter in SUM SQL', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ total: '999' }], rowCount: 1 });
        await db.set(QfcUser).sum((u) => u.salary);

        expect(provider.lastCall!.sql).toBe('SELECT SUM(salary) as total FROM qfc_users WHERE isdeleted = $1');
        expect(provider.lastCall!.params).toEqual([false]);
    });

    it('includes the filter in AVG SQL', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ avg: '50' }], rowCount: 1 });
        await db.set(QfcUser).average((u) => u.salary);

        expect(provider.lastCall!.sql).toBe('SELECT AVG(salary) as avg FROM qfc_users WHERE isdeleted = $1');
    });

    it('includes the filter in MIN SQL (QueryBuilder path, after a where() condition)', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ min: 10 }], rowCount: 1 });
        await db.set(QfcUser).where('salary', '>', 0).min((u) => u.salary);

        expect(provider.lastCall!.sql).toBe(
            'SELECT MIN(salary) as min FROM qfc_users WHERE salary > $1 AND isdeleted = $2'
        );
        expect(provider.lastCall!.params).toEqual([0, false]);
    });

    it('includes the filter in MAX SQL (QueryBuilder path, after a where() condition)', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ max: 500 }], rowCount: 1 });
        await db.set(QfcUser).where('salary', '>', 0).max((u) => u.salary);

        expect(provider.lastCall!.sql).toBe(
            'SELECT MAX(salary) as max FROM qfc_users WHERE salary > $1 AND isdeleted = $2'
        );
    });
});

describe('structured query filter: select() projections', () => {
    it('includes the filter alongside a SQL-optimized column projection', async () => {
        const { db, provider } = makeDb();
        await db.set(QfcUser).select((u) => ({ userName: u.name })).toList();

        expect(provider.lastCall!.sql).toBe('SELECT name AS userName FROM qfc_users WHERE isdeleted = $1');
        expect(provider.lastCall!.params).toEqual([false]);
    });

    it('includes the filter when the selector falls back to SELECT * + in-memory projection', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', salary: 100, isdeleted: false }],
            rowCount: 1,
        });

        const results = await db.set(QfcUser).select((u) => ({ label: `${u.name}!` })).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qfc_users WHERE isdeleted = $1');
        expect(results).toEqual([{ label: 'Alice!' }]);
    });
});

describe('structured query filter: find()', () => {
    it('includes the filter appended after the primary key condition', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', salary: 100, isdeleted: false }],
            rowCount: 1,
        });

        const user = await db.set(QfcUser).find(1);

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qfc_users WHERE id = $1 AND isdeleted = $2');
        expect(provider.lastCall!.params).toEqual([1, false]);
        expect(user!.name).toBe('Alice');
    });
});

describe('ignoreQueryFilters() omits the structured filter', () => {
    it('omits the filter from toList() SQL', async () => {
        const { db, provider } = makeDb();
        await db.set(QfcUser).ignoreQueryFilters().toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qfc_users');
        expect(provider.lastCall!.params).toEqual([]);
    });

    it('omits the filter from count() SQL', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '9' }], rowCount: 1 });
        await db.set(QfcUser).ignoreQueryFilters().count();

        expect(provider.lastCall!.sql).toBe('SELECT COUNT(*) as count FROM qfc_users ');
        expect(provider.lastCall!.params).toEqual([]);
    });
});

describe('documented limitation: structured filters are NOT applied to groupBy()', () => {
    // Reading GroupedQueryBuilder.toList() and GroupedSelectBuilder.toList() in
    // src/core/DbSet.ts shows neither calls compileQueryFilter()/compileFilters()
    // at all - conditions carried over from a preceding where() are included,
    // but the entity's global structured query filter never is. This is a
    // known, currently-unaddressed gap (see issues #23 / #19); it is pinned
    // here rather than skipped so a future fix shows up as an intentional
    // test change, not a silent regression.
    it('bare groupBy().toList() omits the filter entirely', async () => {
        const { db, provider } = makeDb();
        await db.set(QfcUser).groupBy((u) => u.name).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qfc_users');
    });

    it('groupBy().select() (aggregated) SQL also omits the filter', async () => {
        const { db, provider } = makeDb();
        await db
            .set(QfcUser)
            .groupBy((u) => u.name)
            .select((g) => ({ count: g.count() }))
            .toList();

        expect(provider.lastCall!.sql).toBe('SELECT name, COUNT(*) as count FROM qfc_users GROUP BY name');
    });

    it('groupBy() inherited from a where() chain keeps the user condition but still drops the filter', async () => {
        const { db, provider } = makeDb();
        await db
            .set(QfcUser)
            .where('salary', '>', 0)
            .groupBy((u) => u.name)
            .select((g) => ({ count: g.count() }))
            .toList();

        // 'isdeleted = ...' is absent even though QfcUser has a structured filter.
        expect(provider.lastCall!.sql).toBe(
            'SELECT name, COUNT(*) as count FROM qfc_users WHERE salary > $1 GROUP BY name'
        );
        expect(provider.lastCall!.params).toEqual([0]);
    });
});

describe('legacy lambda form of hasQueryFilter (issue #23 remaining limitation)', () => {
    it('does NOT push the predicate into SQL - toList() fetches unfiltered rows and filters them in memory', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, name: 'Kept', isdeleted: false },
                { id: 2, name: 'Dropped', isdeleted: true },
            ],
            rowCount: 2,
        });

        const users = await db.set(QfcLegacyUser).toList();

        // No WHERE clause at all - the legacy predicate never reaches SQL.
        expect(provider.lastCall!.sql).toBe('SELECT * FROM qfc_legacy_users');
        // But the in-memory filter still removes the non-matching row from the result.
        expect(users).toHaveLength(1);
        expect(users[0].name).toBe('Kept');
    });

    it('the where().toList() (QueryBuilder) path also filters the legacy predicate in memory only', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, name: 'Kept', isdeleted: false },
                { id: 2, name: 'Dropped', isdeleted: true },
            ],
            rowCount: 2,
        });

        const users = await db.set(QfcLegacyUser).where('id', '>', 0).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM qfc_legacy_users WHERE id > $1');
        expect(users).toHaveLength(1);
        expect(users[0].name).toBe('Kept');
    });

    it('documented limitation: count() with a legacy lambda filter counts UNFILTERED rows (issue #23)', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '10' }], rowCount: 1 });

        const count = await db.set(QfcLegacyUser).count();

        // count() only ever consults metadata.queryFilterConditions (structured
        // form) via compileFilterWhere()/compileFilters() - it has no code path
        // that evaluates the legacy predicate function, so the SQL has no WHERE
        // clause and the returned count includes rows that toList() would have
        // filtered out in memory. This is the remaining gap from issue #23:
        // count() is only fixed for the structured filter form, not the legacy
        // lambda form.
        expect(provider.lastCall!.sql).toBe('SELECT COUNT(*) as count FROM qfc_legacy_users');
        expect(count).toBe(10);
    });
});
