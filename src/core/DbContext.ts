import { DbSet } from "./DbSet";
import { IDatabaseProvider, QueryResult } from "../providers/IDatabaseProvider";
import { RelationType, MetadataStorage } from "./MetadataStorage";
import { ModelBuilder } from "./ModelBuilder";
import { ChangeTracker } from "./ChangeTracker";
import { EntityEntry, EntityState } from "./EntityEntry";

/**
 * Represents a session with the database and can be used to query and save instances of your entities.
 */
export class DbContext {
    protected provider: IDatabaseProvider;
    private _changeTracker: ChangeTracker;

    constructor(provider: IDatabaseProvider) {
        this.provider = provider;
        this._changeTracker = new ChangeTracker();

        // Configure the model using Fluent API
        const modelBuilder = new ModelBuilder();
        this.onModelCreating(modelBuilder);
    }

    /**
     * Gets the change tracker for this context
     */
    get changeTracker(): ChangeTracker {
        return this._changeTracker;
    }

    /**
     * Override this method to configure the model using the Fluent API.
     * This is called automatically when the DbContext is constructed.
     * @param modelBuilder The builder used to configure entities
     * @example
     * protected onModelCreating(modelBuilder: ModelBuilder): void {
     *     modelBuilder.entity(User)
     *         .toTable('users')
     *         .hasKey(u => u.id)
     *         .property(u => u.email).isRequired().hasMaxLength(255);
     * }
     */
    protected onModelCreating(modelBuilder: ModelBuilder): void {
        // Override this method in derived classes to configure entities
    }

    /**
     * Connects to the database.
     */
    async connect(): Promise<void> {
        await this.provider.connect();
    }

    async disconnect(): Promise<void> {
        await this.provider.disconnect();
    }

    async query(text: string, params?: any[]): Promise<QueryResult> {
        return await this.provider.query(text, params);
    }

    // Transaction management
    async beginTransaction() {
        await this.provider.beginTransaction();
    }

    async commitTransaction() {
        await this.provider.commitTransaction();
    }

    async rollbackTransaction() {
        await this.provider.rollbackTransaction();
    }

    /**
     * Saves all changes made in this context to the database.
     * This method will automatically detect changes made to tracked entities.
     * @returns The number of state entries written to the database
     */
    async saveChanges(): Promise<number> {
        // Detect changes if auto-detect is enabled
        if (this._changeTracker.autoDetectChangesEnabled) {
            this._changeTracker.detectChanges();
        }

        const changedEntries = this._changeTracker.getChangedEntries();

        if (changedEntries.length === 0) {
            return 0;
        }

        let savedCount = 0;

        try {
            // Begin transaction
            await this.beginTransaction();

            // Process all changes
            for (const entry of changedEntries) {
                const entity = entry.entity;
                const entityType = entity.constructor;
                const metadata = MetadataStorage.get().getEntity(entityType);

                if (!metadata) {
                    console.warn(`No metadata found for entity ${entityType.name}`);
                    continue;
                }

                const tableName = metadata.tableName;
                const pkColumn = metadata.columns.find(c => c.isPrimaryKey);

                if (!pkColumn) {
                    console.warn(`No primary key found for entity ${entityType.name}`);
                    continue;
                }

                switch (entry.state) {
                    case EntityState.Added:
                        await this.insertEntity(entity, metadata, tableName);
                        savedCount++;
                        break;

                    case EntityState.Modified:
                        await this.updateEntity(entity, entry, metadata, tableName, pkColumn);
                        savedCount++;
                        break;

                    case EntityState.Deleted:
                        await this.deleteEntity(entity, metadata, tableName, pkColumn);
                        savedCount++;
                        break;
                }
            }

            // Commit transaction
            await this.commitTransaction();

            // Accept all changes
            this._changeTracker.acceptAllChanges();

            return savedCount;
        } catch (error) {
            // Rollback on error
            await this.rollbackTransaction();
            throw error;
        }
    }

