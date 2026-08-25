import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { EntityState } from '../../src/core/EntityEntry';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

@Entity('sqlgen_users')
class SgUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    age!: number;
}

@Entity('sqlgen_products')
class SgProduct {
    @PrimaryKey()
    id!: number;

    @Column()
    price!: number;

    @Column()
    version!: number;
}

// Property names deliberately differ from their mapped column names, so any
// assertion against SQL generated from this entity proves the column name -
// not the property name - reached the statement.
@Entity('sqlgen_accounts')
class SgAccount {
    @PrimaryKey()
    id!: number;

    @Column({ name: 'full_name' })
    fullName!: string;

    @Column({ name: 'acct_balance' })
    balance!: number;
}

// Soft-delete-shaped entity for the set/null operators. @Column defaults the
// column name to the LOWERCASED property name, so `deletedAt` maps to
// `deletedat` — the assertions below spell the column, not the property.
@Entity('sqlgen_docs')
class SgDoc {
    @PrimaryKey()
    id!: number;

    @Column()
    status!: string;

    @Column()
    title!: string;

    @Column()
    deletedAt!: Date | null;
}

function makeDb(dialect: CaptureDialect): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider(dialect);
    const db = new DbContext(provider);
    return { db, provider };
}

beforeAll(() => {
    // Mark SgProduct.version as a concurrency token (normally done via ModelBuilder)
    const metadata = MetadataStorage.get().getEntity(SgProduct)!;
    const versionColumn = metadata.columns.find(c => c.propertyName === 'version')!;
    (versionColumn as any).isConcurrencyToken = true;
});

describe('QueryBuilder SQL generation', () => {
    it('generates LIMIT/OFFSET pagination on postgresql', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).where('age', '>', 18).orderBy('name').skip(5).take(10).toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM sqlgen_users WHERE age > $1 ORDER BY name ASC LIMIT 10 OFFSET 5'
        );
        expect(provider.lastCall!.params).toEqual([18]);
    });

    it('generates LIMIT/OFFSET pagination with ? placeholders on mariadb', async () => {
        const { db, provider } = makeDb('mariadb');
        await db.set(SgUser).where('age', '>', 18).orderBy('name').skip(5).take(10).toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM sqlgen_users WHERE age > ? ORDER BY name ASC LIMIT 10 OFFSET 5'
        );
    });

    it('generates OFFSET/FETCH pagination on mssql', async () => {
        const { db, provider } = makeDb('mssql');
        await db.set(SgUser).where('age', '>', 18).orderBy('name').skip(5).take(10).toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM sqlgen_users WHERE age > @p0 ORDER BY name ASC OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY'
        );
    });

    it('injects ORDER BY (SELECT NULL) for mssql pagination without orderBy', async () => {
        const { db, provider } = makeDb('mssql');
        await db.set(SgUser).skip(5).take(10).toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM sqlgen_users ORDER BY (SELECT NULL) OFFSET 5 ROWS FETCH NEXT 10 ROWS ONLY'
        );
    });

    it('joins multiple where conditions with AND and numbers placeholders', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).where('age', '>', 18).where('name', '=', 'Alice').toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT * FROM sqlgen_users WHERE age > $1 AND name = $2'
        );
        expect(provider.lastCall!.params).toEqual([18, 'Alice']);
    });

    it('generates SELECT DISTINCT *', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).distinct().toList();

        expect(provider.lastCall!.sql).toBe('SELECT DISTINCT * FROM sqlgen_users');
    });

    it('generates find() by primary key', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ id: 1, name: 'Alice', age: 30 }], rowCount: 1 });
        const user = await db.set(SgUser).find(1);

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_users WHERE id = $1');
        expect(provider.lastCall!.params).toEqual([1]);
        expect(user!.name).toBe('Alice');
    });
});

