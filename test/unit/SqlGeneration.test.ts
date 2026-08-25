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
