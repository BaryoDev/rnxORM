import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { EntityState } from '../../src/core/EntityEntry';
import { Entity, PrimaryKey, Column, OneToMany, ManyToOne } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

/**
 * Change detection compared with `!==` over a shallow `{ ...entity }`
 * snapshot, which is wrong in both directions: equal Dates are different
 * references (spurious UPDATE), and nested objects are shared by reference
 * with the entity so edits to them are invisible (lost write). Navigation
 * properties were compared too, so include() made every loaded root look
 * modified (issues #40 / #34).
 */

@Entity('cd_users')
class CdUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    lastSeen!: Date;

    @Column()
    config!: { theme: string };

    @Column()
    tags!: string[];

    @Column()
    version!: number;

    @OneToMany(() => CdPost, (p: CdPost) => p.author)
    posts!: CdPost[];
}

@Entity('cd_posts')
class CdPost {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @ManyToOne(() => CdUser, (u: CdUser) => u.posts)
    author!: CdUser;
}

/**
 * A category under a category: the dependent and the principal are the same
 * type, which is the shape type-level dependency ordering cannot see.
 */
@Entity('cd_categories')
class CdCategory {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @ManyToOne(() => CdCategory, (c: CdCategory) => c.children)
    parent!: CdCategory;

    @OneToMany(() => CdCategory, (c: CdCategory) => c.parent)
    children!: CdCategory[];
}

beforeAll(() => {
    new ModelBuilder().entity(CdUser).property(u => u.version).isConcurrencyToken();
});

function makeDb() {
    const provider = new SqlCaptureProvider('postgresql');
    return { db: new DbContext(provider), provider };
}

function loadUser(provider: SqlCaptureProvider, overrides: Record<string, any> = {}) {
    provider.nextResult({
        rows: [{
            id: 1,
            name: 'Ada',
            lastseen: new Date('2020-01-01T00:00:00Z'),
            config: { theme: 'dark' },
            tags: ['a'],
            version: 1,
            ...overrides,
        }],
        rowCount: 1,
    });
}

describe('change detection by value (#40)', () => {
    it('does not write an unchanged entity whose Date was reassigned an equal instant', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];

        user.lastSeen = new Date('2020-01-01T00:00:00Z');

        const saved = await db.saveChanges();

        expect(saved).toBe(0);
        expect(provider.calls.filter(c => c.sql.startsWith('UPDATE'))).toHaveLength(0);
    });

    it('still writes when the Date actually changes', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];

        user.lastSeen = new Date('2021-06-01T00:00:00Z');
        provider.nextResult({ rows: [], rowCount: 1 });

        const saved = await db.saveChanges();

        expect(saved).toBe(1);
        const update = provider.calls.find(c => c.sql.startsWith('UPDATE'))!;
        expect(update.sql).toContain('lastseen =');
    });

    it('detects an edit to a nested object', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];

        user.config.theme = 'light';
        provider.nextResult({ rows: [], rowCount: 1 });

        const saved = await db.saveChanges();

        expect(saved).toBe(1);
        const update = provider.calls.find(c => c.sql.startsWith('UPDATE'))!;
        expect(update.sql).toContain('config =');
        expect(update.params![0]).toEqual({ theme: 'light' });
    });

    it('detects a push onto an array column', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];

        user.tags.push('b');
        provider.nextResult({ rows: [], rowCount: 1 });

        const saved = await db.saveChanges();

        expect(saved).toBe(1);
        const update = provider.calls.find(c => c.sql.startsWith('UPDATE'))!;
        expect(update.sql).toContain('tags =');
        expect(update.params![0]).toEqual(['a', 'b']);
    });

    it('leaves an untouched entity alone', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        await db.set(CdUser).toList();

        const saved = await db.saveChanges();

        expect(saved).toBe(0);
        expect(provider.calls.filter(c => c.sql.startsWith('UPDATE'))).toHaveLength(0);
    });

    it('still detects an ordinary scalar edit', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];

        user.name = 'Grace';
        provider.nextResult({ rows: [], rowCount: 1 });

        expect(await db.saveChanges()).toBe(1);
    });
});

describe('include() does not dirty the roots (#34)', () => {
    it('emits no UPDATE after a read with include()', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(CdUser).include(u => u.posts).toList();
        const saved = await db.saveChanges();

        expect(saved).toBe(0);
        expect(provider.calls.filter(c => c.sql.startsWith('UPDATE'))).toHaveLength(0);
    });

    it('does not bump the concurrency token on a read', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        provider.nextResult({ rows: [{ id: 9, title: 'p', authorid: 1 }], rowCount: 1 });

        const users = await db.set(CdUser).include(u => u.posts).toList();
        await db.saveChanges();

        expect(users[0].version).toBe(1);
    });

    it('leaves the entity Unchanged after an include', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        provider.nextResult({ rows: [], rowCount: 0 });

        const users = await db.set(CdUser).include(u => u.posts).toList();
        db.changeTracker.detectChanges();

        expect(db.changeTracker.entry(users[0])!.state).toBe(EntityState.Unchanged);
    });

    it('still detects a real edit made after an include', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        provider.nextResult({ rows: [], rowCount: 0 });

        const users = await db.set(CdUser).include(u => u.posts).toList();
        users[0].name = 'Grace';
        provider.nextResult({ rows: [], rowCount: 1 });

        expect(await db.saveChanges()).toBe(1);
    });
});

