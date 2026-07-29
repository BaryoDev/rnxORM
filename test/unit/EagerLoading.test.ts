import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column, ManyToOne, OneToMany, OneToOne, ManyToMany } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

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
    name!: string;

    @OneToMany(() => ElPost, (post: any) => post.author)
    posts!: ElPost[];

    @OneToOne(() => ElProfile, (profile: any) => profile.user)
    profile!: ElProfile;
}

@Entity('el_posts')
class ElPost {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @ManyToOne(() => ElUser, (user: any) => user.posts)
    author!: ElUser;
}

@Entity('el_courses')
class ElCourse {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

@Entity('el_students')
class ElStudent {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @ManyToMany(() => ElCourse, (course: any) => course.students, {
        joinTable: 'el_student_courses',
        joinColumn: 'studentid',
        inverseJoinColumn: 'courseid',
    })
    courses!: ElCourse[];
}

function makeDb(): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider('postgresql');
    const db = new DbContext(provider);
    return { db, provider };
}

describe('Eager loading: ManyToOne', () => {
    it('batches foreign keys into one IN query and hydrates author', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, title: 'A', authorid: 10 },
                { id: 2, title: 'B', authorid: 20 },
                { id: 3, title: 'C', authorid: 10 },
            ],
            rowCount: 3,
        });
        provider.nextResult({
            rows: [
                { id: 10, name: 'Alice' },
                { id: 20, name: 'Bob' },
            ],
            rowCount: 2,
        });

        const posts = await db.set(ElPost).include(p => p.author).toList();

        expect(provider.calls).toHaveLength(2);
        expect(provider.calls[1].sql).toBe('SELECT * FROM el_users WHERE id IN ($1, $2)');
        expect(provider.calls[1].params).toEqual([10, 20]); // deduplicated FK values

        expect(posts[0].author.name).toBe('Alice');
        expect(posts[1].author.name).toBe('Bob');
        // Posts sharing an author get the same entity instance
        expect(posts[2].author).toBe(posts[0].author);
    });

    it('issues no related query when all foreign keys are null', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, title: 'A', authorid: null }],
            rowCount: 1,
        });

        const posts = await db.set(ElPost).include(p => p.author).toList();

        expect(provider.calls).toHaveLength(1);
        expect(posts[0].author).toBeUndefined();
    });
});

describe('Eager loading: OneToMany', () => {
    it('loads collections via the inverse foreign key and groups them', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 10, name: 'Alice' },
                { id: 20, name: 'Bob' },
                { id: 30, name: 'Carol' },
            ],
            rowCount: 3,
        });
        provider.nextResult({
            rows: [
                { id: 1, title: 'A', authorid: 10 },
                { id: 2, title: 'B', authorid: 10 },
                { id: 3, title: 'C', authorid: 20 },
            ],
            rowCount: 3,
        });

        const users = await db.set(ElUser).include(u => u.posts).toList();

        expect(provider.calls[1].sql).toBe('SELECT * FROM el_posts WHERE authorid IN ($1, $2, $3)');
        expect(provider.calls[1].params).toEqual([10, 20, 30]);

        expect(users[0].posts.map(p => p.title)).toEqual(['A', 'B']);
        expect(users[1].posts.map(p => p.title)).toEqual(['C']);
        // Entities without related rows get an empty array, not undefined
        expect(users[2].posts).toEqual([]);
    });
});

describe('Eager loading: OneToOne', () => {
    it('loads the related entity through the foreign key column', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 10, name: 'Alice', profileid: 100 }],
            rowCount: 1,
        });
        provider.nextResult({
            rows: [{ id: 100, bio: 'hello' }],
            rowCount: 1,
        });

        const users = await db.set(ElUser).include(u => u.profile).toList();

        expect(provider.calls[1].sql).toBe('SELECT * FROM el_profiles WHERE id IN ($1)');
        expect(provider.calls[1].params).toEqual([100]);
        expect(users[0].profile.bio).toBe('hello');
    });
});

describe('Eager loading: ManyToMany', () => {
    it('queries the join table then the related table, and groups per source', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, name: 'S1' },
                { id: 2, name: 'S2' },
            ],
            rowCount: 2,
        });
        provider.nextResult({
            rows: [
                { studentid: 1, courseid: 100 },
                { studentid: 1, courseid: 200 },
                { studentid: 2, courseid: 100 },
            ],
            rowCount: 3,
        });
        provider.nextResult({
            rows: [
                { id: 100, name: 'Math' },
                { id: 200, name: 'Art' },
            ],
            rowCount: 2,
        });

        const students = await db.set(ElStudent).include(s => s.courses).toList();

        expect(provider.calls).toHaveLength(3);
        expect(provider.calls[1].sql).toBe('SELECT * FROM el_student_courses WHERE studentid IN ($1, $2)');
        expect(provider.calls[1].params).toEqual([1, 2]);
        expect(provider.calls[2].sql).toBe('SELECT * FROM el_courses WHERE id IN ($1, $2)');
        expect(provider.calls[2].params).toEqual([100, 200]);

        expect(students[0].courses.map(c => c.name)).toEqual(['Math', 'Art']);
        expect(students[1].courses.map(c => c.name)).toEqual(['Math']);
        // Shared course entities are the same instance
        expect(students[1].courses[0]).toBe(students[0].courses[0]);
    });

    it('assigns empty collections and skips the related query when the join table has no rows', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'S1' }],
            rowCount: 1,
        });
        provider.nextResult({ rows: [], rowCount: 0 });

        const students = await db.set(ElStudent).include(s => s.courses).toList();

        expect(provider.calls).toHaveLength(2); // no third query
        expect(students[0].courses).toEqual([]);
    });
});

describe('Eager loading: combinations and errors', () => {
    it('applies where conditions to the main query only', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, title: 'A', authorid: 10 }],
            rowCount: 1,
        });
        provider.nextResult({
            rows: [{ id: 10, name: 'Alice' }],
            rowCount: 1,
        });

        await db.set(ElPost).where('title', '=', 'A').include(p => p.author).toList();

        expect(provider.calls[0].sql).toBe('SELECT * FROM el_posts WHERE title = $1');
        expect(provider.calls[1].sql).toBe('SELECT * FROM el_users WHERE id IN ($1)');
    });

    it('throws when including an unknown relation', () => {
        const { db } = makeDb();
        expect(() => db.set(ElProfile).include((p: any) => p.nothing)).toThrow(/Relation nothing not found/);
    });
});