describe('Aggregate SQL generation', () => {
    it('generates SUM', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ total: '42' }], rowCount: 1 });
        const total = await db.set(SgUser).sum(u => u.age);

        expect(provider.lastCall!.sql).toBe('SELECT SUM(age) as total FROM sqlgen_users');
        expect(total).toBe(42);
    });

    it('generates AVG', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ avg: '21.5' }], rowCount: 1 });
        const avg = await db.set(SgUser).average(u => u.age);

        expect(provider.lastCall!.sql).toBe('SELECT AVG(age) as avg FROM sqlgen_users');
        expect(avg).toBe(21.5);
    });

    it('generates MIN and MAX', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ min: 1 }], rowCount: 1 });
        await db.set(SgUser).min(u => u.age);
        expect(provider.lastCall!.sql).toBe('SELECT MIN(age) as min FROM sqlgen_users');

        provider.nextResult({ rows: [{ max: 99 }], rowCount: 1 });
        await db.set(SgUser).max(u => u.age);
        expect(provider.lastCall!.sql).toBe('SELECT MAX(age) as max FROM sqlgen_users');
    });

    it('generates COUNT(*)', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ count: '7' }], rowCount: 1 });
        const count = await db.set(SgUser).count();

        expect(provider.lastCall!.sql).toBe('SELECT COUNT(*) as count FROM sqlgen_users');
        expect(count).toBe(7);
    });
});

describe('INSERT SQL generation and generated-id backfill', () => {
    it('appends RETURNING and backfills the id on postgresql', async () => {
        const { db, provider } = makeDb('postgresql');
        const user = new SgUser();
        user.name = 'Alice';
        user.age = 30;
        db.set(SgUser).add(user);
        provider.nextResult({ rows: [{ id: 42 }], rowCount: 1 });
        await db.saveChanges();

        expect(provider.lastCall!.sql).toBe(
            'INSERT INTO sqlgen_users (name, age) VALUES ($1, $2) RETURNING id'
        );
        expect(provider.lastCall!.params).toEqual(['Alice', 30]);
        expect(user.id).toBe(42);
    });

    it('uses OUTPUT INSERTED and backfills the id on mssql', async () => {
        const { db, provider } = makeDb('mssql');
        const user = new SgUser();
        user.name = 'Bob';
        user.age = 25;
        db.set(SgUser).add(user);
        provider.nextResult({ rows: [{ id: 7 }], rowCount: 1 });
        await db.saveChanges();

        expect(provider.lastCall!.sql).toBe(
            'INSERT INTO sqlgen_users (name, age) OUTPUT INSERTED.id VALUES (@p0, @p1)'
        );
        expect(user.id).toBe(7);
    });

    it('uses plain INSERT and backfills from insertId on mariadb', async () => {
        const { db, provider } = makeDb('mariadb');
        const user = new SgUser();
        user.name = 'Carol';
        user.age = 40;
        db.set(SgUser).add(user);
        provider.nextResult({ rows: [], rowCount: 1, insertId: 99 });
        await db.saveChanges();

        expect(provider.lastCall!.sql).toBe(
            'INSERT INTO sqlgen_users (name, age) VALUES (?, ?)'
        );
        expect(user.id).toBe(99);
    });

    it('wraps explicit identity inserts in SET IDENTITY_INSERT on mssql', async () => {
        const { db, provider } = makeDb('mssql');
        const user = new SgUser();
        user.id = 5;
        user.name = 'Dave';
        user.age = 50;
        db.set(SgUser).add(user);
        await db.saveChanges();

        expect(provider.lastCall!.sql).toBe(
            'SET IDENTITY_INSERT sqlgen_users ON; ' +
            'INSERT INTO sqlgen_users (id, name, age) VALUES (@p0, @p1, @p2); ' +
            'SET IDENTITY_INSERT sqlgen_users OFF'
        );
        expect(provider.lastCall!.params).toEqual([5, 'Dave', 50]);
    });

    it('uses plain INSERT (no RETURNING) for explicit ids on postgresql', async () => {
        const { db, provider } = makeDb('postgresql');
        const user = new SgUser();
        user.id = 5;
        user.name = 'Eve';
        user.age = 60;
        db.set(SgUser).add(user);
        await db.saveChanges();

        expect(provider.lastCall!.sql).toBe(
            'INSERT INTO sqlgen_users (id, name, age) VALUES ($1, $2, $3)'
        );
    });
});