describe('update() on a detached entity (#33)', () => {
    /**
     * The disconnected-update pattern: an entity arrives off the wire, is
     * marked Modified, and saved. track() snapshotted `{ ...entity }`, so
     * original equalled current, getModifiedProperties() was empty and
     * updateEntity() returned before emitting SQL, while saveChanges() had
     * already counted the entry as saved.
     */
    it('emits an UPDATE writing every non-key column', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 1 });

        const user = new CdUser();
        user.id = 1;
        user.name = 'renamed';
        user.lastSeen = new Date('2022-03-04T00:00:00Z');
        user.config = { theme: 'dark' };
        user.tags = ['x'];
        user.version = 3;

        db.set(CdUser).update(user);
        const saved = await db.saveChanges();

        expect(saved).toBe(1);
        const update = provider.calls.find(c => c.sql.startsWith('UPDATE'))!;
        expect(update).toBeDefined();
        expect(update.sql).toContain('name =');
        expect(update.sql).toContain('config =');
        expect(update.sql).toContain('tags =');
        expect(update.sql).toContain('WHERE id =');
    });

    it('does not write the primary key into the SET clause', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 1 });

        const user = new CdUser();
        user.id = 1;
        user.name = 'renamed';
        db.set(CdUser).update(user);
        await db.saveChanges();

        const update = provider.calls.find(c => c.sql.startsWith('UPDATE'))!;
        const setPart = update.sql.slice(0, update.sql.indexOf(' WHERE '));
        expect(setPart).not.toContain('id =');
    });

    it('attach(entity, Modified) behaves the same way', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 1 });

        const user = new CdUser();
        user.id = 2;
        user.name = 'attached';
        db.attach(user, EntityState.Modified);

        expect(await db.saveChanges()).toBe(1);
        expect(provider.calls.some(c => c.sql.startsWith('UPDATE'))).toBe(true);
    });

    it('saveChanges() counts statements executed, not entries considered', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        await db.set(CdUser).toList();

        // Nothing edited: no statement, so nothing counted.
        expect(await db.saveChanges()).toBe(0);
    });
});

describe('delete concurrency and token handling (#41)', () => {
    it('includes the concurrency token in the DELETE WHERE clause', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];

        db.set(CdUser).remove(user);
        provider.nextResult({ rows: [], rowCount: 1 });
        await db.saveChanges();

        const del = provider.calls.find(c => c.sql.startsWith('DELETE'))!;
        expect(del.sql).toBe('DELETE FROM cd_users WHERE id = $1 AND version = $2');
        expect(del.params).toEqual([1, 1]);
    });

    it('throws when the DELETE affects no rows', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];

        db.set(CdUser).remove(user);
        provider.nextResult({ rows: [], rowCount: 0 });

        await expect(db.saveChanges()).rejects.toThrow(/Concurrency violation/);
    });

    it('does not bump the token on the entity until the statement succeeds', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];
        user.name = 'Grace';

        provider.nextResult({ rows: [], rowCount: 0 });   // lost the race

        await expect(db.saveChanges()).rejects.toThrow(/Concurrency violation/);
        // A failed write must leave the entity on its original version, or a
        // retry sends the wrong expected value.
        expect(user.version).toBe(1);
    });

    it('bumps the token after a successful update', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];
        user.name = 'Grace';

        provider.nextResult({ rows: [], rowCount: 1 });
        await db.saveChanges();

        expect(user.version).toBe(2);
    });

    it('rejects a non-numeric token instead of writing 1 into it', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Ada', lastseen: null, config: null, tags: null, version: '2024-01-01T00:00:00Z' }],
            rowCount: 1,
        });
        const user = (await db.set(CdUser).toList())[0];
        (user as any).name = 'Grace';

        await expect(db.saveChanges()).rejects.toThrow(/concurrency token/i);
    });
});

