import "reflect-metadata";
import { MetadataStorage, EntityMetadata, ColumnMetadata, RelationType, CascadeOption } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

@Entity('test_entity')
class TestEntity {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

describe('MetadataStorage', () => {
    let storage: MetadataStorage;

    beforeEach(() => {
        storage = MetadataStorage.get();
    });

    describe('Entity Metadata', () => {
        it('should add entity metadata', () => {
            storage.addEntity(TestEntity, 'test_table');
            const metadata = storage.getEntity(TestEntity);

            expect(metadata).toBeDefined();
            expect(metadata?.tableName).toBe('test_table');
            expect(metadata?.target).toBe(TestEntity);
        });

        it('should update existing entity metadata', () => {
            storage.addEntity(TestEntity, 'table1');
            storage.addEntity(TestEntity, 'table2');

            const metadata = storage.getEntity(TestEntity);
            expect(metadata?.tableName).toBe('table2');
        });

        it('should return all entities', () => {
            const entities = storage.getEntities();
            expect(Array.isArray(entities)).toBe(true);
        });

        it('should return undefined for non-existent entity', () => {
            class NonExistentEntity {}
            const metadata = storage.getEntity(NonExistentEntity);
            expect(metadata).toBeUndefined();
        });
    });

    describe('Column Metadata', () => {
        it('should add column metadata', () => {
            storage.addColumn(TestEntity, 'testColumn', {
                columnName: 'test_column',
                type: 'varchar',
                isPrimaryKey: false,
                isNullable: true
            });

            const metadata = storage.getEntity(TestEntity);
            const column = metadata?.columns.find(c => c.propertyName === 'testColumn');

            expect(column).toBeDefined();
            expect(column?.columnName).toBe('test_column');
            expect(column?.type).toBe('varchar');
            expect(column?.isPrimaryKey).toBe(false);
            expect(column?.isNullable).toBe(true);
        });

        it('should add shadow property metadata', () => {
            storage.addColumn(TestEntity, 'shadowProp', {
                columnName: 'shadow_prop',
                type: 'int',
                isShadowProperty: true
            });

            const metadata = storage.getEntity(TestEntity);
            const column = metadata?.columns.find(c => c.propertyName === 'shadowProp');

            expect(column?.isShadowProperty).toBe(true);
        });

        it('should add value converter metadata', () => {
            const convertToDb = (val: any) => JSON.stringify(val);
            const convertFromDb = (val: any) => JSON.parse(val);

            storage.addColumn(TestEntity, 'jsonData', {
                columnName: 'json_data',
                type: 'text',
                hasConversion: true,
                convertToDb,
                convertFromDb
            });

            const metadata = storage.getEntity(TestEntity);
            const column = metadata?.columns.find(c => c.propertyName === 'jsonData');

            expect(column?.hasConversion).toBe(true);
            expect(column?.convertToDb).toBe(convertToDb);
            expect(column?.convertFromDb).toBe(convertFromDb);
        });

        it('should add concurrency token metadata', () => {
            storage.addColumn(TestEntity, 'version', {
                columnName: 'version',
                type: 'int',
                isConcurrencyToken: true
            });

            const metadata = storage.getEntity(TestEntity);
            const column = metadata?.columns.find(c => c.propertyName === 'version');

            expect(column?.isConcurrencyToken).toBe(true);
        });

        it('should add computed column metadata', () => {
            storage.addColumn(TestEntity, 'fullName', {
                columnName: 'full_name',
                type: 'varchar',
                isComputed: true,
                computedColumnSql: 'CONCAT(first_name, \' \', last_name)'
            });

            const metadata = storage.getEntity(TestEntity);
            const column = metadata?.columns.find(c => c.propertyName === 'fullName');

            expect(column?.isComputed).toBe(true);
            expect(column?.computedColumnSql).toBe('CONCAT(first_name, \' \', last_name)');
        });

        it('should use default values when options not provided', () => {
            storage.addColumn(TestEntity, 'defaultColumn');

            const metadata = storage.getEntity(TestEntity);
            const column = metadata?.columns.find(c => c.propertyName === 'defaultColumn');

            expect(column?.columnName).toBe('defaultColumn');
            expect(column?.type).toBe('text');
            expect(column?.isPrimaryKey).toBe(false);
            expect(column?.isNullable).toBe(false);
        });
    });

    describe('Relation Metadata', () => {
        it('should add one-to-many relation', () => {
            class User {
                id!: number;
                posts!: Post[];
            }
            class Post {
                id!: number;
                userId!: number;
            }

            storage.addRelation(User, {
                target: User,
                propertyName: 'posts',
                relatedEntity: () => Post,
                relationType: RelationType.OneToMany,
                inverseSide: 'user'
            });

            const metadata = storage.getEntity(User);
            expect(metadata?.relations).toHaveLength(1);
            expect(metadata?.relations[0].relationType).toBe(RelationType.OneToMany);
            expect(metadata?.relations[0].propertyName).toBe('posts');
        });

        it('should add many-to-one relation with foreign key', () => {
            class Post {
                id!: number;
                userId!: number;
            }

            storage.addRelation(Post, {
                target: Post,
                propertyName: 'user',
                relatedEntity: () => class User {},
                relationType: RelationType.ManyToOne,
                foreignKeyColumn: 'user_id',
                onDelete: CascadeOption.Cascade
            });

            const metadata = storage.getEntity(Post);
            const relation = metadata?.relations[0];

            expect(relation?.relationType).toBe(RelationType.ManyToOne);
            expect(relation?.foreignKeyColumn).toBe('user_id');
            expect(relation?.onDelete).toBe(CascadeOption.Cascade);
        });

        it('should add many-to-many relation with join table', () => {
            class Student {
                id!: number;
            }

            storage.addRelation(Student, {
                target: Student,
                propertyName: 'courses',
                relatedEntity: () => class Course {},
                relationType: RelationType.ManyToMany,
                joinTable: 'student_courses',
                joinColumn: 'student_id',
                inverseJoinColumn: 'course_id'
            });

            const metadata = storage.getEntity(Student);
            const relation = metadata?.relations[0];

            expect(relation?.relationType).toBe(RelationType.ManyToMany);
            expect(relation?.joinTable).toBe('student_courses');
            expect(relation?.joinColumn).toBe('student_id');
            expect(relation?.inverseJoinColumn).toBe('course_id');
        });
    });

    describe('Index Metadata', () => {
        it('should add index metadata', () => {
            storage.addIndex(TestEntity, {
                target: TestEntity,
                columns: ['name', 'email'],
                unique: false,
                name: 'idx_name_email'
            });

            const metadata = storage.getEntity(TestEntity);
            expect(metadata?.indexes).toHaveLength(1);
            expect(metadata?.indexes[0].columns).toEqual(['name', 'email']);
            expect(metadata?.indexes[0].unique).toBe(false);
            expect(metadata?.indexes[0].name).toBe('idx_name_email');
        });

        it('should add unique index', () => {
            storage.addIndex(TestEntity, {
                target: TestEntity,
                columns: ['email'],
                unique: true
            });

            const metadata = storage.getEntity(TestEntity);
            // Find the index with only 'email' column (not the one with ['name', 'email'])
            const index = metadata?.indexes.find(i => i.columns.length === 1 && i.columns[0] === 'email');
            expect(index?.unique).toBe(true);
        });
    });

    describe('Unique Constraint Metadata', () => {
        it('should add unique constraint metadata', () => {
            storage.addUniqueConstraint(TestEntity, {
                target: TestEntity,
                columns: ['email'],
                name: 'uq_email'
            });

            const metadata = storage.getEntity(TestEntity);
            expect(metadata?.uniqueConstraints).toHaveLength(1);
            expect(metadata?.uniqueConstraints[0].columns).toEqual(['email']);
            expect(metadata?.uniqueConstraints[0].name).toBe('uq_email');
        });
    });

    describe('Advanced Features', () => {
        it('should support keyless entity types', () => {
            storage.addEntity(TestEntity, 'test_view');
            const metadata = storage.getEntity(TestEntity);

            if (metadata) {
                metadata.isKeyless = true;
            }

            expect(metadata?.isKeyless).toBe(true);
        });

        it('should support global query filters', () => {
            storage.addEntity(TestEntity, 'test_table');
            const metadata = storage.getEntity(TestEntity);

            const filter = (entity: any) => !entity.isDeleted;
            if (metadata) {
                metadata.queryFilter = filter;
            }

            expect(metadata?.queryFilter).toBe(filter);
        });

        it('should support seed data', () => {
            storage.addEntity(TestEntity, 'test_table');
            const metadata = storage.getEntity(TestEntity);

            const seedData = [
                { id: 1, name: 'Test 1' },
                { id: 2, name: 'Test 2' }
            ];

            if (metadata) {
                metadata.seedData = seedData;
            }

            expect(metadata?.seedData).toEqual(seedData);
        });

        it('should support owned entity types', () => {
            class Address {
                street!: string;
                city!: string;
            }

            storage.addEntity(TestEntity, 'test_table');
            const metadata = storage.getEntity(TestEntity);

            if (metadata) {
                metadata.ownedEntities = [{
                    ownedType: Address,
                    propertyName: 'address',
                    columnPrefix: 'address_'
                }];
            }

            expect(metadata?.ownedEntities).toHaveLength(1);
            expect(metadata?.ownedEntities![0].ownedType).toBe(Address);
            expect(metadata?.ownedEntities![0].columnPrefix).toBe('address_');
        });
    });
});