describe('UPDATE SQL generation with concurrency tokens', () => {
    function trackProduct(db: DbContext): SgProduct {
        const product = new SgProduct();
        product.id = 1;
        product.price = 10;
        product.version = 3;
        db.changeTracker.track(product, EntityState.Unchanged, { id: 1, price: 10, version: 3 });
        return product;
    }

    it('increments the token in SET and checks it in WHERE', async () => {
        const { db, provider } = makeDb('postgresql');
        const product = trackProduct(db);
        product.price = 20;
        await db.saveChanges();

        expect(provider.lastCall!.sql).toBe(
            'UPDATE sqlgen_products SET price = $1, version = $2 WHERE id = $3 AND version = $4'
        );
        expect(provider.lastCall!.params).toEqual([20, 4, 1, 3]);
        expect(product.version).toBe(4);
    });

    it('throws a concurrency violation when no rows are affected', async () => {
        const { db, provider } = makeDb('postgresql');
        const product = trackProduct(db);
        product.price = 20;
        provider.nextResult({ rows: [], rowCount: 0 });

        await expect(db.saveChanges()).rejects.toThrow(/Concurrency violation/);
    });
});

describe('DELETE SQL generation', () => {
    it('deletes by primary key', async () => {
        const { db, provider } = makeDb('postgresql');
        const user = new SgUser();
        user.id = 3;
        user.name = 'Frank';
        user.age = 33;
        db.set(SgUser).remove(user);
        await db.saveChanges();

        expect(provider.lastCall!.sql).toBe('DELETE FROM sqlgen_users WHERE id = $1');
        expect(provider.lastCall!.params).toEqual([3]);
    });
});

describe('SELECT projection SQL generation', () => {
    it('translates simple object-literal projections to column lists', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).select(u => ({ userName: u.name, userAge: u.age })).toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT name AS userName, age AS userAge FROM sqlgen_users'
        );
    });

    it('translates single-property projections', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).select(u => u.age).distinct().toList();

        expect(provider.lastCall!.sql).toBe('SELECT DISTINCT age FROM sqlgen_users');
    });

    it('falls back to SELECT * and in-memory projection for complex selectors', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ id: 1, name: 'Bob', age: 30 }], rowCount: 1 });
        const results = await db.set(SgUser).select(u => ({ label: `${u.name}!` })).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_users');
        expect(results).toEqual([{ label: 'Bob!' }]);
    });
});

