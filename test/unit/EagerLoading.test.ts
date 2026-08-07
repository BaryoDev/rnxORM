import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column, ManyToOne, OneToMany, OneToOne, ManyToMany } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

@Entity('el_authors')
class ElAuthor {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @OneToMany(() => ElPost, (p: ElPost) => p.author)
    posts!: ElPost[];
}

@Entity('el_posts')
class ElPost {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @ManyToOne(() => ElAuthor, (a: ElAuthor) => a.posts)
    author!: ElAuthor;
}

@Entity('el_profiles')
class ElProfile {
    @PrimaryKey()
    id!: number;

    @Column()
    bio!: string;
}

@Entity('el_users')
class ElUser {
    @PrimaryKey()
    id!: number;

    @Column()
    email!: string;

    @OneToOne(() => ElProfile)
    profile!: ElProfile;
}

@Entity('el_courses')
class ElCourse {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;
}

// Note: the related class must be declared before @ManyToMany is applied,
// because the decorator derives the default join table name eagerly.
@Entity('el_students')
class ElStudent {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @ManyToMany(() => ElCourse)
    courses!: ElCourse[];
}

function makeDb(): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider('postgresql');
    const db = new DbContext(provider);
    return { db, provider };
}

describe('eager loading with include()', () => {
    it('loads a many-to-one relation with a batched IN query and stitches entities', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, title: 'First', authorid: 10 },
                { id: 2, title: 'Second', authorid: 10 },
                { id: 3, title: 'Orphan', authorid: null },
            ],
            rowCount: 3,
        });
        provider.nextResult({ rows: [{ id: 10, name: 'Ann' }], rowCount: 1 });

        const posts = await db.set(ElPost).include(p => p.author).toList();

        expect(provider.calls[0].sql).toBe('SELECT * FROM el_posts');
        expect(provider.calls[1].sql).toBe('SELECT * FROM el_authors WHERE id IN ($1)');
        expect(provider.calls[1].params).toEqual([10]);

        expect(posts[0].author.name).toBe('Ann');
        expect(posts[1].author.name).toBe('Ann');
        expect(posts[2].author).toBeUndefined();
    });

    it('deduplicates foreign keys in the batched query', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, title: 'A', authorid: 10 },
                { id: 2, title: 'B', authorid: 11 },
                { id: 3, title: 'C', authorid: 10 },
            ],
            rowCount: 3,
        });
        provider.nextResult({
            rows: [
                { id: 10, name: 'Ann' },
                { id: 11, name: 'Bob' },
            ],
            rowCount: 2,
        });

        await db.set(ElPost).include(p => p.author).toList();

        expect(provider.calls[1].sql).toBe('SELECT * FROM el_authors WHERE id IN ($1, $2)');
        expect(provider.calls[1].params).toEqual([10, 11]);
    });

    it('loads a one-to-many collection grouped by foreign key', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 10, name: 'Ann' },
                { id: 11, name: 'Bob' },
            ],
            rowCount: 2,
        });
        provider.nextResult({
            rows: [
                { id: 1, title: 'First', authorid: 10 },
                { id: 2, title: 'Second', authorid: 10 },
            ],
            rowCount: 2,
        });

        const authors = await db.set(ElAuthor).include(a => a.posts).toList();

        expect(provider.calls[1].sql).toBe('SELECT * FROM el_posts WHERE authorid IN ($1, $2)');
        expect(provider.calls[1].params).toEqual([10, 11]);

        expect(authors[0].posts).toHaveLength(2);
        expect(authors[0].posts[0].title).toBe('First');
        expect(authors[1].posts).toEqual([]);
    });

    it('loads a one-to-one relation via its foreign key', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, email: 'ann@example.com', profileid: 5 }],
            rowCount: 1,
        });
        provider.nextResult({ rows: [{ id: 5, bio: 'Hello' }], rowCount: 1 });

        const users = await db.set(ElUser).include(u => u.profile).toList();

        expect(provider.calls[1].sql).toBe('SELECT * FROM el_profiles WHERE id IN ($1)');
        expect(users[0].profile.bio).toBe('Hello');
    });

    it('loads a many-to-many relation through the join table', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, name: 'Ann' },
                { id: 2, name: 'Bob' },
            ],
            rowCount: 2,
        });
        provider.nextResult({
            rows: [
                { elstudentid: 1, elcourseid: 100 },
                { elstudentid: 1, elcourseid: 101 },
                { elstudentid: 2, elcourseid: 100 },
            ],
            rowCount: 3,
        });
        provider.nextResult({
            rows: [
                { id: 100, title: 'Math' },
                { id: 101, title: 'Art' },
            ],
            rowCount: 2,
        });

        const students = await db.set(ElStudent).include(s => s.courses).toList();

        expect(provider.calls[1].sql).toBe('SELECT * FROM elcourse_elstudent WHERE elstudentid IN ($1, $2)');
        expect(provider.calls[1].params).toEqual([1, 2]);
        expect(provider.calls[2].sql).toBe('SELECT * FROM el_courses WHERE id IN ($1, $2)');
        expect(provider.calls[2].params).toEqual([100, 101]);

        expect(students[0].courses.map(c => c.title)).toEqual(['Math', 'Art']);
        expect(students[1].courses.map(c => c.title)).toEqual(['Math']);
    });

    it('assigns empty collections when the join table has no rows', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'Ann' }], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 0 });

        const students = await db.set(ElStudent).include(s => s.courses).toList();

        expect(students[0].courses).toEqual([]);
        // No third query for related entities when the join table is empty
        expect(provider.calls).toHaveLength(2);
    });

    it('skips the batched query when no entities have foreign keys set', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 3, title: 'Orphan', authorid: null }],
            rowCount: 1,
        });

        await db.set(ElPost).include(p => p.author).toList();

        expect(provider.calls).toHaveLength(1);
    });

    it('throws on include() of an unknown relation', () => {
        const { db } = makeDb();
        expect(() => db.set(ElPost).include((p: any) => p.reviews)).toThrow(/Relation reviews not found/);
    });
});
