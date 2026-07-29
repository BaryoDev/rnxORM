import "reflect-metadata";
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { MetadataStorage, RelationType, CascadeOption } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

@Entity('rb_authors')
class RbAuthor {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    books!: RbBook[];
}

@Entity('rb_books')
class RbBook {
    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    author!: RbAuthor;
}

@Entity('rb_tags')
class RbTag {
    @PrimaryKey()
    id!: number;

    @Column()
    label!: string;

    books!: RbBook[];
}

function relations(entityType: any) {
    return MetadataStorage.get().getEntity(entityType)!.relations;
}

describe('ModelBuilder relationship configuration', () => {
    const builder = new ModelBuilder();

    it('hasOne().withMany().hasForeignKey().onDelete() configures a many-to-one relation', () => {
        builder.entity(RbBook)
            .hasOne(b => b.author, RbAuthor)
            .withMany((a: RbAuthor) => a.books)
            .hasForeignKey('author_id')
            .onDelete(CascadeOption.Cascade)
            .onUpdate(CascadeOption.NoAction);

        const relation = relations(RbBook).find(r => r.propertyName === 'author')!;
        expect(relation.relationType).toBe(RelationType.ManyToOne);
        expect(relation.relatedEntity()).toBe(RbAuthor);
        expect(relation.inverseSide).toBe('books');
        expect(relation.foreignKeyColumn).toBe('author_id');
        expect(relation.onDelete).toBe(CascadeOption.Cascade);
        expect(relation.onUpdate).toBe(CascadeOption.NoAction);
    });

    it('hasMany().withMany() configures a one-to-many relation', () => {
        builder.entity(RbAuthor)
            .hasMany(a => a.books, RbBook)
            .withMany((b: RbBook) => b.author);

        const relation = relations(RbAuthor).find(r => r.propertyName === 'books')!;
        expect(relation.relationType).toBe(RelationType.OneToMany);
        expect(relation.relatedEntity()).toBe(RbBook);
        expect(relation.inverseSide).toBe('author');
    });

    it('hasManyToMany() with explicit options stores join table configuration', () => {
        builder.entity(RbBook)
            .hasManyToMany((b: any) => b.tags, RbTag, {
                joinTable: 'rb_book_tags',
                leftKey: 'bookid',
                rightKey: 'tagid',
            });

        const relation = relations(RbBook).find(r => r.propertyName === 'tags')!;
        expect(relation.relationType).toBe(RelationType.ManyToMany);
        expect(relation.joinTable).toBe('rb_book_tags');
        expect(relation.joinColumn).toBe('bookid');
        expect(relation.inverseJoinColumn).toBe('tagid');
    });

    it('hasManyToMany() without options derives join table and key names', () => {
        builder.entity(RbTag)
            .hasManyToMany((t: any) => t.books, RbBook);

        const relation = relations(RbTag).find(r => r.propertyName === 'books')!;
        expect(relation.joinTable).toBe('rbtag_rbbook');
        expect(relation.joinColumn).toBe('rbtagId');
        expect(relation.inverseJoinColumn).toBe('rbbookId');
    });

    it('usingJoinTable() overrides the join table configuration', () => {
        builder.entity(RbTag)
            .hasManyToMany((t: any) => t.books, RbBook)
            .usingJoinTable('rb_tag_links', 'tag_id', 'book_id');

        const relation = relations(RbTag).find(r => r.propertyName === 'books')!;
        expect(relation.joinTable).toBe('rb_tag_links');
        expect(relation.joinColumn).toBe('tag_id');
        expect(relation.inverseJoinColumn).toBe('book_id');
    });

    it('does not duplicate a relation when configured twice', () => {
        builder.entity(RbBook).hasOne(b => b.author, RbAuthor);
        builder.entity(RbBook).hasOne(b => b.author, RbAuthor);

        const authorRelations = relations(RbBook).filter(r => r.propertyName === 'author');
        expect(authorRelations).toHaveLength(1);
    });
});
