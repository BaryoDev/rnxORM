import "reflect-metadata";
import { MetadataStorage, RelationType, CascadeOption, RelationMetadata } from "../core/MetadataStorage";

export function Entity(tableName?: string) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    return function (target: Function) {
        MetadataStorage.get().addEntity(target, tableName || target.name.toLowerCase());
    };
}

export interface ColumnOptions {
    name?: string;
    type?: string;
    nullable?: boolean;
}

export function Column(options: ColumnOptions = {}) {
    return function (target: object, propertyName: string) {
        const designType = Reflect.getMetadata("design:type", target, propertyName);
        let type = options.type;

        if (!type && designType) {
            if (designType === String) type = "text";
            else if (designType === Number) type = "integer";
            else if (designType === Boolean) type = "boolean";
            else if (designType === Date) type = "timestamp";
        }

        MetadataStorage.get().addColumn(target.constructor, propertyName, {
            columnName: options.name || propertyName.toLowerCase(),
            type,
            isNullable: options.nullable,
        });
    };
}

export function PrimaryKey() {
    return function (target: object, propertyName: string) {
        const designType = Reflect.getMetadata("design:type", target, propertyName);
        let type = "integer"; // Default PK type

        if (designType === String) type = "text";

        MetadataStorage.get().addColumn(target.constructor, propertyName, {
            isPrimaryKey: true,
            type
        });
    };
}

// Relationship Decorators

export interface RelationOptions {
    cascade?: CascadeOption | CascadeOption[];
    nullable?: boolean;
    eager?: boolean;
    onDelete?: CascadeOption;
    onUpdate?: CascadeOption;
}

export interface ManyToOneOptions extends RelationOptions {
    foreignKey?: string; // Custom foreign key column name
}

export interface OneToManyOptions extends RelationOptions {
    // No additional options needed
}

export interface OneToOneOptions extends RelationOptions {
    foreignKey?: string; // Custom foreign key column name
}

export interface ManyToManyOptions extends RelationOptions {
    joinTable?: string; // Custom join table name
    joinColumn?: string; // Column in join table pointing to this entity
    inverseJoinColumn?: string; // Column in join table pointing to related entity
}

/**
 * Many-to-One relationship decorator
 * Defines the "many" side of a relationship (e.g., many Posts belong to one User)
 *
 * @param relatedEntity Function that returns the related entity class
 * @param inverseSide Property name on the related entity (for the One side)
 * @param options Relationship configuration options
 *
 * @example
 * class Post {
 *   @ManyToOne(() => User, user => user.posts)
 *   author!: User;
 * }
 */
export function ManyToOne(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    relatedEntity: () => Function,
    inverseSide?: (object: any) => any,
    options: ManyToOneOptions = {}
) {
    return function (target: object, propertyName: string) {
        const inverseSideName = inverseSide ? extractPropertyName(inverseSide) : undefined;
        const foreignKeyColumn = options.foreignKey || `${propertyName.toLowerCase()}id`;

        const relation: RelationMetadata = {
            target: target.constructor,
            propertyName,
            relatedEntity,
            relationType: RelationType.ManyToOne,
            inverseSide: inverseSideName,
            foreignKeyColumn,
            onDelete: options.onDelete || (options.nullable ? CascadeOption.SetNull : CascadeOption.Restrict),
            onUpdate: options.onUpdate || CascadeOption.NoAction,
            nullable: options.nullable,
            eager: options.eager,
        };

        MetadataStorage.get().addRelation(target.constructor, relation);

        // Also add the foreign key column to the entity
        MetadataStorage.get().addColumn(target.constructor, foreignKeyColumn, {
            columnName: foreignKeyColumn,
            type: "integer", // Assuming integer foreign keys by default
            isNullable: options.nullable ?? false,
        });
    };
}

/**
 * One-to-Many relationship decorator
 * Defines the "one" side of a relationship (e.g., one User has many Posts)
 *
 * @param relatedEntity Function that returns the related entity class
 * @param inverseSide Property name on the related entity (for the Many side)
 * @param options Relationship configuration options
 *
 * @example
 * class User {
 *   @OneToMany(() => Post, post => post.author)
 *   posts!: Post[];
 * }
 */
export function OneToMany(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    relatedEntity: () => Function,
    inverseSide?: (object: any) => any,
    options: OneToManyOptions = {}
) {
    return function (target: object, propertyName: string) {
        const inverseSideName = inverseSide ? extractPropertyName(inverseSide) : undefined;

        const relation: RelationMetadata = {
            target: target.constructor,
            propertyName,
            relatedEntity,
            relationType: RelationType.OneToMany,
            inverseSide: inverseSideName,
            onDelete: options.onDelete || CascadeOption.NoAction,
            onUpdate: options.onUpdate || CascadeOption.NoAction,
            eager: options.eager,
        };

        MetadataStorage.get().addRelation(target.constructor, relation);
    };
}

