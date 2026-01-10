import { MetadataStorage, RelationType, CascadeOption } from "./MetadataStorage";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Constructor<T = any> = new (...args: any[]) => T;

/**
 * Builder for configuring entity properties
 */
export class PropertyBuilder<T, TProp> {
    constructor(
        private entityType: Constructor<T>,
        private propertyName: string
    ) {}

    /**
     * Marks the property as required (NOT NULL)
     */
    isRequired(): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.isNullable = false;
            }
        }
        return this;
    }

    /**
     * Marks the property as optional (nullable)
     */
    isOptional(): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.isNullable = true;
            }
        }
        return this;
    }

    /**
     * Sets the maximum length for string properties
     */
    hasMaxLength(length: number): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.type = `varchar(${length})`;
            }
        }
        return this;
    }

    /**
     * Sets the column name in the database
     */
    hasColumnName(name: string): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.columnName = name;
            }
        }
        return this;
    }

    /**
     * Sets the column type in the database
     */
    hasColumnType(type: string): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.type = type;
            }
        }
        return this;
    }

    /**
     * Sets a default value for the column
     * @param value Default value (can be a constant or SQL expression)
     * @example
     * property(u => u.createdAt).hasDefaultValue('CURRENT_TIMESTAMP')
     * property(u => u.isActive).hasDefaultValue(true)
     */
    hasDefaultValue(value: any): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.defaultValue = value;
            }
        }
        return this;
    }

    /**
     * Marks the column as computed with SQL expression
     * @param sql SQL expression for computed column
     * @example
     * property(u => u.fullName).hasComputedColumnSql("CONCAT(first_name, ' ', last_name)")
     */
    hasComputedColumnSql(sql: string): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.isComputed = true;
                column.computedColumnSql = sql;
            }
        }
        return this;
    }

    /**
     * Configures value conversion for this property
     * @param convertToDb Function to convert from entity value to database value
     * @param convertFromDb Function to convert from database value to entity value
     * @example
     * // Store enum as string
     * property(u => u.role).hasConversion(
     *     role => role.toString(),
     *     value => UserRole[value as keyof typeof UserRole]
     * )
     */
    hasConversion<TProperty, TProvider>(
        convertToDb: (value: TProperty) => TProvider,
        convertFromDb: (value: TProvider) => TProperty
    ): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.hasConversion = true;
                column.convertToDb = convertToDb as any;
                column.convertFromDb = convertFromDb as any;
            }
        }
        return this;
    }

    /**
     * Marks this property as a concurrency token for optimistic locking
     * The property will be checked during updates to ensure no concurrent modifications
     * @example
     * property(u => u.rowVersion).isConcurrencyToken()
     */
    isConcurrencyToken(): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const column = metadata.columns.find(c => c.propertyName === this.propertyName);
            if (column) {
                column.isConcurrencyToken = true;
            }
        }
        return this;
    }
}

/**
 * Builder for configuring entity relationships
 */
export class RelationshipBuilder<T, TRelated> {
    constructor(
        private entityType: Constructor<T>,
        private propertyName: string,
        private relatedEntityType: Constructor<TRelated>,
        private relationType: RelationType
    ) {}

