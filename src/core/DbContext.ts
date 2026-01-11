import { DbSet } from "./DbSet";
import { IDatabaseProvider, QueryResult } from "../providers/IDatabaseProvider";
import { RelationType, MetadataStorage } from "./MetadataStorage";
import { ModelBuilder } from "./ModelBuilder";
import { ChangeTracker } from "./ChangeTracker";
import { EntityEntry, EntityState } from "./EntityEntry";
import { Logger, createLogger, ConsoleLogger } from "../utils/logger";

/**
 * Options for configuring the DbContext
 */
export interface DbContextOptions {
    /**
     * Custom logger instance. If not provided, a default logger will be created.
     */
    logger?: Logger;

    /**
     * Connection retry configuration
     */
    retry?: {
        /**
         * Maximum number of connection retry attempts (default: 3)
         */
        maxRetries?: number;

        /**
         * Initial delay in milliseconds before first retry (default: 1000)
         */
        initialDelay?: number;

        /**
         * Multiplier for exponential backoff (default: 2)
         */
        backoffMultiplier?: number;
    };

    /**
     * Graceful shutdown timeout in milliseconds (default: 30000)
     */
    shutdownTimeout?: number;
}

/**
 * Represents a session with the database and can be used to query and save instances of your entities.
 */
export class DbContext {
    protected provider: IDatabaseProvider;
    private _changeTracker: ChangeTracker;
    protected logger: Logger;
    private options: DbContextOptions;
    private isShuttingDown: boolean = false;

    constructor(provider: IDatabaseProvider, options?: DbContextOptions) {
        this.provider = provider;
        this._changeTracker = new ChangeTracker();
        this.options = options || {};
        this.logger = options?.logger || (process.env.NODE_ENV === 'production' ? createLogger() : new ConsoleLogger());

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
     * Connects to the database with automatic retry logic.
     */
    async connect(): Promise<void> {
        const maxRetries = this.options.retry?.maxRetries ?? 3;
        const initialDelay = this.options.retry?.initialDelay ?? 1000;
        const backoffMultiplier = this.options.retry?.backoffMultiplier ?? 2;

        let attempt = 0;
        while (attempt < maxRetries) {
            try {
                await this.provider.connect();
                this.logger.info('Database connected successfully', {
                    provider: this.provider.type,
                    attempt: attempt + 1
                });
                return;
            } catch (error) {
                attempt++;
                const isLastAttempt = attempt >= maxRetries;

                if (isLastAttempt) {
                    this.logger.error('Failed to connect after max retries', error as Error, {
                        provider: this.provider.type,
                        maxRetries,
                        attempts: attempt
                    });
                    throw error;
                }

                const delay = initialDelay * Math.pow(backoffMultiplier, attempt - 1);
                this.logger.warn(`Connection failed, retrying...`, {
                    provider: this.provider.type,
                    attempt,
                    maxRetries,
                    nextRetryIn: `${delay}ms`,
                    error: (error as Error).message
                });

                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    /**
     * Disconnects from the database.
     */
    async disconnect(): Promise<void> {
        try {
            await this.provider.disconnect();
            this.logger.info('Database disconnected successfully');
        } catch (error) {
            this.logger.error('Error during disconnect', error as Error);
            throw error;
        }
    }

    /**
     * Performs a graceful shutdown of the database context.
     * Saves pending changes and disconnects from the database.
     * @param timeout Maximum time to wait for shutdown in milliseconds (default: 30000)
     */
    async gracefulShutdown(timeout?: number): Promise<void> {
        if (this.isShuttingDown) {
            this.logger.warn('Shutdown already in progress');
            return;
        }

        this.isShuttingDown = true;
        const shutdownTimeout = timeout ?? this.options.shutdownTimeout ?? 30000;

        this.logger.info('Starting graceful shutdown', { timeout: shutdownTimeout });

        const shutdownPromise = (async () => {
            try {
                // Get pending changes count
                const stats = this._changeTracker.getStatistics();
                const hasPendingChanges = stats.added > 0 || stats.modified > 0 || stats.deleted > 0;

                if (hasPendingChanges) {
                    this.logger.warn('Saving pending changes before shutdown', { stats });
                    await this.saveChanges();
                }

                // Disconnect from database
                await this.disconnect();

                this.logger.info('Graceful shutdown completed successfully');
            } catch (error) {
                this.logger.error('Error during graceful shutdown', error as Error);
                throw error;
            } finally {
                this.isShuttingDown = false;
            }
        })();

        const timeoutPromise = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`Shutdown timeout exceeded (${shutdownTimeout}ms)`)), shutdownTimeout)
        );

        try {
            await Promise.race([shutdownPromise, timeoutPromise]);
        } catch (error) {
            this.isShuttingDown = false;
            this.logger.error('Graceful shutdown failed', error as Error, { timeout: shutdownTimeout });
            throw error;
        }
    }

    /**
     * Get connection pool statistics (if available)
     * @returns Pool statistics or null if not supported by the provider
     */
    getPoolStats() {
        if (this.provider.getPoolStats) {
            return this.provider.getPoolStats();
        }
        return null;
    }