describe('GROUP BY SQL generation', () => {
    it('generates GROUP BY with SQL aggregates', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser)
            .groupBy(u => u.age)
            .select(g => ({ count: g.count(), total: g.sum(u => u.age) }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT age, COUNT(*) as count, SUM(age) as total FROM sqlgen_users GROUP BY age'
        );
    });

    it('generates HAVING with parameters', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser)
            .groupBy(u => u.age)
            .having('COUNT(*)', '>', 5)
            .select(g => ({ count: g.count() }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT age, COUNT(*) as count FROM sqlgen_users GROUP BY age HAVING COUNT(*) > $1'
        );
        expect(provider.lastCall!.params).toEqual([5]);
    });

    it('uses LIMIT/OFFSET for grouped pagination on postgresql', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser)
            .groupBy(u => u.age)
            .skip(2).take(3)
            .select(g => ({ count: g.count() }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT age, COUNT(*) as count FROM sqlgen_users GROUP BY age LIMIT 3 OFFSET 2'
        );
    });

    it('uses OFFSET/FETCH for grouped pagination on mssql', async () => {
        const { db, provider } = makeDb('mssql');
        await db.set(SgUser)
            .groupBy(u => u.age)
            .skip(2).take(3)
            .select(g => ({ count: g.count() }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT age, COUNT(*) as count FROM sqlgen_users GROUP BY age' +
            ' ORDER BY (SELECT NULL) OFFSET 2 ROWS FETCH NEXT 3 ROWS ONLY'
        );
    });

    it('generates AVG SQL for g.average()', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser)
            .groupBy(u => u.age)
            .select(g => ({ avgAge: g.average(u => u.age) }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT age, AVG(age) as avgAge FROM sqlgen_users GROUP BY age'
        );
    });

    it('generates MIN SQL for g.min()', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser)
            .groupBy(u => u.age)
            .select(g => ({ minAge: g.min(u => u.age) }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT age, MIN(age) as minAge FROM sqlgen_users GROUP BY age'
        );
    });

    it('generates MAX SQL for g.max()', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser)
            .groupBy(u => u.age)
            .select(g => ({ maxAge: g.max(u => u.age) }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT age, MAX(age) as maxAge FROM sqlgen_users GROUP BY age'
        );
    });
});

describe('projection SQL from captured selectors (renamed columns and error paths)', () => {
    it('uses the mapped column name, not the property name, for a renamed column', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgAccount).select(a => ({ n: a.fullName })).toList();
        expect(provider.lastCall!.sql).toBe('SELECT full_name AS n FROM sqlgen_accounts');
    });

    it('uses the mapped column name for a renamed column in a single-property projection', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgAccount).select(a => a.fullName).toList();
        expect(provider.lastCall!.sql).toBe('SELECT full_name FROM sqlgen_accounts');
    });

    it('throws when a projected property is not a mapped column', async () => {
        const { db } = makeDb('postgresql');
        await expect(db.set(SgUser).select((u: any) => ({ x: u.nope })).toList())
            .rejects.toThrow(/nope/);
    });

    it('falls back to SELECT * and projects in memory for a selector property capture cannot express', async () => {
        // A different opaque shape than the template-literal case already covered
        // above ("falls back to SELECT * and in-memory projection for complex
        // selectors") - this proves the fallback is general, not special-cased to
        // one kind of computed expression.
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ id: 1, name: 'Ada', age: 15 }], rowCount: 1 });
        const results = await db.set(SgUser).select(u => u.age * 2).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_users');
        expect(results).toEqual([30]);
    });
});

describe('GROUP BY SQL generation with renamed columns', () => {
    it('groups and aggregates by their mapped column names, not property names', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgAccount)
            .groupBy(a => a.fullName)
            .select(g => ({ total: g.sum(a => a.balance) }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT full_name, SUM(acct_balance) as total FROM sqlgen_accounts GROUP BY full_name'
        );
    });

    it('aliases the group key via g.key, distinguishing column from alias', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgAccount)
            .groupBy(a => a.fullName)
            .select(g => ({ dept: g.key, total: g.sum(a => a.balance) }))
            .toList();

        expect(provider.lastCall!.sql).toBe(
            'SELECT full_name AS dept, SUM(acct_balance) as total FROM sqlgen_accounts GROUP BY full_name'
        );
    });
});

/**
 * IN / NOT IN / IS / IS NOT (I4). The hazard these tests exist for is
 * placeholder numbering: every call site used to assume "one condition
 * consumes exactly one parameter". Hand-traced expectations (postgres):
 *
 *   where('status','IN',['a','b','c'])  params 0 -> next index 1 -> $1,$2,$3
 *   .where('title','=','x')             params 3 -> next index 4 -> $4
 *   where('deletedAt','IS',null)        params 0 -> next index 1 -> (none)
 *   .where('title','=','x')             params 0 -> next index 1 -> $1
 *
 * mssql renders index i as @p(i-1); mariadb renders every index as '?'.
 */