    /**
     * Sets the foreign key column name
     */
    hasForeignKey(columnName: string): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const relation = metadata.relations.find(r => r.propertyName === this.propertyName);
            if (relation) {
                relation.foreignKeyColumn = columnName;
            }
        }
        return this;
    }

    /**
     * Sets the inverse navigation property
     */
    withMany(inverseProperty?: (entity: TRelated) => any): this {
        if (inverseProperty) {
            const inverseName = extractPropertyName(inverseProperty);
            const metadata = MetadataStorage.get().getEntity(this.entityType);
            if (metadata) {
                const relation = metadata.relations.find(r => r.propertyName === this.propertyName);
                if (relation) {
                    relation.inverseSide = inverseName;
                }
            }
        }
        return this;
    }

    /**
     * Sets the inverse navigation property for one-to-one
     */
    withOne(inverseProperty?: (entity: TRelated) => any): this {
        if (inverseProperty) {
            const inverseName = extractPropertyName(inverseProperty);
            const metadata = MetadataStorage.get().getEntity(this.entityType);
            if (metadata) {
                const relation = metadata.relations.find(r => r.propertyName === this.propertyName);
                if (relation) {
                    relation.inverseSide = inverseName;
                }
            }
        }
        return this;
    }

    /**
     * Sets ON DELETE behavior
     */
    onDelete(action: CascadeOption): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const relation = metadata.relations.find(r => r.propertyName === this.propertyName);
            if (relation) {
                relation.onDelete = action;
            }
        }
        return this;
    }

    /**
     * Sets ON UPDATE behavior
     */
    onUpdate(action: CascadeOption): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const relation = metadata.relations.find(r => r.propertyName === this.propertyName);
            if (relation) {
                relation.onUpdate = action;
            }
        }
        return this;
    }

    /**
     * Configures the join table for many-to-many relationships
     */
    usingJoinTable(tableName: string, leftKey: string, rightKey: string): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const relation = metadata.relations.find(r => r.propertyName === this.propertyName);
            if (relation) {
                relation.joinTable = tableName;
                relation.joinColumn = leftKey;
                relation.inverseJoinColumn = rightKey;
            }
        }
        return this;
    }
}

/**
 * Builder for configuring an entity type
 */
export class EntityTypeBuilder<T> {
    constructor(private entityType: new () => T) {}