    async query(text: string, params?: any[]): Promise<QueryResult> {
        return await this.provider.query(text, params);
    }

    /**
     * Executes raw SQL against the database and returns the number of rows affected
     * Use this for UPDATE, DELETE, or other non-query operations
     * @param sql Raw SQL statement
     * @param parameters Optional parameters for the query
     * @returns Number of rows affected
     * @example
     * const rowsAffected = await db.executeSqlRaw(
     *     'UPDATE users SET status = $1 WHERE created_at < $2',
     *     ['inactive', '2020-01-01']
     * );
     */
    async executeSqlRaw(sql: string, parameters?: any[]): Promise<number> {
        const result = await this.provider.query(sql, parameters);
        return result.rowCount;
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
        const stats = this._changeTracker.getStatistics();

        if (changedEntries.length === 0) {
            this.logger.debug('No changes to save');
            return 0;
        }

        this.logger.debug('Saving changes to database', { stats });

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
                    this.logger.warn(`No metadata found for entity ${entityType.name}`);
                    continue;
                }

                const tableName = metadata.tableName;
                const pkColumn = metadata.columns.find(c => c.isPrimaryKey);

                if (!pkColumn) {
                    this.logger.warn(`No primary key found for entity ${entityType.name}`);
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

            this.logger.info('Changes saved successfully', {
                inserted: stats.added,
                updated: stats.modified,
                deleted: stats.deleted,
                total: savedCount
            });

            return savedCount;
        } catch (error) {
            // Rollback on error
            await this.rollbackTransaction();

            this.logger.error('Failed to save changes, transaction rolled back', error as Error, {
                stats,
                changedEntries: changedEntries.length
            });

            throw error;
        }
    }

    /**
     * Insert a new entity
     */
    private async insertEntity(entity: any, metadata: any, tableName: string): Promise<void> {
        const columns = metadata.columns.filter((c: any) => {
            // Skip shadow properties
            if (c.isShadowProperty) return true;

            const value = entity[c.propertyName];
            // Skip auto-increment primary keys with undefined/null values
            return !(c.isPrimaryKey && c.isAutoIncrement && (value === undefined || value === null));
        });

        const columnNames = columns.map((c: any) => c.columnName);
        const values = columns.map((c: any) => {
            let value = c.isShadowProperty ? c.defaultValue : entity[c.propertyName];

            // Apply value conversion from entity to database
            if (c.hasConversion && c.convertToDb && value !== undefined && value !== null) {
                value = c.convertToDb(value);
            }

            return value;
        });

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

        // Find concurrency token columns
        const concurrencyTokens = metadata.columns.filter((c: any) => c.isConcurrencyToken);

        for (const propName of modifiedProperties) {
            const column = metadata.columns.find((c: any) => c.propertyName === propName);
            if (column && !column.isPrimaryKey && !column.isConcurrencyToken) {
                setClause.push(`${column.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`);

                let value = entity[propName];

                // Apply value conversion from entity to database
                if (column.hasConversion && column.convertToDb && value !== undefined && value !== null) {
                    value = column.convertToDb(value);
                }

                values.push(value);
            }
        }

        // Auto-increment concurrency tokens
        for (const token of concurrencyTokens) {
            const currentValue = entity[token.propertyName];
            const newValue = typeof currentValue === 'number' ? currentValue + 1 : 1;
            setClause.push(`${token.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`);
            values.push(newValue);
            // Update the entity with new token value
            entity[token.propertyName] = newValue;
        }

        if (setClause.length === 0) {
            return; // No non-PK columns to update
        }

        let pkValue = entity[pkColumn.propertyName];

        // Apply value conversion to primary key if needed
        if (pkColumn.hasConversion && pkColumn.convertToDb && pkValue !== undefined && pkValue !== null) {
            pkValue = pkColumn.convertToDb(pkValue);
        }

        values.push(pkValue);

        // Build WHERE clause with PK
        let whereClause = `${pkColumn.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`;

        // Add concurrency token checks to WHERE clause
        for (const token of concurrencyTokens) {
            const originalValue = entry.originalValues[token.propertyName];
            whereClause += ` AND ${token.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`;
            values.push(originalValue);
        }

        const sql = `UPDATE ${tableName} SET ${setClause.join(', ')} WHERE ${whereClause}`;

        const result = await this.provider.query(sql, values);

        // Check if update affected any rows (concurrency check)
        if (result.rowCount === 0) {
            const entityName = metadata.target.name;
            const pkValue = entity[pkColumn.propertyName];
            let errorMessage = `Concurrency violation detected for ${entityName} (${pkColumn.propertyName}=${pkValue}): The entity has been modified or deleted by another user.`;

            if (concurrencyTokens.length > 0) {
                const tokenInfo = concurrencyTokens.map((token: any) => {
                    const current = entity[token.propertyName];
                    const original = entry.originalValues[token.propertyName];
                    return `${token.propertyName}: expected=${original}, current=${current}`;
                }).join(', ');
                errorMessage += ` Concurrency tokens: ${tokenInfo}`;
            }

            throw new Error(errorMessage);
        }
    }

    /**
     * Delete an entity
     */
    private async deleteEntity(entity: any, metadata: any, tableName: string, pkColumn: any): Promise<void> {
        let pkValue = entity[pkColumn.propertyName];

        // Apply value conversion to primary key if needed
        if (pkColumn.hasConversion && pkColumn.convertToDb && pkValue !== undefined && pkValue !== null) {
            pkValue = pkColumn.convertToDb(pkValue);
        }

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
        this.logger.info('Creating tables...');
        for (const entity of entities) {
            // Skip keyless entities (they're typically views or query types)
            if (entity.isKeyless) {
                this.logger.debug(`Skipping keyless entity: ${entity.tableName}`);
                continue;
            }

            const createTableSql = this.provider.generateCreateTableSql(entity);
            await this.query(createTableSql);
        }

        // Phase 2: Create join tables for Many-to-Many relationships
        this.logger.info('Creating join tables for many-to-many relationships...');
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
        this.logger.info('Creating foreign key constraints...');
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
                                    this.logger.warn(`Could not create foreign key constraint`, {
                                        error: error.message,
                                        relation: relation.propertyName
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }

        // Phase 4: Create indexes
        this.logger.info('Creating indexes...');
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
                        this.logger.warn(`Could not create index`, {
                            error: error.message,
                            table: entity.tableName,
                            index: indexName
                        });
                    }
                }
            }
        }

        // Phase 5: Create unique constraints
        this.logger.info('Creating unique constraints...');
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
                        this.logger.warn(`Could not create unique constraint`, {
                            error: error.message,
                            table: entity.tableName,
                            constraint: constraintName
                        });
                    }
                }
            }
        }

        // Phase 6: Schema Evolution - Check for missing columns and type mismatches
        this.logger.info('Checking for schema evolution...');
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
                    this.logger.info(`Detected missing column, adding it...`, {
                        column: col.columnName,
                        table: entity.tableName
                    });
                    const alterTableSql = this.provider.generateAddColumnSql(entity.tableName, col);
                    await this.query(alterTableSql);
                } else {
                    // Check for type mismatch using provider
                    if (this.provider.isTypeMismatch(col.type, existingType)) {
                        this.logger.warn(`Type mismatch detected, attempting migration...`, {
                            column: col.columnName,
                            dbType: existingType,
                            entityType: col.type
                        });
                        try {
                            const alterColumnSql = this.provider.generateAlterColumnTypeSql(entity.tableName, col);
                            await this.query(alterColumnSql);
                            this.logger.info(`Successfully migrated column type`, {
                                column: col.columnName,
                                newType: col.type
                            });
                        } catch (error: any) {
                            this.logger.error(`Failed to migrate column type, data might be incompatible`, error as Error, {
                                column: col.columnName,
                                fromType: existingType,
                                toType: col.type
                            });
                        }
                    }
                }
            }
        }

        // Phase 7: Seed Data
        this.logger.info('Seeding data...');
        for (const entity of entities) {
            if (entity.seedData && entity.seedData.length > 0) {
                const tableName = entity.tableName;
                const pkColumn = entity.columns.find(c => c.isPrimaryKey);

                if (!pkColumn) {
                    this.logger.warn(`Skipping seed, no primary key found`, {
                        table: entity.tableName
                    });
                    continue;
                }

                // Check if data already exists
                for (const seedItem of entity.seedData) {
                    const pkValue = (seedItem as any)[pkColumn.propertyName];

                    if (pkValue !== undefined) {
                        // Check if record exists
                        const placeholder = this.provider.getParameterPlaceholder(1);
                        const checkSql = `SELECT COUNT(*) as count FROM ${tableName} WHERE ${pkColumn.columnName} = ${placeholder}`;
                        const result = await this.query(checkSql, [pkValue]);
                        const exists = parseInt(result.rows[0].count) > 0;

                        if (!exists) {
                            // Insert seed data
                            const columns = entity.columns.filter(c =>
                                (seedItem as any)[c.propertyName] !== undefined || c.isShadowProperty
                            );

                            const columnNames = columns.map(c => c.columnName);
                            const values = columns.map(c => {
                                let value = c.isShadowProperty ? c.defaultValue : (seedItem as any)[c.propertyName];

                                // Apply value conversion from entity to database
                                if (c.hasConversion && c.convertToDb && value !== undefined && value !== null) {
                                    value = c.convertToDb(value);
                                }

                                return value;
                            });
                            const placeholders = values.map((_: any, i: number) =>
                                this.provider.getParameterPlaceholder(i + 1)
                            );

                            const insertSql = `INSERT INTO ${tableName} (${columnNames.join(', ')})VALUES (${placeholders.join(', ')})`;
                            await this.query(insertSql, values);
                            this.logger.debug(`Seeded data`, {
                                table: tableName,
                                data: seedItem
                            });
                        }
                    }
                }
            }
        }

        this.logger.info('Database schema is up to date!');
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
