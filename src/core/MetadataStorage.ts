export interface ColumnMetadata {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    target: Function;
    propertyName: string;
    columnName: string;
    type: string;
    isPrimaryKey: boolean;
    isNullable: boolean;
    isAutoIncrement?: boolean;
    defaultValue?: any; // Default value for column
    isComputed?: boolean; // Is this a computed column?
    computedColumnSql?: string; // SQL for computed column
    isShadowProperty?: boolean; // Is this a shadow property (no entity property)?
    hasConversion?: boolean; // Does this column have value conversion?
    convertToDb?: (value: any) => any; // Convert from entity to database
    convertFromDb?: (value: any) => any; // Convert from database to entity
    isConcurrencyToken?: boolean; // Is this a concurrency token for optimistic locking?
}

export enum RelationType {
    OneToOne = "one-to-one",
    OneToMany = "one-to-many",
    ManyToOne = "many-to-one",
    ManyToMany = "many-to-many",
    OwnsOne = "owns-one",
    OwnsMany = "owns-many",
}

export enum CascadeOption {
    Cascade = "CASCADE",
    SetNull = "SET NULL",
    Restrict = "RESTRICT",
    NoAction = "NO ACTION",
}

export interface RelationMetadata {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    target: Function; // The entity class that has this relation
    propertyName: string; // The property name on the source entity
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    relatedEntity: () => Function; // Function that returns the related entity class
    relationType: RelationType;
    inverseSide?: string; // Property name on the related entity (for bidirectional relations)

    // Foreign key configuration
    foreignKeyColumn?: string; // Column name for foreign key (for ManyToOne/OneToOne)
    joinTable?: string; // Join table name (for ManyToMany)
    joinColumn?: string; // Column in join table pointing to source entity
    inverseJoinColumn?: string; // Column in join table pointing to related entity

    // Cascade options
    onDelete?: CascadeOption;
    onUpdate?: CascadeOption;

    // Other options
    nullable?: boolean;
    eager?: boolean; // Should this relation be loaded by default?
}

export interface IndexMetadata {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    target: Function;
    columns: string[]; // Column names
    unique: boolean;
    name?: string; // Custom index name
}

export interface UniqueConstraintMetadata {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    target: Function;
    columns: string[]; // Column names
    name?: string; // Custom constraint name
}

export interface OwnedEntityMetadata {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    ownedType: Function; // The owned entity type
    propertyName: string; // Property on owner entity
    columnPrefix?: string; // Prefix for owned entity columns in owner table
}

export interface EntityMetadata {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    target: Function;
    tableName: string;
    columns: ColumnMetadata[];
    relations: RelationMetadata[];
    indexes: IndexMetadata[];
    uniqueConstraints: UniqueConstraintMetadata[];
    ownedEntities?: OwnedEntityMetadata[]; // Owned entity types
    seedData?: any[]; // Initial data for seeding
    queryFilter?: (entity: any) => boolean; // Global query filter (e.g., soft delete)
    isKeyless?: boolean; // Is this a keyless entity type (for views, query types)
}

export class MetadataStorage {
    private static instance: MetadataStorage;
    private entities: EntityMetadata[] = [];

    private constructor() { }

    static get(): MetadataStorage {
        if (!MetadataStorage.instance) {
            MetadataStorage.instance = new MetadataStorage();
        }
        return MetadataStorage.instance;
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    addEntity(target: Function, tableName: string) {
        let entity = this.entities.find((e) => e.target === target);
        if (entity) {
            entity.tableName = tableName;
        } else {
            this.entities.push({
                target,
                tableName,
                columns: [],
                relations: [],
                indexes: [],
                uniqueConstraints: [],
            });
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    addColumn(target: Function, propertyName: string, options: Partial<ColumnMetadata> = {}) {
        let entity = this.entities.find((e) => e.target === target);
        if (!entity) {
            entity = {
                target,
                tableName: target.name.toLowerCase(), // Default table name
                columns: [],
                relations: [],
                indexes: [],
                uniqueConstraints: [],
            };
            this.entities.push(entity);
        }

        // Guard against duplicate column registration
        const columnName = options.columnName || propertyName;
        const existing = entity.columns.find(c => c.propertyName === propertyName || c.columnName === columnName);
        if (existing) {
            // Update existing column metadata instead of duplicating
            Object.assign(existing, {
                ...options,
                target,
                propertyName,
                columnName,
                type: options.type || existing.type,
                isPrimaryKey: options.isPrimaryKey ?? existing.isPrimaryKey,
                isNullable: options.isNullable ?? existing.isNullable,
                isAutoIncrement: options.isAutoIncrement ?? existing.isAutoIncrement,
            });
            return;
        }

        entity.columns.push({
            target,
            propertyName,
            columnName: options.columnName || propertyName,
            type: options.type || "text", // Default type, will be inferred later if possible
            isPrimaryKey: options.isPrimaryKey || false,
            isNullable: options.isNullable || false,
            isAutoIncrement: options.isAutoIncrement,
            defaultValue: options.defaultValue,
            isComputed: options.isComputed,
            computedColumnSql: options.computedColumnSql,
            isShadowProperty: options.isShadowProperty,
            hasConversion: options.hasConversion,
            convertToDb: options.convertToDb,
            convertFromDb: options.convertFromDb,
            isConcurrencyToken: options.isConcurrencyToken,
        });
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    addRelation(target: Function, relation: RelationMetadata) {
        let entity = this.entities.find((e) => e.target === target);
        if (!entity) {
            entity = {
                target,
                tableName: target.name.toLowerCase(),
                columns: [],
                relations: [],
                indexes: [],
                uniqueConstraints: [],
            };
            this.entities.push(entity);
        }

        entity.relations.push(relation);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    addIndex(target: Function, index: IndexMetadata) {
        let entity = this.entities.find((e) => e.target === target);
        if (!entity) {
            entity = {
                target,
                tableName: target.name.toLowerCase(),
                columns: [],
                relations: [],
                indexes: [],
                uniqueConstraints: [],
            };
            this.entities.push(entity);
        }

        entity.indexes.push(index);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    addUniqueConstraint(target: Function, constraint: UniqueConstraintMetadata) {
        let entity = this.entities.find((e) => e.target === target);
        if (!entity) {
            entity = {
                target,
                tableName: target.name.toLowerCase(),
                columns: [],
                relations: [],
                indexes: [],
                uniqueConstraints: [],
            };
            this.entities.push(entity);
        }

        entity.uniqueConstraints.push(constraint);
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    getEntity(target: Function): EntityMetadata | undefined {
        return this.entities.find((e) => e.target === target);
    }

    getEntities(): EntityMetadata[] {
        return this.entities;
    }

    /**
     * Reset the metadata storage. Useful for test isolation.
     */
    static reset(): void {
        MetadataStorage.instance = new MetadataStorage();
    }
}