    /**
     * Sets the table name in the database
     */
    toTable(tableName: string): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            metadata.tableName = tableName;
        }
        return this;
    }

    /**
     * Configures the primary key
     */
    hasKey(selector: (entity: T) => any): this {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            // Clear existing primary keys
            metadata.columns.forEach(c => c.isPrimaryKey = false);
            // Set new primary key
            const column = metadata.columns.find(c => c.propertyName === propertyName);
            if (column) {
                column.isPrimaryKey = true;
            }
        }
        return this;
    }

    /**
     * Marks this entity as keyless (no primary key)
     * Keyless entities are useful for database views, query types, or read-only entities
     * @example
     * modelBuilder.entity(ProductSummary)
     *     .hasNoKey()
     *     .toTable('vw_product_summary'); // Database view
     */
    hasNoKey(): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            metadata.isKeyless = true;
            // Clear any existing primary keys
            metadata.columns.forEach(c => c.isPrimaryKey = false);
        }
        return this;
    }

    /**
     * Configures a property
     */
    property<TProp>(selector: (entity: T) => TProp): PropertyBuilder<T, TProp> {
        const propertyName = extractPropertyName(selector);
        return new PropertyBuilder<T, TProp>(this.entityType, propertyName);
    }

    /**
     * Configures an index
     */
    hasIndex(selector: (entity: T) => any, options?: { unique?: boolean; name?: string }): this {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const existingIndex = metadata.indexes.find(idx =>
                idx.columns.length === 1 && idx.columns[0] === propertyName
            );
            if (!existingIndex) {
                metadata.indexes.push({
                    target: this.entityType,
                    columns: [propertyName],
                    unique: options?.unique || false,
                    name: options?.name
                });
            }
        }
        return this;
    }

    /**
     * Configures a composite index
     */
    hasCompositeIndex(selectors: Array<(entity: T) => any>, options?: { unique?: boolean; name?: string }): this {
        const propertyNames = selectors.map(s => extractPropertyName(s));
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            metadata.indexes.push({
                target: this.entityType,
                columns: propertyNames,
                unique: options?.unique || false,
                name: options?.name
            });
        }
        return this;
    }

    /**
     * Configures a unique constraint
     */
    hasUnique(selector: (entity: T) => any, options?: { name?: string }): this {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const existingConstraint = metadata.uniqueConstraints.find(uc =>
                uc.columns.length === 1 && uc.columns[0] === propertyName
            );
            if (!existingConstraint) {
                metadata.uniqueConstraints.push({
                    target: this.entityType,
                    columns: [propertyName],
                    name: options?.name
                });
            }
        }
        return this;
    }

    /**
     * Configures a one-to-many relationship
     */
    hasMany<TRelated>(
        navigationProperty: (entity: T) => TRelated[],
        relatedEntityType: new () => TRelated
    ): RelationshipBuilder<T, TRelated> {
        const propertyName = extractPropertyName(navigationProperty);

        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const existingRelation = metadata.relations.find(r => r.propertyName === propertyName);
            if (!existingRelation) {
                metadata.relations.push({
                    target: this.entityType,
                    propertyName,
                    relatedEntity: () => relatedEntityType,
                    relationType: RelationType.OneToMany
                });
            }
        }

        return new RelationshipBuilder<T, TRelated>(
            this.entityType,
            propertyName,
            relatedEntityType,
            RelationType.OneToMany
        );
    }

    /**
     * Configures a many-to-one relationship
     */
    hasOne<TRelated>(
        navigationProperty: (entity: T) => TRelated,
        relatedEntityType: new () => TRelated
    ): RelationshipBuilder<T, TRelated> {
        const propertyName = extractPropertyName(navigationProperty);

        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const existingRelation = metadata.relations.find(r => r.propertyName === propertyName);
            if (!existingRelation) {
                metadata.relations.push({
                    target: this.entityType,
                    propertyName,
                    relatedEntity: () => relatedEntityType,
                    relationType: RelationType.ManyToOne
                });
            }
        }

        return new RelationshipBuilder<T, TRelated>(
            this.entityType,
            propertyName,
            relatedEntityType,
            RelationType.ManyToOne
        );
    }

    /**
     * Configures a many-to-many relationship
     */
    hasManyToMany<TRelated>(
        navigationProperty: (entity: T) => TRelated[],
        relatedEntityType: new () => TRelated,
        options?: { joinTable?: string; leftKey?: string; rightKey?: string }
    ): RelationshipBuilder<T, TRelated> {
        const propertyName = extractPropertyName(navigationProperty);

        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const existingRelation = metadata.relations.find(r => r.propertyName === propertyName);
            if (!existingRelation) {
                const leftEntity = this.entityType.name.toLowerCase();
                const rightEntity = relatedEntityType.name.toLowerCase();

                metadata.relations.push({
                    target: this.entityType,
                    propertyName,
                    relatedEntity: () => relatedEntityType,
                    relationType: RelationType.ManyToMany,
                    joinTable: options?.joinTable || `${leftEntity}_${rightEntity}`,
                    joinColumn: options?.leftKey || `${leftEntity}Id`,
                    inverseJoinColumn: options?.rightKey || `${rightEntity}Id`
                });
            }
        }

        return new RelationshipBuilder<T, TRelated>(
            this.entityType,
            propertyName,
            relatedEntityType,
            RelationType.ManyToMany
        );
    }

    /**
     * Seeds the database with initial data for this entity
     * @param data Array of entity instances to seed
     * @example
     * modelBuilder.entity(User)
     *     .hasData([
     *         { id: 1, name: 'Admin', email: 'admin@example.com' },
     *         { id: 2, name: 'User', email: 'user@example.com' }
     *     ]);
     */
    hasData(data: Partial<T>[]): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            metadata.seedData = data;
        }
        return this;
    }

    /**
     * Configures a global query filter for this entity
     * The filter is automatically applied to all queries
     * @param filter Predicate function to filter entities
     * @example
     * // Soft delete filter
     * modelBuilder.entity(User)
     *     .hasQueryFilter(u => u.isDeleted === false)
     *
     * // Multi-tenancy filter
     * modelBuilder.entity(Order)
     *     .hasQueryFilter(o => o.tenantId === currentTenantId)
     */
    hasQueryFilter(filter: (entity: T) => boolean): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            metadata.queryFilter = filter as any;
        }
        return this;
    }

    /**
     * Defines a shadow property - a column that exists in the database but not on the entity class
     * @param propertyName Name of the shadow property
     * @param columnType Database column type
     * @param options Additional options
     * @example
     * modelBuilder.entity(User)
     *     .shadowProperty('CreatedAt', 'timestamp', { defaultValue: 'CURRENT_TIMESTAMP' })
     *     .shadowProperty('UpdatedAt', 'timestamp')
     */
    shadowProperty(
        propertyName: string,
        columnType: string,
        options?: {
            columnName?: string;
            nullable?: boolean;
            defaultValue?: any;
        }
    ): this {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata) {
            const existing = metadata.columns.find(c => c.propertyName === propertyName);
            if (!existing) {
                metadata.columns.push({
                    target: this.entityType,
                    propertyName,
                    columnName: options?.columnName || propertyName,
                    type: columnType,
                    isPrimaryKey: false,
                    isNullable: options?.nullable !== false,
                    isShadowProperty: true,
                    defaultValue: options?.defaultValue
                });
            }
        }
        return this;
    }

    /**
     * Configures a one-to-one owned entity type
     * Owned entities don't have their own table - they are stored inline with the owner
     * @param navigationProperty Property selector for the owned entity
     * @param ownedEntityType The owned entity type
     * @param options Configuration options
     * @example
     * modelBuilder.entity(Order)
     *     .ownsOne(o => o.shippingAddress, Address, { columnPrefix: 'Shipping' });
     */
    ownsOne<TOwned>(
        navigationProperty: (entity: T) => TOwned,
        ownedEntityType: new () => TOwned,
        options?: {
            columnPrefix?: string;
        }
    ): this {
        const propertyName = extractPropertyName(navigationProperty);
        const metadata = MetadataStorage.get().getEntity(this.entityType);

        if (metadata) {
            if (!metadata.ownedEntities) {
                metadata.ownedEntities = [];
            }

            metadata.ownedEntities.push({
                ownedType: ownedEntityType,
                propertyName,
                columnPrefix: options?.columnPrefix || propertyName
            });
        }

        return this;
    }

    /**
     * Configures a one-to-many owned entity type collection
     * Owned entity collections are stored in a separate table linked to the owner
     * @param navigationProperty Property selector for the owned entity collection
     * @param ownedEntityType The owned entity type
     * @example
     * modelBuilder.entity(Order)
     *     .ownsMany(o => o.orderItems, OrderItem);
     */
    ownsMany<TOwned>(
        navigationProperty: (entity: T) => TOwned[],
        ownedEntityType: new () => TOwned
    ): this {
        const propertyName = extractPropertyName(navigationProperty);
        const metadata = MetadataStorage.get().getEntity(this.entityType);

        if (metadata) {
            // For OwnsMany, create a relation similar to OneToMany
            metadata.relations.push({
                target: this.entityType,
                propertyName,
                relatedEntity: () => ownedEntityType,
                relationType: RelationType.OwnsMany
            });
        }

        return this;
    }
}

/**
 * Main builder for configuring the database model
 */
export class ModelBuilder {
    /**
     * Configures an entity type
     */
    entity<T>(entityType: new () => T): EntityTypeBuilder<T> {
        // Ensure entity is registered in metadata storage
        const metadata = MetadataStorage.get().getEntity(entityType);
        if (!metadata) {
            // Register basic entity metadata if not already registered
            MetadataStorage.get().addEntity(entityType, entityType.name.toLowerCase());
        }
        return new EntityTypeBuilder<T>(entityType);
    }
}

/**
 * Helper function to extract property name from a selector function
 */
function extractPropertyName<T>(selector: (entity: T) => any): string {
    const funcStr = selector.toString();

    // Match: u => u.propertyName or (u) => u.propertyName
    const arrowMatch = funcStr.match(/(?:.*?=>.*?\.)(\w+)/);
    if (arrowMatch) {
        return arrowMatch[1];
    }

    // Match: function(u) { return u.propertyName; }
    const functionMatch = funcStr.match(/return\s+\w+\.(\w+)/);
    if (functionMatch) {
        return functionMatch[1];
    }

    throw new Error(`Cannot extract property name from selector: ${funcStr}`);
}
