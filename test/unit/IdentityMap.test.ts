import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { EntityState } from '../../src/core/EntityEntry';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column, ManyToOne, OneToMany } from '../../src/decorators';
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

@Entity('im_authors')
class ImAuthor {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @OneToMany(() => ImBook, (b: ImBook) => b.author)
    books!: ImBook[];
}

@Entity('im_books')
class ImBook {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @ManyToOne(() => ImAuthor, (a: ImAuthor) => a.books)
    author!: ImAuthor;
}

// Primary key stored as an integer but exposed on the entity as a string, so
// the identity map key must go through convertFromDb on every path that
// registers one (row mapping AND insert backfill) or the two paths key
// differently and the map silently misses.
@Entity('im_codes')
class ImCode {
    @PrimaryKey()
    id!: string;

    @Column()
    label!: string;
}

beforeAll(() => {
    const pk = MetadataStorage.get().getEntity(ImCode)!.columns.find(c => c.isPrimaryKey)!;
    pk.hasConversion = true;
    pk.convertToDb = (v: any) => (v === null || v === undefined ? v : parseInt(v, 10));
    pk.convertFromDb = (v: any) => (v === null || v === undefined ? v : String(v));
    pk.isAutoIncrement = true;
});

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

    it('eager-loaded related entities join the identity map (I3)', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 10, name: 'Ann' }], rowCount: 1 });
        const author = await db.set(ImAuthor).find(10);
        author!.name = 'Renamed locally';

        provider.nextResult({ rows: [{ id: 1, title: 'First', authorid: 10 }], rowCount: 1 });
        provider.nextResult({ rows: [{ id: 10, name: 'Ann' }], rowCount: 1 });
        const books = await db.set(ImBook).include(b => b.author).toList();

        expect(books[0].author).toBe(author);
        expect(books[0].author.name).toBe('Renamed locally');
        expect(db.changeTracker.isTracked(books[0].author)).toBe(true);
    });

    it('eager-loaded one-to-many children are tracked and identity-mapped (I3)', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, title: 'First', authorid: 10 }], rowCount: 1 });
        const book = await db.set(ImBook).find(1);

        provider.nextResult({ rows: [{ id: 10, name: 'Ann' }], rowCount: 1 });
        provider.nextResult({ rows: [{ id: 1, title: 'First', authorid: 10 }], rowCount: 1 });
        const authors = await db.set(ImAuthor).include(a => a.books).toList();

        expect(authors[0].books[0]).toBe(book);
        expect(db.changeTracker.isTracked(authors[0].books[0])).toBe(true);
    });

    it('asNoTracking().include() leaves related entities untracked (I3)', async () => {
        const { db, provider } = makeDb();

        provider.nextResult({ rows: [{ id: 1, title: 'First', authorid: 10 }], rowCount: 1 });
        provider.nextResult({ rows: [{ id: 10, name: 'Ann' }], rowCount: 1 });
        const books = await db.set(ImBook).asNoTracking().include(b => b.author).toList();

        expect(books[0].author.name).toBe('Ann');
        expect(db.changeTracker.isTracked(books[0].author)).toBe(false);
        expect(db.changeTracker.getStatistics().total).toBe(0);
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

/**
 * Entities that enter tracking with a primary key already set. Attach(),
 * update(), add() with an explicit id. Must be identity-mapped too, or a
 * later find() of the same key mints a second tracked instance (issue #5
 * through a third door).
 */
describe('Identity Map. Entities tracked without a round trip', () => {
    it('attach() then find(samePk) returns the attached instance', async () => {
        const { db, provider } = makeDb();

        const attached = new ImUser();
        attached.id = 7;
        attached.name = 'Ann';
        db.attach(attached);

        provider.nextResult({ rows: [{ id: 7, name: 'Ann (stale)' }], rowCount: 1 });
        const found = await db.set(ImUser).find(7);

        expect(found).toBe(attached);
        expect(found!.name).toBe('Ann');
    });

    it('update() with a known pk then find(samePk) returns the same instance', async () => {
        const { db, provider } = makeDb();

        const edited = new ImUser();
        edited.id = 8;
        edited.name = 'Bea';
        db.set(ImUser).update(edited);

        provider.nextResult({ rows: [{ id: 8, name: 'Bea' }], rowCount: 1 });
        const found = await db.set(ImUser).find(8);

        expect(found).toBe(edited);
    });

    it('add() with an explicit pk then find(samePk) returns the same instance', async () => {
        const { db, provider } = makeDb();

        const created = new ImUser();
        created.id = 9;
        created.name = 'Cy';
        db.set(ImUser).add(created);

        provider.nextResult({ rows: [{ id: 9, name: 'Cy' }], rowCount: 1 });
        const found = await db.set(ImUser).find(9);

        expect(found).toBe(created);
    });

    it('a Detached entry() is not identity-mapped', async () => {
        const { db, provider } = makeDb();

        const detached = new ImUser();
        detached.id = 11;
        db.entry(detached);

        provider.nextResult({ rows: [{ id: 11, name: 'Dee' }], rowCount: 1 });
        const found = await db.set(ImUser).find(11);

        expect(found).not.toBe(detached);
    });

    it('an entity with no pk value yet is not registered under undefined', async () => {
        const { db, provider } = makeDb();

        const blank = new ImUser();
        blank.name = 'No id yet';
        db.set(ImUser).add(blank);

        provider.nextResult({ rows: [{ id: 1, name: 'Real' }], rowCount: 1 });
        const found = await db.set(ImUser).find(1);

        expect(found).not.toBe(blank);
    });
});

describe('Identity Map. Value-converted primary keys', () => {
    it('insert backfill and row mapping key the identity map identically', async () => {
        const { db, provider } = makeDb('postgresql');

        const code = new ImCode();
        code.label = 'alpha';
        db.set(ImCode).add(code);

        // RETURNING id yields the raw database integer.
        provider.nextResult({ rows: [{ id: 42 }], rowCount: 1 });
        await db.saveChanges();

        // The entity-side value goes through convertFromDb, exactly as a row
        // mapping would produce it.
        expect(code.id).toBe('42');

        provider.nextResult({ rows: [{ id: 42, label: 'alpha' }], rowCount: 1 });
        const found = await db.set(ImCode).find('42');

        expect(found).toBe(code);
    });
});
