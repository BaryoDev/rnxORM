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

        const changedEntries = this.orderByDependency(this._changeTracker.getChangedEntries());

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
                        this.propagateGeneratedKey(entity);
                        savedCount++;
                        break;

                    case EntityState.Modified:
                        // Count statements actually executed: an entry whose
                        // properties all match its baseline emits no SQL and
                        // must not report as saved (issue #33).
                        if (await this.updateEntity(entity, entry, metadata, tableName, pkColumn)) {
                            savedCount++;
                        }
                        break;

                    case EntityState.Deleted:
                        await this.deleteEntity(entity, entry, metadata, tableName, pkColumn);
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
     * Order entries so a row is never written before the row it points at.
     *
     * Entries used to be processed in Map insertion order, so adding a child
     * before its parent sent the child INSERT first and hit the FK constraint.
     * Inserts are sorted principal-first by a topological sort over the
     * ManyToOne/OneToOne relations between the entity types being saved;
     * deletes take the reverse order, since the dependent row has to go before
     * the row it references (issue #36).
     *
     * A cycle (two types referencing each other) is left in its original order
     * rather than throwing: it cannot be satisfied by ordering alone, and the
     * database will report it more precisely than this could.
     */
    private orderByDependency(entries: EntityEntry<any>[]): EntityEntry<any>[] {
        if (entries.length < 2) return entries;

        const inserts = entries.filter(e => e.state === EntityState.Added);
        const updates = entries.filter(e => e.state === EntityState.Modified);
        const deletes = entries.filter(e => e.state === EntityState.Deleted);

        // A relation whose principal is the same type as its dependent (a category
        // under a category) carries no type-level edge: the edge is between two
        // rows, not two tables. The type sort cannot see it, so the order within
        // one type is settled here, by following each entry's own navigation to
        // the instance it points at.
        const sortWithinType = (group: EntityEntry<any>[]): EntityEntry<any>[] => {
            if (group.length < 2) return group;

            const type = group[0].entity.constructor;
            const metadata = MetadataStorage.get().getEntity(type);
            const selfRelations = (metadata?.relations ?? []).filter(r =>
                (r.relationType === RelationType.ManyToOne || r.relationType === RelationType.OneToOne) &&
                r.relatedEntity() === type);
            if (selfRelations.length === 0) return group;

            const byEntity = new Map<any, EntityEntry<any>>();
            for (const entry of group) byEntity.set(entry.entity, entry);

            // Edge from dependent entry to the principal entry it references, kept
            // only when that principal is in this same batch. A parent that is
            // already stored has its key and needs no ordering.
            const dependsOn = new Map<EntityEntry<any>, Set<EntityEntry<any>>>();
            for (const entry of group) {
                const deps = new Set<EntityEntry<any>>();
                for (const relation of selfRelations) {
                    const target = (entry.entity as any)[relation.propertyName];
                    const principal = target && byEntity.get(target);
                    if (principal && principal !== entry) deps.add(principal);
                }
                dependsOn.set(entry, deps);
            }

            const ordered: EntityEntry<any>[] = [];
            const done = new Set<EntityEntry<any>>();
            const remaining = [...group];
            while (remaining.length > 0) {
                const ready = remaining.filter(e => [...dependsOn.get(e)!].every(d => done.has(d)));
                if (ready.length === 0) {
                    // A cycle between rows, same as the type-level case: leave the
                    // rest alone and let the database report it.
                    ordered.push(...remaining);
                    break;
                }
                for (const entry of ready) {
                    ordered.push(entry);
                    done.add(entry);
                    remaining.splice(remaining.indexOf(entry), 1);
                }
            }
            return ordered;
        };

        const sortPrincipalFirst = (group: EntityEntry<any>[]): EntityEntry<any>[] => {
            if (group.length < 2) return group;

            // Edge from dependent type to the principal type it references.
            const dependsOn = new Map<any, Set<any>>();
            const types = new Set(group.map(e => e.entity.constructor));
            for (const type of types) {
                const metadata = MetadataStorage.get().getEntity(type);
                const deps = new Set<any>();
                for (const relation of metadata?.relations ?? []) {
                    if (relation.relationType !== RelationType.ManyToOne &&
                        relation.relationType !== RelationType.OneToOne) {
                        continue;
                    }
                    const related = relation.relatedEntity();
                    if (types.has(related) && related !== type) {
                        deps.add(related);
                    }
                }
                dependsOn.set(type, deps);
            }

            const ordered: EntityEntry<any>[] = [];
            const done = new Set<any>();
            const remaining = [...types];
            while (remaining.length > 0) {
                const ready = remaining.filter(t => [...dependsOn.get(t)!].every(d => done.has(d)));
                if (ready.length === 0) {
                    // Cycle: emit what is left in its original order.
                    for (const type of remaining) {
                        ordered.push(...group.filter(e => e.entity.constructor === type));
                    }
                    break;
                }
                for (const type of ready) {
                    ordered.push(...sortWithinType(group.filter(e => e.entity.constructor === type)));
                    done.add(type);
                    remaining.splice(remaining.indexOf(type), 1);
                }
            }
            return ordered;
        };

        return [
            ...sortPrincipalFirst(inserts),
            ...updates,
            ...sortPrincipalFirst(deletes).reverse(),
        ];
    }

    /**
     * Copy a just-inserted principal's key onto the foreign-key property of any
     * tracked dependent whose navigation points at it.
     *
     * Setting `post.author = user` says nothing about `post.authorid`, and
     * insertEntity() only reads column properties, so the INSERT used to bind
     * undefined into a NOT NULL column. This is EF Core's relationship fixup,
     * run after each principal INSERT so the dependent that follows sees the
     * generated key (issue #36).
     */
    private propagateGeneratedKey(principal: any): void {
        const principalType = principal.constructor;
        const principalMetadata = MetadataStorage.get().getEntity(principalType);
        const principalPk = principalMetadata?.columns.find((c: any) => c.isPrimaryKey);
        if (!principalPk) return;

        const keyValue = principal[principalPk.propertyName];
        if (keyValue === undefined || keyValue === null) return;

        for (const entry of this._changeTracker.getChangedEntries()) {
            const dependent = entry.entity;
            if (dependent === principal) continue;

            const metadata = MetadataStorage.get().getEntity(dependent.constructor);
            if (!metadata) continue;

            for (const relation of metadata.relations) {
                if (relation.relationType !== RelationType.ManyToOne &&
                    relation.relationType !== RelationType.OneToOne) {
                    continue;
                }
                if (!relation.foreignKeyColumn) continue;
                if (dependent[relation.propertyName] !== principal) continue;

                // An explicitly set foreign key wins: the caller said what it
                // wanted and fixup should not overwrite it.
                if (dependent[relation.foreignKeyColumn] === undefined ||
                    dependent[relation.foreignKeyColumn] === null) {
                    dependent[relation.foreignKeyColumn] = keyValue;
                }
            }
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

        const pkColumn = metadata.columns.find((c: any) => c.isPrimaryKey && c.isAutoIncrement);
        const needsGeneratedId = pkColumn && (entity[pkColumn.propertyName] === undefined || entity[pkColumn.propertyName] === null);
        const dialect = this.provider.getDialect();

        let sql: string;
        if (needsGeneratedId && dialect === 'postgresql') {
            sql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${pkColumn.columnName}`;
        } else if (needsGeneratedId && dialect === 'mssql') {
            sql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) OUTPUT INSERTED.${pkColumn.columnName} VALUES (${placeholders.join(', ')})`;
        } else {
            sql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`;
            // SQL Server rejects explicit values for IDENTITY columns unless IDENTITY_INSERT is ON
            if (pkColumn && !needsGeneratedId && dialect === 'mssql') {
                sql = `SET IDENTITY_INSERT ${tableName} ON; ${sql}; SET IDENTITY_INSERT ${tableName} OFF`;
            }
        }

        const result = await this.provider.query(sql, values);

        // A generated key comes back in the database's own representation, so
        // it goes through the column's convertFromDb before landing on the
        // entity. The same conversion the row-mapping path applies. Otherwise
        // a converted key would sit on the entity in its raw form and the
        // identity map would key insert-then-find differently.
        const fromDb = (value: any) =>
            pkColumn?.hasConversion && pkColumn.convertFromDb && value !== undefined && value !== null
                ? pkColumn.convertFromDb(value)
                : value;

        // Set auto-increment ID if applicable
        if (needsGeneratedId) {
            if (result.insertId !== undefined) {
                entity[pkColumn.propertyName] = fromDb(result.insertId);
            } else if (result.rows?.length > 0) {
                const returned = result.rows[0][pkColumn.columnName];
                if (returned !== undefined && returned !== null) {
                    entity[pkColumn.propertyName] = fromDb(typeof returned === 'bigint' ? Number(returned) : returned);
                }
            }
        } else if (pkColumn && result.insertId !== undefined) {
            entity[pkColumn.propertyName] = fromDb(result.insertId);
        }

        // Register the inserted entity in the identity map so a subsequent
        // find()/toList() for this primary key returns this same instance
        // (issue #5), whether the id was just generated above or was already
        // set explicitly by the caller before add().
        const identityPkColumn = metadata.columns.find((c: any) => c.isPrimaryKey);
        if (identityPkColumn) {
            const pkValue = entity[identityPkColumn.propertyName];
            if (pkValue !== undefined && pkValue !== null) {
                this.changeTracker.registerIdentity(entity.constructor, pkValue, entity);
            }
        }
    }

    /**
     * Update an existing entity
     */
    private async updateEntity(entity: any, entry: EntityEntry<any>, metadata: any, tableName: string, pkColumn: any): Promise<boolean> {
        // An entry with no baseline (update()/attach(e, Modified) on an entity
        // this context never read) has original values copied from the entity
        // itself, so property comparison reports nothing modified. EF Core's
        // Update() marks every property modified and writes all columns; doing
        // the same here is what makes the disconnected-update pattern work
        // instead of silently emitting no SQL (issue #33).
        const modifiedProperties = entry.hasBaseline
            ? entry.getModifiedProperties()
            : metadata.columns
                .filter((c: any) => !c.isPrimaryKey && !c.isConcurrencyToken && !c.isShadowProperty)
                .map((c: any) => c.propertyName);

        if (modifiedProperties.length === 0) {
            return false; // Nothing to update
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

        // Auto-increment concurrency tokens. The new value is staged and only
        // written onto the entity once the statement succeeds: mutating first
        // left a failed or rolled-back save with version + 1 on the entity and
        // the old value in originalValues, so a retry sent the wrong expected
        // version (issue #41).
        const stagedTokenValues: { propertyName: string; value: number }[] = [];
        for (const token of concurrencyTokens) {
            const currentValue = entity[token.propertyName];
            // A disconnected entity may carry no token value at all. There is
            // no baseline to check against either, so the token is left out of
            // the statement rather than invented (issue #33 meets #41).
            if (currentValue === undefined || currentValue === null) {
                continue;
            }
            if (typeof currentValue !== 'number') {
                throw new Error(
                    `${metadata.target.name}.${token.propertyName} is a concurrency token with a ` +
                    `non-numeric value (${typeof currentValue}). Tokens are incremented client-side ` +
                    `and must be numeric; database-generated tokens (timestamp, rowversion, GUID) ` +
                    `are not supported.`
                );
            }
            const newValue = currentValue + 1;
            setClause.push(`${token.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`);
            values.push(newValue);
            stagedTokenValues.push({ propertyName: token.propertyName, value: newValue });
        }

        if (setClause.length === 0) {
            return false; // No non-PK columns to update
        }

        let pkValue = entity[pkColumn.propertyName];

        // Apply value conversion to primary key if needed
        if (pkColumn.hasConversion && pkColumn.convertToDb && pkValue !== undefined && pkValue !== null) {
            pkValue = pkColumn.convertToDb(pkValue);
        }

        values.push(pkValue);

        // Build WHERE clause with PK
        let whereClause = `${pkColumn.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`;

        // Add concurrency token checks to WHERE clause. A token the entity
        // does not carry is skipped, matching the SET clause above.
        for (const token of concurrencyTokens) {
            const originalValue = entry.hasBaseline
                ? entry.originalValues[token.propertyName]
                : entity[token.propertyName];
            if (originalValue === undefined || originalValue === null) {
                continue;
            }
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

        for (const staged of stagedTokenValues) {
            entity[staged.propertyName] = staged.value;
        }

        return true;
    }

    /**
     * Delete an entity
     */
    private async deleteEntity(entity: any, entry: EntityEntry<any>, metadata: any, tableName: string, pkColumn: any): Promise<void> {
        let pkValue = entity[pkColumn.propertyName];

        // Apply value conversion to primary key if needed
        if (pkColumn.hasConversion && pkColumn.convertToDb && pkValue !== undefined && pkValue !== null) {
            pkValue = pkColumn.convertToDb(pkValue);
        }

        let paramIndex = 1;
        const values: any[] = [pkValue];
        let whereClause = `${pkColumn.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`;

        // A delete competes for the row the same way an update does, so it
        // carries the same token check. Without it, deleting a row another
        // user already changed succeeded silently (issue #41).
        const concurrencyTokens = metadata.columns.filter((c: any) => c.isConcurrencyToken);
        for (const token of concurrencyTokens) {
            const originalValue = entry.hasBaseline
                ? entry.originalValues[token.propertyName]
                : entity[token.propertyName];
            if (originalValue === undefined || originalValue === null) {
                continue;
            }
            whereClause += ` AND ${token.columnName} = ${this.provider.getParameterPlaceholder(paramIndex++)}`;
            values.push(originalValue);
        }

        const sql = `DELETE FROM ${tableName} WHERE ${whereClause}`;

        const result = await this.provider.query(sql, values);

        // EF Core throws when a DELETE affects no rows, token or not: the row
        // was already deleted or changed out from under this context.
        if (result.rowCount === 0) {
            const entityName = metadata.target.name;
            let errorMessage = `Concurrency violation detected for ${entityName} ` +
                `(${pkColumn.propertyName}=${entity[pkColumn.propertyName]}): ` +
                `The entity has been modified or deleted by another user.`;

            if (concurrencyTokens.length > 0) {
                const tokenInfo = concurrencyTokens.map((token: any) => {
                    const current = entity[token.propertyName];
                    const original = entry.hasBaseline
                        ? entry.originalValues[token.propertyName]
                        : current;
                    return `${token.propertyName}: expected=${original}, current=${current}`;
                }).join(', ');
                errorMessage += ` Concurrency tokens: ${tokenInfo}`;
            }

            throw new Error(errorMessage);
        }
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
        for (const entity of entities) {
            // Skip keyless entities (they're typically views or query types)
            if (entity.isKeyless) {
                continue;
            }

            const createTableSql = this.provider.generateCreateTableSql(entity);
            await this.query(createTableSql);
        }

        // Phase 2: Create join tables for Many-to-Many relationships
        const createdJoinTables = new Set<string>();

        for (const entity of entities) {
            for (const relation of entity.relations) {
                if (relation.relationType === RelationType.ManyToMany && relation.joinTable) {
                    // Only create each join table once
                    if (!createdJoinTables.has(relation.joinTable)) {
                        const relatedEntity = relation.relatedEntity();
                        const relatedMetadata = MetadataStorage.get().getEntity(relatedEntity);

                        if (relatedMetadata && relation.joinColumn && relation.inverseJoinColumn) {
                            // Look up actual PK column names instead of hardcoding 'id'
                            const entityPk = entity.columns.find(c => c.isPrimaryKey);
                            const relatedPk = relatedMetadata.columns.find(c => c.isPrimaryKey);

                            const joinTableSql = this.provider.generateCreateJoinTableSql(
                                relation.joinTable,
                                relation.joinColumn,
                                relation.inverseJoinColumn,
                                entity.tableName,
                                relatedMetadata.tableName,
                                relation.onDelete,
                                entityPk?.columnName,
                                relatedPk?.columnName
                            );

                            await this.query(joinTableSql);
                            createdJoinTables.add(relation.joinTable);
                        }
                    }
                }
            }
        }

        // Phase 3: Add foreign key constraints for ManyToOne and OneToOne relationships
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
                    const alterTableSql = this.provider.generateAddColumnSql(entity.tableName, col);
                    await this.query(alterTableSql);
                } else {
                    // Check for type mismatch using provider
                    if (this.provider.isTypeMismatch(col.type, existingType)) {
                        try {
                            const alterColumnSql = this.provider.generateAlterColumnTypeSql(entity.tableName, col);
                            await this.query(alterColumnSql);
                        } catch {
                            // Type migration failed. Data may be incompatible
                        }
                    }
                }
            }
        }

        // Phase 7: Seed Data
        for (const entity of entities) {
            if (entity.seedData && entity.seedData.length > 0) {
                const tableName = entity.tableName;
                const pkColumn = entity.columns.find(c => c.isPrimaryKey);

                if (!pkColumn) {
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

                            let insertSql = `INSERT INTO ${tableName} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`;
                            // SQL Server rejects explicit values for IDENTITY columns unless IDENTITY_INSERT is ON
                            if (pkColumn.isAutoIncrement && this.provider.getDialect() === 'mssql') {
                                insertSql = `SET IDENTITY_INSERT ${tableName} ON; ${insertSql}; SET IDENTITY_INSERT ${tableName} OFF`;
                            }
                            await this.query(insertSql, values);
                        }
                    }
                }
            }
        }

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