/**
 * One-to-One relationship decorator
 * Defines a one-to-one relationship
 *
 * @param relatedEntity Function that returns the related entity class
 * @param inverseSide Property name on the related entity
 * @param options Relationship configuration options
 *
 * @example
 * class User {
 *   @OneToOne(() => Profile, profile => profile.user)
 *   profile!: Profile;
 * }
 */
export function OneToOne(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    relatedEntity: () => Function,
    inverseSide?: (object: any) => any,
    options: OneToOneOptions = {}
) {
    return function (target: object, propertyName: string) {
        const inverseSideName = inverseSide ? extractPropertyName(inverseSide) : undefined;
        const foreignKeyColumn = options.foreignKey || `${propertyName.toLowerCase()}id`;

        const relation: RelationMetadata = {
            target: target.constructor,
            propertyName,
            relatedEntity,
            relationType: RelationType.OneToOne,
            inverseSide: inverseSideName,
            foreignKeyColumn,
            onDelete: options.onDelete || (options.nullable ? CascadeOption.SetNull : CascadeOption.Restrict),
            onUpdate: options.onUpdate || CascadeOption.NoAction,
            nullable: options.nullable,
            eager: options.eager,
        };

        MetadataStorage.get().addRelation(target.constructor, relation);

        // Also add the foreign key column to the entity
        MetadataStorage.get().addColumn(target.constructor, foreignKeyColumn, {
            columnName: foreignKeyColumn,
            type: "integer",
            isNullable: options.nullable ?? false,
        });
    };
}

/**
 * Many-to-Many relationship decorator
 * Defines a many-to-many relationship (creates a join table)
 *
 * @param relatedEntity Function that returns the related entity class
 * @param inverseSide Property name on the related entity
 * @param options Relationship configuration options
 *
 * @example
 * class Student {
 *   @ManyToMany(() => Course, course => course.students)
 *   courses!: Course[];
 * }
 */
export function ManyToMany(
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    relatedEntity: () => Function,
    inverseSide?: (object: any) => any,
    options: ManyToManyOptions = {}
) {
    return function (target: object, propertyName: string) {
        const inverseSideName = inverseSide ? extractPropertyName(inverseSide) : undefined;
        const entityName = target.constructor.name.toLowerCase();
        const relatedEntityName = relatedEntity().name.toLowerCase();

        // Generate join table name: alphabetically sorted to ensure consistency
        const defaultJoinTable = [entityName, relatedEntityName].sort().join('_');
        const joinTable = options.joinTable || defaultJoinTable;
        const joinColumn = options.joinColumn || `${entityName}id`;
        const inverseJoinColumn = options.inverseJoinColumn || `${relatedEntityName}id`;

        const relation: RelationMetadata = {
            target: target.constructor,
            propertyName,
            relatedEntity,
            relationType: RelationType.ManyToMany,
            inverseSide: inverseSideName,
            joinTable,
            joinColumn,
            inverseJoinColumn,
            onDelete: options.onDelete || CascadeOption.Cascade,
            onUpdate: options.onUpdate || CascadeOption.NoAction,
            eager: options.eager,
        };

        MetadataStorage.get().addRelation(target.constructor, relation);
    };
}

/**
 * Index decorator
 * Creates a database index on one or more columns
 *
 * @param options Index configuration
 *
 * @example
 * class User {
 *   @Index()
 *   @Column()
 *   email!: string;
 * }
 */
export function Index(options: { unique?: boolean; name?: string } = {}) {
    return function (target: object, propertyName: string) {
        MetadataStorage.get().addIndex(target.constructor, {
            target: target.constructor,
            columns: [propertyName.toLowerCase()],
            unique: options.unique || false,
            name: options.name,
        });
    };
}

/**
 * Unique constraint decorator
 * Ensures column values are unique
 *
 * @example
 * class User {
 *   @Unique()
 *   @Column()
 *   email!: string;
 * }
 */
export function Unique() {
    return function (target: object, propertyName: string) {
        MetadataStorage.get().addUniqueConstraint(target.constructor, {
            target: target.constructor,
            columns: [propertyName.toLowerCase()],
        });
    };
}

// Helper function to extract property name from lambda expression
function extractPropertyName(fn: (object: any) => any): string {
    const fnStr = fn.toString();
    // Match: user => user.posts or (user) => user.posts
    const match = fnStr.match(/(?:=>|return)\s*\w+\.(\w+)/);
    if (match && match[1]) {
        return match[1];
    }
    throw new Error(`Unable to extract property name from function: ${fnStr}`);
}

// Re-export enums for convenience
export { CascadeOption, RelationType } from "../core/MetadataStorage";