describe('save ordering and key propagation (#36)', () => {
    /**
     * saveChanges() wrote entries in Map insertion order, so a dependent added
     * before its principal hit the FK constraint. And setting a navigation
     * (`post.author = user`) never filled `post.authorid`, so even in the right
     * order the INSERT bound undefined into a NOT NULL column.
     */
    it('inserts the principal before the dependent regardless of add order', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 7 }], rowCount: 1 });   // user insert
        provider.nextResult({ rows: [{ id: 3 }], rowCount: 1 });   // post insert

        const user = new CdUser();
        user.name = 'Ada';
        const post = new CdPost();
        post.title = 'hello';
        post.author = user;

        db.set(CdPost).add(post);    // dependent added first
        db.set(CdUser).add(user);    // principal second

        await db.saveChanges();

        const tables = provider.calls
            .filter(c => c.sql.startsWith('INSERT'))
            .map(c => c.sql.match(/INSERT INTO (\w+)/)![1]);
        expect(tables).toEqual(['cd_users', 'cd_posts']);
    });

    it('propagates the generated key to the dependent foreign key', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 7 }], rowCount: 1 });
        provider.nextResult({ rows: [{ id: 3 }], rowCount: 1 });

        const user = new CdUser();
        user.name = 'Ada';
        const post = new CdPost();
        post.title = 'hello';
        post.author = user;

        db.set(CdUser).add(user);
        db.set(CdPost).add(post);

        await db.saveChanges();

        expect(user.id).toBe(7);
        expect((post as any).authorid).toBe(7);

        const postInsert = provider.calls.find(c => c.sql.includes('INSERT INTO cd_posts'))!;
        expect(postInsert.sql).toContain('authorid');
        expect(postInsert.params).toContain(7);
    });

    it('deletes the dependent before the principal', async () => {
        const { db, provider } = makeDb();
        loadUser(provider);
        const user = (await db.set(CdUser).toList())[0];

        provider.nextResult({ rows: [{ id: 3, title: 'p', authorid: 1 }], rowCount: 1 });
        const post = (await db.set(CdPost).toList())[0];

        db.set(CdUser).remove(user);   // principal removed first
        db.set(CdPost).remove(post);

        provider.nextResult({ rows: [], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 1 });
        await db.saveChanges();

        const tables = provider.calls
            .filter(c => c.sql.startsWith('DELETE'))
            .map(c => c.sql.match(/DELETE FROM (\w+)/)![1]);
        expect(tables).toEqual(['cd_posts', 'cd_users']);
    });

    it('does not disturb an explicitly set foreign key', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 3 }], rowCount: 1 });

        const post = new CdPost();
        post.title = 'hello';
        (post as any).authorid = 42;

        db.set(CdPost).add(post);
        await db.saveChanges();

        const insert = provider.calls.find(c => c.sql.includes('INSERT INTO cd_posts'))!;
        expect(insert.params).toContain(42);
    });

    /**
     * The dependency graph was keyed by constructor and skipped an edge when
     * `related === type`, so every instance of one type was emitted together in
     * tracking order. A child added before its new parent therefore inserted
     * first, binding a parent id that did not exist yet, and propagateGeneratedKey
     * runs after the insert so it cannot repair the row.
     */
    it('inserts a self-referencing parent before its child regardless of add order', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 10 }], rowCount: 1 });   // parent insert
        provider.nextResult({ rows: [{ id: 11 }], rowCount: 1 });   // child insert

        const parent = new CdCategory();
        parent.name = 'root';
        const child = new CdCategory();
        child.name = 'leaf';
        child.parent = parent;

        db.set(CdCategory).add(child);    // dependent added first
        db.set(CdCategory).add(parent);   // principal second

        await db.saveChanges();

        const names = provider.calls
            .filter(c => c.sql.startsWith('INSERT'))
            .map(c => c.params![0]);
        expect(names).toEqual(['root', 'leaf']);
    });

    it('deletes a self-referencing child before its parent', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 10 }], rowCount: 1 });
        provider.nextResult({ rows: [{ id: 11 }], rowCount: 1 });

        const parent = new CdCategory();
        parent.name = 'root';
        const child = new CdCategory();
        child.name = 'leaf';
        child.parent = parent;

        db.set(CdCategory).add(parent);
        db.set(CdCategory).add(child);
        await db.saveChanges();

        provider.calls.length = 0;
        provider.nextResult({ rows: [], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 1 });

        // Parent removed first, so the reversal has something to get wrong.
        db.set(CdCategory).remove(parent);
        db.set(CdCategory).remove(child);
        await db.saveChanges();

        const ids = provider.calls
            .filter(c => c.sql.startsWith('DELETE'))
            .map(c => c.params![0]);
        expect(ids).toEqual([11, 10]);
    });

    it('propagates a self-referencing generated key onto the child', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 10 }], rowCount: 1 });
        provider.nextResult({ rows: [{ id: 11 }], rowCount: 1 });

        const parent = new CdCategory();
        parent.name = 'root';
        const child = new CdCategory();
        child.name = 'leaf';
        child.parent = parent;

        db.set(CdCategory).add(child);
        db.set(CdCategory).add(parent);

        await db.saveChanges();

        expect(parent.id).toBe(10);
        expect((child as any).parentid).toBe(10);
    });

    it('leaves a single independent insert alone', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1 }], rowCount: 1 });

        const user = new CdUser();
        user.name = 'Solo';
        db.set(CdUser).add(user);

        expect(await db.saveChanges()).toBe(1);
    });
});