describe('set and null operators (I4)', () => {
    it.each([
        ['postgresql', 'SELECT * FROM sqlgen_docs WHERE status IN ($1, $2, $3)'],
        ['mssql', 'SELECT * FROM sqlgen_docs WHERE status IN (@p0, @p1, @p2)'],
        ['mariadb', 'SELECT * FROM sqlgen_docs WHERE status IN (?, ?, ?)'],
    ])('expands IN to one placeholder per element (%s)', async (dialect, expected) => {
        const { db, provider } = makeDb(dialect as CaptureDialect);
        await db.set(SgDoc).where('status', 'IN', ['a', 'b', 'c']).toList();

        expect(provider.lastCall!.sql).toBe(expected);
        expect(provider.lastCall!.params).toEqual(['a', 'b', 'c']);
    });

    it.each([
        ['postgresql', 'SELECT * FROM sqlgen_docs WHERE status IN ($1, $2, $3) AND title = $4'],
        ['mssql', 'SELECT * FROM sqlgen_docs WHERE status IN (@p0, @p1, @p2) AND title = @p3'],
        ['mariadb', 'SELECT * FROM sqlgen_docs WHERE status IN (?, ?, ?) AND title = ?'],
    ])('continues placeholder numbering after an IN (%s)', async (dialect, expected) => {
        const { db, provider } = makeDb(dialect as CaptureDialect);
        await db.set(SgDoc).where('status', 'IN', ['a', 'b', 'c']).where('title', '=', 'x').toList();

        expect(provider.lastCall!.sql).toBe(expected);
        expect(provider.lastCall!.params).toEqual(['a', 'b', 'c', 'x']);
    });

    it('expands NOT IN the same way', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgDoc).where('status', 'NOT IN', ['a', 'b']).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_docs WHERE status NOT IN ($1, $2)');
        expect(provider.lastCall!.params).toEqual(['a', 'b']);
    });

    it.each([
        ['postgresql', 'SELECT * FROM sqlgen_docs WHERE deletedat IS NULL'],
        ['mssql', 'SELECT * FROM sqlgen_docs WHERE deletedat IS NULL'],
        ['mariadb', 'SELECT * FROM sqlgen_docs WHERE deletedat IS NULL'],
    ])('emits IS NULL with no parameter (%s)', async (dialect, expected) => {
        const { db, provider } = makeDb(dialect as CaptureDialect);
        await db.set(SgDoc).where('deletedAt', 'IS', null).toList();

        expect(provider.lastCall!.sql).toBe(expected);
        expect(provider.lastCall!.params).toEqual([]);
    });

    it('emits IS NOT NULL with no parameter', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgDoc).where('deletedAt', 'IS NOT', null).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_docs WHERE deletedat IS NOT NULL');
        expect(provider.lastCall!.params).toEqual([]);
    });

    it('numbers the next condition from index 1 after an IS NULL (consumes no placeholder)', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgDoc).where('deletedAt', 'IS', null).where('title', '=', 'x').toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_docs WHERE deletedat IS NULL AND title = $1');
        expect(provider.lastCall!.params).toEqual(['x']);
    });

    it('compiles an empty IN to 1 = 0 and keeps the following placeholder at $1', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgDoc).where('status', 'IN', []).where('title', '=', 'x').toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_docs WHERE 1 = 0 AND title = $1');
        expect(provider.lastCall!.params).toEqual(['x']);
    });

    it('compiles an empty NOT IN to 1 = 1', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgDoc).where('status', 'NOT IN', []).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_docs WHERE 1 = 1');
    });

    it('throws when IN receives a non-array value', () => {
        const { db, provider } = makeDb('postgresql');
        expect(() => db.set(SgDoc).where('status', 'IN', 'a')).toThrow(/array/);
        expect(provider.calls).toHaveLength(0);
    });

    it('throws when IS receives a non-null value', () => {
        const { db, provider } = makeDb('postgresql');
        expect(() => db.set(SgDoc).where('deletedAt', 'IS', 5)).toThrow(/'='/);
        expect(provider.calls).toHaveLength(0);
    });

    it('supports the set operators through select() projections too', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgDoc).select(d => d.title).where('status', 'IN', ['a', 'b']).where('title', '=', 'x').toList();

        expect(provider.lastCall!.sql).toBe('SELECT title FROM sqlgen_docs WHERE status IN ($1, $2) AND title = $3');
        expect(provider.lastCall!.params).toEqual(['a', 'b', 'x']);
    });
});

