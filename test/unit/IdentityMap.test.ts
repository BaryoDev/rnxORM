import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

/**
 * GitHub issue #5: loading the same row twice must yield the SAME tracked
 * entity instance instead of two conflicting ones (an identity map).
 *
 * These tests exercise the identity map through the public API: repeated
 * find()/toList() calls for the same primary key must return object-identical
 * instances, local unsaved modifications must survive a re-query, and
 * asNoTracking()/clear()/remove()+saveChanges() must NOT be identity-mapped
 * (or must correctly evict).
 */

@Entity('im_users')
class ImUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

function makeDb(dialect: CaptureDialect = 'postgresql'): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider(dialect);
    const db = new DbContext(provider);
    return { db, provider };
}

describe('Identity Map (issue #5)', () => {
    it('find(1) twice returns the same tracked instance', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const first = await db.set(ImUser).find(1);

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const second = await db.set(ImUser).find(1);

        expect(first).not.toBeNull();
        expect(second).toBe(first);
        expect(db.changeTracker.getStatistics().total).toBe(1);
    });

    it('where().toList() then find() on the same pk returns the same instance', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const [fromWhere] = await db.set(ImUser).where('id', '=', 1).toList();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const fromFind = await db.set(ImUser).find(1);

        expect(fromFind).toBe(fromWhere);
        expect(db.changeTracker.getStatistics().total).toBe(1);
    });

    it('a local modification survives a re-query: same instance, modification not clobbered', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const first = await db.set(ImUser).find(1);
        first!.name = 'Modified Locally';

        // Re-query returns fresh (unmodified) DB values for the same row.
        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const second = await db.set(ImUser).find(1);

        expect(second).toBe(first);
        // EF Core semantics: tracked instance's current values win over fresh
        // database values - the local edit must NOT be clobbered.
        expect(second!.name).toBe('Modified Locally');
        expect(db.changeTracker.getStatistics().total).toBe(1);
    });

    it('re-querying after remove() + saveChanges() yields a NEW instance', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const first = await db.set(ImUser).find(1);

        db.set(ImUser).remove(first!);
        await db.saveChanges();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const second = await db.set(ImUser).find(1);

        expect(second).not.toBe(first);
    });

    it('changeTracker.clear() causes the next load to be a new instance', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const first = await db.set(ImUser).find(1);

        db.changeTracker.clear();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const second = await db.set(ImUser).find(1);

        expect(second).not.toBe(first);
    });

    it('asNoTracking() results are never identity-mapped: two loads give two instances', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const [a] = await db.set(ImUser).asNoTracking().toList();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const [b] = await db.set(ImUser).asNoTracking().toList();

        expect(a).not.toBe(b);
        expect(db.changeTracker.getStatistics().total).toBe(0);
    });

    it('asNoTracking() loads do not pollute the identity map for later tracked loads', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const [untracked] = await db.set(ImUser).asNoTracking().toList();

        provider.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const tracked = await db.set(ImUser).find(1);

        expect(tracked).not.toBe(untracked);
        expect(db.changeTracker.isTracked(tracked!)).toBe(true);
    });

    it('two separate DbContext instances have independent identity maps', async () => {
        const { db: db1, provider: p1 } = makeDb();
        const { db: db2, provider: p2 } = makeDb();

        p1.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const fromDb1 = await db1.set(ImUser).find(1);

        p2.nextResult({ rows: [{ id: 1, name: 'Alice' }], rowCount: 1 });
        const fromDb2 = await db2.set(ImUser).find(1);

        expect(fromDb1).not.toBe(fromDb2);
    });

    it('insert with a generated id then find(newId) returns the same instance that was added', async () => {
        const { db, provider } = makeDb('postgresql');

        const newUser = new ImUser();
        newUser.name = 'Zoe';
        db.set(ImUser).add(newUser);

        // RETURNING id result for the INSERT statement
        provider.nextResult({ rows: [{ id: 42 }], rowCount: 1 });
        await db.saveChanges();

        expect(newUser.id).toBe(42);

        provider.nextResult({ rows: [{ id: 42, name: 'Zoe' }], rowCount: 1 });
        const found = await db.set(ImUser).find(42);

        expect(found).toBe(newUser);
    });
});
