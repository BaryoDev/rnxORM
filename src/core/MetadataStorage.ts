import { AsyncLocalStorage } from "async_hooks";

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

/**
 * A structured global query filter condition that can be translated to SQL.
 * `property` is the entity property name (mapped to its column), `operator`
 * is a SQL comparison operator, and `value` is the comparison value. Pass a
 * function to resolve the value at query time (e.g. a current tenant id).
 */
export interface QueryFilterCondition {
    property: string;
    operator: string;
    value: any | (() => any);
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
    queryFilter?: (entity: any) => boolean; // Global query filter evaluated in memory
    queryFilterConditions?: QueryFilterCondition[]; // Global query filter translated to SQL WHERE clauses
    isKeyless?: boolean; // Is this a keyless entity type (for views, query types)
}

export class MetadataStorage {
    /**
     * The registry decorators write into. Every context's model starts as a
     * copy of this, and `onModelCreating` never writes back into it.
     */
    private static instance: MetadataStorage;

    /**
     * The model reads resolve against while a context is active.
     *
     * `MetadataStorage` used to be a single process-wide registry that
     * `onModelCreating` mutated on every construction, so two context types
     * mapping the same entity shared one model and the last one constructed
     * won. An app mapping one entity to per-tenant tables read the wrong
     * tenant's table (issue #32). Each `DbContext` subclass now builds its own
     * model, and reads resolve against whichever context is active.
     */
    private static readonly modelScope = new AsyncLocalStorage<MetadataStorage>();

    private entities: EntityMetadata[] = [];

    private constructor() { }

    /**
     * The metadata to read: the active context's model, or the shared
     * decorator registry when no context is active (during decorator
     * evaluation at class-definition time, for instance).
     */
    static get(): MetadataStorage {
        return MetadataStorage.modelScope.getStore() ?? MetadataStorage.shared();
    }

    /**
     * The shared registry decorators populate, independent of any context.
     */
    static shared(): MetadataStorage {
        if (!MetadataStorage.instance) {
            MetadataStorage.instance = new MetadataStorage();
        }
        return MetadataStorage.instance;
    }

    /**
     * Build a context-scoped model: a deep-enough copy of the decorator
     * registry that `onModelCreating` can retarget tables, add filters, and
     * change columns without touching the shared seed or any other context.
     */
    static createScopedModel(): MetadataStorage {
        const scoped = new MetadataStorage();
        scoped.entities = MetadataStorage.shared().entities.map(cloneEntity);
        return scoped;
    }

    /**
     * Run `fn` with `model` as the metadata reads resolve against, including
     * inside anything `fn` awaits.
     *
     * AsyncLocalStorage rather than a plain variable, because a query resolves
     * metadata after awaiting: two contexts interleaving `await ctx.set(X)`
     * would otherwise see whichever model was assigned last, which is the very
     * bug being fixed.
     */
    static withModel<T>(model: MetadataStorage, fn: () => T): T {
        return MetadataStorage.modelScope.run(model, fn);
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

/**
 * Copy one entity's metadata deeply enough that a context can reconfigure it
 * in isolation. Arrays and the per-column/relation objects are copied; the
 * `target` constructor and any converter functions are shared by reference,
 * since those are identity, not configuration.
 */
function cloneEntity(entity: EntityMetadata): EntityMetadata {
    return {
        ...entity,
        columns: entity.columns.map(c => ({ ...c })),
        relations: entity.relations.map(r => ({ ...r })),
        indexes: entity.indexes.map(i => ({ ...i })),
        uniqueConstraints: entity.uniqueConstraints.map(u => ({ ...u })),
        ownedEntities: entity.ownedEntities?.map(o => ({ ...o })),
        seedData: entity.seedData ? [...entity.seedData] : undefined,
        queryFilterConditions: entity.queryFilterConditions?.map(q => ({ ...q })),
    };
}