describe('short-circuit selectors fall back to in-memory projection (I2)', () => {
    it.each([
        ['||', (d: SgDoc) => d.title || d.status],
        ['??', (d: SgDoc) => d.title ?? d.status],
    ])('falls back to SELECT * for a %s selector and applies it in JS', async (_label, selector) => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ id: 1, status: 'live', title: '', deletedat: null }], rowCount: 1 });
        const results = await db.set(SgDoc).select(selector).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_docs');
        // '' is falsy, so `||` yields 'live' — and `??` yields '' (only nullish
        // falls through). Asserting both proves the selector ran in JS with real
        // values rather than being resolved to a single column at capture time.
        expect(results).toEqual([_label === '||' ? 'live' : '']);
    });

    it('falls back for a projection entry that short-circuits', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [{ id: 1, status: 'live', title: '', deletedat: null }], rowCount: 1 });
        const results = await db.set(SgDoc).select(d => ({ label: d.title || d.status, s: d.status })).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_docs');
        expect(results).toEqual([{ label: 'live', s: 'live' }]);
    });

    it('throws with the accurate message for a short-circuit aggregate selector', async () => {
        const { db } = makeDb('postgresql');
        await expect(
            db.set(SgDoc).groupBy(d => d.status).select(g => ({ n: g.sum((d: any) => d.id || d.title) })).toList()
        ).rejects.toThrow(/g\.sum/);
    });

    it('still uses SQL projection for an honest multi-column projection', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgDoc).select(d => ({ a: d.title, b: d.status })).toList();

        expect(provider.lastCall!.sql).toBe('SELECT title AS a, status AS b FROM sqlgen_docs');
    });
});

describe('grouped aggregates require a column selector', () => {
    it('throws instead of emitting SUM(undefined) when sum() is called with no selector', async () => {
        const { db, provider } = makeDb('postgresql');
        await expect(
            db.set(SgUser).groupBy(u => u.age).select(g => ({ total: (g as any).sum() })).toList()
        ).rejects.toThrow(/sum/);
        expect(provider.calls).toHaveLength(0);
    });

    it('still allows count() with no selector', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).groupBy(u => u.age).select(g => ({ n: g.count() })).toList();

        expect(provider.lastCall!.sql).toBe('SELECT age, COUNT(*) as n FROM sqlgen_users GROUP BY age');
    });
});

describe('Raw SQL passthrough', () => {
    it('passes fromSqlRaw SQL and params through verbatim', async () => {
        const { db, provider } = makeDb('postgresql');
        await db.set(SgUser).fromSqlRaw('SELECT * FROM sqlgen_users WHERE age > $1', [18]).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM sqlgen_users WHERE age > $1');
        expect(provider.lastCall!.params).toEqual([18]);
    });

    it('executeSqlRaw returns the affected row count', async () => {
        const { db, provider } = makeDb('postgresql');
        provider.nextResult({ rows: [], rowCount: 5 });
        const affected = await db.executeSqlRaw('UPDATE sqlgen_users SET age = $1', [1]);

        expect(provider.lastCall!.sql).toBe('UPDATE sqlgen_users SET age = $1');
        expect(affected).toBe(5);
    });
});