    /**
     * Insert a new entity
     */
    private async insertEntity(entity: any, metadata: any, tableName: string): Promise<void> {
        const columns = metadata.columns.filter((c: any) => {
            const value = entity[c.propertyName];
            // Skip auto-increment primary keys with undefined/null values
            return !(c.isPrimaryKey && c.isAutoIncrement && (value === undefined || value === null));
        });

        const columnNames = columns.map((c: any) => c.columnName);
        const values = columns.map((c: any) => entity[c.propertyName]);

        const placeholders = values.map((_: any, i: number) => this.provider.getParameterPlaceholder(i + 1));

        const sql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`;

        const result = await this.provider.query(sql, values);

        // Set auto-increment ID if applicable
        const pkColumn = metadata.columns.find((c: any) => c.isPrimaryKey && c.isAutoIncrement);
        if (pkColumn && result.insertId !== undefined) {
            entity[pkColumn.propertyName] = result.insertId;
        }
    }

    /**
     * Update an existing entity
     */
    private async updateEntity(entity: any, entry: EntityEntry<any>, metadata: any, tableName: string, pkColumn: any): Promise<void> {
        const modifiedProperties = entry.getModifiedProperties();

        if (modifiedProperties.length === 0) {
            return; // Nothing to update
        }

        const setClause: string[] = [];
        const values: any[] = [];
        let paramIndex = 1;

        for (const propName of modifiedProperties) {
            const column = metadata.columns.find((c: any) => c.propertyName === propName);
            if (column && !column.isPrimaryKey) {
                setClause.push(`${column.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`);
                values.push(entity[propName]);
            }
        }

        if (setClause.length === 0) {
            return; // No non-PK columns to update
        }

        values.push(entity[pkColumn.propertyName]);

        const sql = `UPDATE ${tableName} SET ${setClause.join(', ')} WHERE ${pkColumn.columnName} = ${this.provider.getParameterPlaceholder(paramIndex)}`;

        await this.provider.query(sql, values);
    }

    /**
     * Delete an entity
     */
    private async deleteEntity(entity: any, metadata: any, tableName: string, pkColumn: any): Promise<void> {
        const pkValue = entity[pkColumn.propertyName];
        const placeholder = this.provider.getParameterPlaceholder(1);

        const sql = `DELETE FROM ${tableName} WHERE ${pkColumn.columnName} = ${placeholder}`;

        await this.provider.query(sql, [pkValue]);
    }

    /**
     * Attach an entity to the context with the specified state
     */
    attach<T>(entity: T, state: EntityState = EntityState.Unchanged): EntityEntry<T> {
        return this._changeTracker.track(entity, state);
    }

    /**
     * Get the entry for an entity, or create one if it doesn't exist
     */
    entry<T>(entity: T): EntityEntry<T> {
        let entry = this._changeTracker.entry(entity);

        if (!entry) {
            entry = this._changeTracker.track(entity, EntityState.Detached);
        }

        return entry;
    }

    async ensureCreated(): Promise<void> {
        const { MetadataStorage } = await import("./MetadataStorage");
        const entities = MetadataStorage.get().getEntities();

        // Phase 1: Create all tables first (without foreign keys)
        console.log('Creating tables...');
        for (const entity of entities) {
            const createTableSql = this.provider.generateCreateTableSql(entity);
            await this.query(createTableSql);
        }

        // Phase 2: Create join tables for Many-to-Many relationships
        console.log('Creating join tables for many-to-many relationships...');
        const createdJoinTables = new Set<string>();

        for (const entity of entities) {
            for (const relation of entity.relations) {
                if (relation.relationType === RelationType.ManyToMany && relation.joinTable) {
                    // Only create each join table once
                    if (!createdJoinTables.has(relation.joinTable)) {
                        const relatedEntity = relation.relatedEntity();
                        const relatedMetadata = MetadataStorage.get().getEntity(relatedEntity);

                        if (relatedMetadata && relation.joinColumn && relation.inverseJoinColumn) {
                            const joinTableSql = this.provider.generateCreateJoinTableSql(
                                relation.joinTable,
                                relation.joinColumn,
                                relation.inverseJoinColumn,
                                entity.tableName,
                                relatedMetadata.tableName,
                                relation.onDelete
                            );

                            await this.query(joinTableSql);
                            createdJoinTables.add(relation.joinTable);
                        }
                    }
                }
            }
        }

        // Phase 3: Add foreign key constraints for ManyToOne and OneToOne relationships
        console.log('Creating foreign key constraints...');
        for (const entity of entities) {
            for (const relation of entity.relations) {
                if ((relation.relationType === RelationType.ManyToOne || relation.relationType === RelationType.OneToOne) && relation.foreignKeyColumn) {
                    const relatedEntity = relation.relatedEntity();
                    const relatedMetadata = MetadataStorage.get().getEntity(relatedEntity);

                    if (relatedMetadata) {
                        const pkColumn = relatedMetadata.columns.find(c => c.isPrimaryKey);
                        if (pkColumn) {
                            try {
                                const fkSql = this.provider.generateAddForeignKeySql(
                                    entity.tableName,
                                    relation.foreignKeyColumn,
                                    relatedMetadata.tableName,
                                    pkColumn.columnName,
                                    relation.onDelete,
                                    relation.onUpdate
                                );

                                await this.query(fkSql);
                            } catch (error: any) {
                                // Foreign key constraint might already exist
                                if (!error.message.includes('already exists')) {
                                    console.warn(`Warning: Could not create foreign key constraint: ${error.message}`);
                                }
                            }
                        }
                    }
                }
            }
        }

        // Phase 4: Create indexes
        console.log('Creating indexes...');
        for (const entity of entities) {
            for (const index of entity.indexes) {
                const indexName = index.name || `idx_${entity.tableName}_${index.columns.join('_')}`;
                try {
                    const indexSql = this.provider.generateCreateIndexSql(
                        entity.tableName,
                        indexName,
                        index.columns,
                        index.unique
                    );

                    await this.query(indexSql);
                } catch (error: any) {
                    // Index might already exist
                    if (!error.message.includes('already exists')) {
                        console.warn(`Warning: Could not create index: ${error.message}`);
                    }
                }
            }
        }

        // Phase 5: Create unique constraints
        console.log('Creating unique constraints...');
        for (const entity of entities) {
            for (const constraint of entity.uniqueConstraints) {
                const constraintName = constraint.name || `uq_${entity.tableName}_${constraint.columns.join('_')}`;
                try {
                    const constraintSql = this.provider.generateCreateUniqueConstraintSql(
                        entity.tableName,
                        constraintName,
                        constraint.columns
                    );

                    await this.query(constraintSql);
                } catch (error: any) {
                    // Constraint might already exist
                    if (!error.message.includes('already exists')) {
                        console.warn(`Warning: Could not create unique constraint: ${error.message}`);
                    }
                }
            }
        }

        // Phase 6: Schema Evolution - Check for missing columns and type mismatches
        console.log('Checking for schema evolution...');
        for (const entity of entities) {
            const schemaQuery = this.provider.getSchemaColumnsQuery(entity.tableName);
            const existingColumnsRes = await this.query(schemaQuery.sql, schemaQuery.params);

            const existingColumns = new Map(
                existingColumnsRes.rows.map((r: any) => [
                    r.column_name.toLowerCase(),
                    r.data_type.toLowerCase()
                ])
            );

            for (const col of entity.columns) {
                const colName = col.columnName.toLowerCase();
                const existingType = existingColumns.get(colName);

                if (!existingType) {
                    console.log(`Detected missing column '${col.columnName}' in table '${entity.tableName}'. Adding it...`);
                    const alterTableSql = this.provider.generateAddColumnSql(entity.tableName, col);
                    await this.query(alterTableSql);
                } else {
                    // Check for type mismatch using provider
                    if (this.provider.isTypeMismatch(col.type, existingType)) {
                        console.warn(`WARNING: Type mismatch detected for column '${col.columnName}'. DB: '${existingType}', Entity: '${col.type}'. Attempting migration...`);
                        try {
                            const alterColumnSql = this.provider.generateAlterColumnTypeSql(entity.tableName, col);
                            await this.query(alterColumnSql);
                            console.log(`SUCCESS: Migrated column '${col.columnName}' to '${col.type}'.`);
                        } catch (error: any) {
                            console.error(`ERROR: Failed to migrate column '${col.columnName}' from '${existingType}' to '${col.type}'. Data might be incompatible.`);
                            console.error(`Details: ${error.message}`);
                        }
                    }
                }
            }
        }

        console.log('Database schema is up to date!');
    }

    set<T>(entityType: new () => T): DbSet<T> {
        return new DbSet(entityType, this);
    }

    /**
     * Gets the database provider instance
     * @internal
     */
    getProvider(): IDatabaseProvider {
        return this.provider;
    }
}
