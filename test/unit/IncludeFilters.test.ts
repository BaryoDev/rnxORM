import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column, ManyToOne, OneToMany, ManyToMany } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

/**
 * Global query filters were compiled into the root query but never into the
 * queries that load related entities, so include() returned rows the filter
 * was meant to hide. With a tenant filter rather than a soft-delete flag, that
 * is another tenant's child rows (issue #37).
 */

@Entity('if_blogs')
class IfBlog {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @OneToMany(() => IfPost, (p: IfPost) => p.blog)
    posts!: IfPost[];
}

@Entity('if_posts')
class IfPost {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    isdeleted!: boolean;

    @ManyToOne(() => IfBlog, (b: IfBlog) => b.posts)
    blog!: IfBlog;
}

@Entity('if_authors')
class IfAuthor {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    isdeleted!: boolean;
}

@Entity('if_articles')
class IfArticle {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @ManyToOne(() => IfAuthor)
    author!: IfAuthor;
}

@Entity('if_courses')
class IfCourse {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @Column()
    isdeleted!: boolean;
}

@Entity('if_students')
class IfStudent {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @ManyToMany(() => IfCourse)
    courses!: IfCourse[];
}

beforeAll(() => {
    const mb = new ModelBuilder();
    mb.entity(IfPost).hasQueryFilter({ property: 'isdeleted', operator: '=', value: false });
    mb.entity(IfAuthor).hasQueryFilter({ property: 'isdeleted', operator: '=', value: false });
    mb.entity(IfCourse).hasQueryFilter({ property: 'isdeleted', operator: '=', value: false });
});

function makeDb() {
    const provider = new SqlCaptureProvider('postgresql');
    return { db: new DbContext(provider), provider };
}

describe('query filters reach eager-loaded relations (#37)', () => {
    it('filters a one-to-many collection load', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, title: 'b' }], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(IfBlog).include(b => b.posts).toList();

        expect(provider.calls[1].sql).toBe(
            'SELECT * FROM if_posts WHERE blogid IN ($1) AND isdeleted = $2'
        );
        expect(provider.calls[1].params).toEqual([1, false]);
    });

    it('filters a many-to-one reference load', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, title: 'a', authorid: 7 }], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(IfArticle).include(a => a.author).toList();

        expect(provider.calls[1].sql).toBe(
            'SELECT * FROM if_authors WHERE id IN ($1) AND isdeleted = $2'
        );
        expect(provider.calls[1].params).toEqual([7, false]);
    });

    it('filters the related side of a many-to-many load', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 's' }], rowCount: 1 });
        provider.nextResult({ rows: [{ ifstudentid: 1, ifcourseid: 5 }], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(IfStudent).include(s => s.courses).toList();

        expect(provider.calls[2].sql).toBe(
            'SELECT * FROM if_courses WHERE id IN ($1) AND isdeleted = $2'
        );
        expect(provider.calls[2].params).toEqual([5, false]);
    });

    it('numbers placeholders after the whole key list', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, title: 'b' }, { id: 2, title: 'c' }],
            rowCount: 2,
        });
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(IfBlog).include(b => b.posts).toList();

        expect(provider.calls[1].sql).toBe(
            'SELECT * FROM if_posts WHERE blogid IN ($1, $2) AND isdeleted = $3'
        );
        expect(provider.calls[1].params).toEqual([1, 2, false]);
    });

    it('ignoreQueryFilters() propagates to the include', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, title: 'b' }], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(IfBlog).ignoreQueryFilters().include(b => b.posts).toList();

        expect(provider.calls[1].sql).toBe('SELECT * FROM if_posts WHERE blogid IN ($1)');
        expect(provider.calls[1].params).toEqual([1]);
    });

    it('leaves an unfiltered relation alone', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 1, name: 'p', isdeleted: false, blogid: 4 }], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(IfPost).include(p => p.blog).toList();

        // if_blogs has no filter of its own.
        expect(provider.calls[1].sql).toBe('SELECT * FROM if_blogs WHERE id IN ($1)');
    });
});

describe('ignoreQueryFilters() on DbSet.groupBy() (#37)', () => {
    it('is honored when groupBy is called directly on the set', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(IfPost).ignoreQueryFilters().groupBy(p => p.name).toList();

        expect(provider.lastCall!.sql).not.toContain('isdeleted');
    });

    it('still applies the filter without the flag', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(IfPost).groupBy(p => p.name).toList();

        expect(provider.lastCall!.sql).toContain('isdeleted');
    });
});
