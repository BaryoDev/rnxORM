import { DbContext } from "./DbContext";
import { MetadataStorage, RelationType } from "./MetadataStorage";
import { EntityState } from "./EntityEntry";
import { extractPropertyName } from "./utils";

/**
 * Represents a collection of entities in the database.
 * @template T The type of entity.
 */
export class DbSet<T> {
    private tableName: string;
    private columns: string[];

    constructor(private entityType: new () => T, private context: DbContext) {
        const metadata = MetadataStorage.get().getEntity(entityType);
        if (!metadata) {
            throw new Error(`Entity ${entityType.name} not found in metadata.`);
        }
        this.tableName = metadata.tableName;
        this.columns = metadata.columns.map(c => c.columnName);
    }

    /**
     * Add an entity to the context in the Added state.
     * Call context.saveChanges() to insert it into the database.
     */
    add(entity: T): void {
        this.context.changeTracker.track(entity, EntityState.Added);
    }

    /**
     * Add multiple entities to the context in the Added state.
     * Call context.saveChanges() to insert them into the database.
     * @param entities Array of entities to add
     */
    addRange(entities: T[]): void {
        for (const entity of entities) {
            this.context.changeTracker.track(entity, EntityState.Added);
        }
    }

    /**
     * Update an entity in the context in the Modified state.
     * Call context.saveChanges() to update it in the database.
     */
    update(entity: T): void {
        this.context.changeTracker.track(entity, EntityState.Modified);
    }

    /**
     * Update multiple entities in the context in the Modified state.
     * Call context.saveChanges() to update them in the database.
     * @param entities Array of entities to update
     */
    updateRange(entities: T[]): void {
        for (const entity of entities) {
            this.context.changeTracker.track(entity, EntityState.Modified);
        }
    }

    /**
     * Remove an entity from the context in the Deleted state.
     * Call context.saveChanges() to delete it from the database.
     */
    remove(entity: T): void {
        this.context.changeTracker.track(entity, EntityState.Deleted);
    }

    /**
     * Remove multiple entities from the context in the Deleted state.
     * Call context.saveChanges() to delete them from the database.
     * @param entities Array of entities to remove
     */
    removeRange(entities: T[]): void {
        for (const entity of entities) {
            this.context.changeTracker.track(entity, EntityState.Deleted);
        }
    }

    async toList(): Promise<T[]> {
        const provider = this.context.getProvider();
        const sql = provider.generateSelectSql(this.tableName);
        const res = await this.context.query(sql);
        return res.rows.map((row: any) => this.mapRowToEntity(row, true));
    }

    // Simple Fluent API for WHERE
    // usage: dbSet.where("age", ">", 18).toList()
    where(column: string, operator: string, value: any): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).where(column, operator, value);
    }

    /**
     * Include a related entity in the query (eager loading)
     * @param relation The relation property selector
     * @returns QueryBuilder with include
     *
     * @example
     * await dbSet.include(post => post.author).toList();
     */
    include(relation: (entity: T) => any): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).include(relation);
    }

    /**
     * Returns a query builder with no-tracking enabled.
     * Entities returned will be frozen (read-only) for better performance.
     * @returns QueryBuilder with no-tracking enabled
     */
    asNoTracking(): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName, false, true);
    }

    /**
     * Order results by column ascending
     */
    orderBy(column: string): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).orderBy(column);
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: string): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).orderByDescending(column);
    }

    /**
     * Skip N results (pagination)
     */
    skip(count: number): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).skip(count);
    }

    /**
     * Take N results (limit)
     */
    take(count: number): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).take(count);
    }

    /**
     * Finds an entity by its primary key value.
     * @param id - The primary key value
     * @returns The entity if found, null otherwise
     */
    async find(id: any): Promise<T | null> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return null;

        const pkColumn = metadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) throw new Error("Primary key not defined");

        const provider = this.context.getProvider();
        const placeholder = provider.getParameterPlaceholder(1);
        const sql = `SELECT * FROM ${this.tableName} WHERE ${pkColumn.columnName} = ${placeholder}`;
        const res = await this.context.query(sql, [id]);

        if (res.rows.length === 0) return null;
        return this.mapRowToEntity(res.rows[0], true); // Track the entity
    }

    /**
     * Count all entities
     */
    async count(): Promise<number> {
        const res = await this.context.query(`SELECT COUNT(*) as count FROM ${this.tableName}`);
        return parseInt(res.rows[0].count);
    }

    /**
     * Sum a numeric property across all entities
     * @param selector Property selector function
     * @example await users.sum(u => u.salary)
     */
    async sum(selector: (entity: T) => number): Promise<number> {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) throw new Error(`Property ${propertyName} not found`);

        const res = await this.context.query(`SELECT SUM(${column.columnName}) as total FROM ${this.tableName}`);
        return parseFloat(res.rows[0].total) || 0;
    }

    /**
     * Calculate average of a numeric property
     * @param selector Property selector function
     * @example await users.average(u => u.age)
     */
    async average(selector: (entity: T) => number): Promise<number> {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) throw new Error(`Property ${propertyName} not found`);

        const res = await this.context.query(`SELECT AVG(${column.columnName}) as avg FROM ${this.tableName}`);
        return parseFloat(res.rows[0].avg) || 0;
    }

    /**
     * Find minimum value of a property
     * @param selector Property selector function
     * @example await users.min(u => u.age)
     */
    async min(selector: (entity: T) => any): Promise<any> {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) throw new Error(`Property ${propertyName} not found`);

        const res = await this.context.query(`SELECT MIN(${column.columnName}) as min FROM ${this.tableName}`);
        return res.rows[0].min;
    }

    /**
     * Find maximum value of a property
     * @param selector Property selector function
     * @example await users.max(u => u.createdAt)
     */
    async max(selector: (entity: T) => any): Promise<any> {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) throw new Error(`Property ${propertyName} not found`);

        const res = await this.context.query(`SELECT MAX(${column.columnName}) as max FROM ${this.tableName}`);
        return res.rows[0].max;
    }

    /**
     * Project entities to a different shape
     * @param selector Projection function
     * @example await users.select(u => ({ name: u.name, email: u.email }))
     */
    select<TResult>(selector: (entity: T) => TResult): SelectQueryBuilder<T, TResult> {
        return new SelectQueryBuilder(this.entityType, this.context, this.tableName, selector);
    }

    /**
     * Remove duplicate entities
     */
    distinct(): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).distinct();
    }

    /**
     * Group entities by a property
     * @param selector Property selector function
     * @example await users.groupBy(u => u.department).select(g => ({ dept: g.key, count: g.count() })).toList()
     */
    groupBy<TKey>(selector: (entity: T) => TKey): GroupedQueryBuilder<T, TKey> {
        const propertyName = extractPropertyName(selector);
        return new GroupedQueryBuilder(this.entityType, this.context, this.tableName, propertyName) as GroupedQueryBuilder<T, TKey>;
    }

    /**
     * Creates a query using raw SQL
     * @param sql Raw SQL query
     * @param parameters Optional parameters for the query
     * @returns QueryBuilder with raw SQL query
     * @example
     * const users = await db.set(User)
     *     .fromSqlRaw('SELECT * FROM users WHERE age > $1', [18])
     *     .toList();
     */
    fromSqlRaw(sql: string, parameters?: any[]): RawSqlQueryBuilder<T> {
        return new RawSqlQueryBuilder(this.entityType, this.context, sql, parameters);
    }

    private mapRowToEntity(row: any, track: boolean = false): T {
        const entity = new this.entityType();
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        metadata?.columns.forEach(col => {
            let value = row[col.columnName];

            // Apply value conversion from database to entity
            if (col.hasConversion && col.convertFromDb) {
                value = col.convertFromDb(value);
            }

            // Only set non-shadow properties on the entity
            if (!col.isShadowProperty) {
                (entity as any)[col.propertyName] = value;
            }
        });

        // Track the entity if requested
        if (track) {
            const originalValues = { ...entity };
            this.context.changeTracker.track(entity, EntityState.Unchanged, originalValues);
        }

        return entity;
    }

    /**
     * Shared helper to map database rows to entities
     * @internal
     */
    static mapRowToEntity<T>(
        entityType: new () => T,
        row: any,
        noTracking: boolean = false,
        context?: DbContext
    ): T {
        const entity = new entityType();
        const metadata = MetadataStorage.get().getEntity(entityType);
        metadata?.columns.forEach(col => {
            let value = row[col.columnName];

            // Apply value conversion from database to entity
            if (col.hasConversion && col.convertFromDb) {
                value = col.convertFromDb(value);
            }

            // Only set non-shadow properties on the entity
            if (!col.isShadowProperty) {
                (entity as any)[col.propertyName] = value;
            }
        });

        // Track the entity if tracking is enabled and context is provided
        if (!noTracking && context) {
            const originalValues = { ...entity };
            context.changeTracker.track(entity, EntityState.Unchanged, originalValues);
        }

        return entity;
    }
}

interface IncludeInfo {
    propertyName: string;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    relatedEntityType: Function;
}

export class QueryBuilder<T> {
    private conditions: string[] = [];
    private params: any[] = [];
    private noTracking: boolean = false;
    private includes: IncludeInfo[] = [];
    private orderByColumns: { column: string; direction: 'ASC' | 'DESC' }[] = [];
    private skipCount?: number;
    private takeCount?: number;
    private isDistinct: boolean = false;
    private ignoreFilters: boolean = false;

    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private tableName: string,
        private loadEager: boolean = false,
        noTracking: boolean = false
    ) {
        this.noTracking = noTracking;
    }

    where(column: string, operator: string, value: any): this {
        const provider = this.context.getProvider();
        const placeholder = provider.getParameterPlaceholder(this.params.length + 1);
        this.conditions.push(`${column} ${operator} ${placeholder}`);
        this.params.push(value);
        return this;
    }

    /**
     * Include related entities (eager loading)
     */
    include(relation: (entity: T) => any): this {
        const propertyName = extractPropertyName(relation);
        const metadata = MetadataStorage.get().getEntity(this.entityType);

        if (!metadata) {
            throw new Error(`Entity ${this.entityType.name} not found in metadata`);
        }

        const relationMetadata = metadata.relations.find(r => r.propertyName === propertyName);
        if (!relationMetadata) {
            throw new Error(`Relation ${propertyName} not found on ${this.entityType.name}`);
        }

        this.includes.push({
            propertyName,
            relatedEntityType: relationMetadata.relatedEntity(),
        });

        return this;
    }

    /**
     * Order results by column ascending
     */
    orderBy(column: string): this {
        this.orderByColumns.push({ column, direction: 'ASC' });
        return this;
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: string): this {
        this.orderByColumns.push({ column, direction: 'DESC' });
        return this;
    }

    /**
     * Skip N results (for pagination)
     */
    skip(count: number): this {
        this.skipCount = count;
        return this;
    }

    /**
     * Take N results (limit)
     */
    take(count: number): this {
        this.takeCount = count;
        return this;
    }

    /**
     * Enables no-tracking mode for this query.
     * Entities will be frozen (read-only) for better performance.
     * @returns This query builder
     */
    asNoTracking(): this {
        this.noTracking = true;
        return this;
    }

    /**
     * Disables global query filters for this query.
     * Useful for accessing soft-deleted entities or bypassing tenant filters.
     * @returns This query builder
     */
    ignoreQueryFilters(): this {
        this.ignoreFilters = true;
        return this;
    }

    async toList(): Promise<T[]> {
        const provider = this.context.getProvider();
        const dialect = provider.getDialect();
        let whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";

        // Add ORDER BY clause
        if (this.orderByColumns.length > 0) {
            const orderByClause = this.orderByColumns
                .map(o => `${o.column} ${o.direction}`)
                .join(', ');
            whereClause += (whereClause ? ' ' : '') + `ORDER BY ${orderByClause}`;
        }

        // Add pagination (database-specific)
        if (dialect === 'mssql') {
            // MSSQL uses OFFSET/FETCH syntax (requires ORDER BY)
            if (this.skipCount !== undefined || this.takeCount !== undefined) {
                // MSSQL requires ORDER BY for OFFSET/FETCH
                if (this.orderByColumns.length === 0) {
                    whereClause += (whereClause ? ' ' : '') + 'ORDER BY (SELECT NULL)';
                }
                whereClause += ` OFFSET ${this.skipCount ?? 0} ROWS`;
                if (this.takeCount !== undefined) {
                    whereClause += ` FETCH NEXT ${this.takeCount} ROWS ONLY`;
                }
            }
        } else {
            // PostgreSQL/MariaDB use LIMIT/OFFSET
            if (this.takeCount !== undefined) {
                whereClause += ` LIMIT ${this.takeCount}`;
            }
            if (this.skipCount !== undefined) {
                whereClause += ` OFFSET ${this.skipCount}`;
            }
        }

        // Add DISTINCT if needed
        let selectClause = "SELECT *";
        if (this.isDistinct) {
            selectClause = "SELECT DISTINCT *";
        }

        const sql = `${selectClause} FROM ${this.tableName}${whereClause ? ' ' + whereClause : ''}`;
        const res = await this.context.query(sql, this.params);

        // Map rows to entities
        const entities = res.rows.map((row: any) =>
            DbSet.mapRowToEntity(this.entityType, row, this.noTracking, this.context)
        );

        // Apply global query filter (unless ignored)
        let filteredEntities = entities;
        if (!this.ignoreFilters) {
            const metadata = MetadataStorage.get().getEntity(this.entityType);
            if (metadata?.queryFilter) {
                filteredEntities = entities.filter(metadata.queryFilter);
            }
        }

        // Load includes (eager loading)
        if (this.includes.length > 0) {
            await this.loadIncludes(filteredEntities);
        }

        return filteredEntities;
    }

    /**
     * Get the first result or null
     */
    async first(): Promise<T | null> {
        const results = await this.take(1).toList();
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Count results
     */
    async count(): Promise<number> {
        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, this.params);
        return parseInt(res.rows[0].count);
    }

    /**
     * Check if any results exist
     */
    async any(): Promise<boolean> {
        const count = await this.count();
        return count > 0;
    }

    /**
     * Check if all results match a condition (executed in memory)
     * @param predicate Condition to check
     */
    async all(predicate: (entity: T) => boolean): Promise<boolean> {
        const results = await this.toList();
        return results.every(predicate);
    }

    /**
     * Get a single result (throws if zero or multiple results)
     */
    async single(): Promise<T> {
        const results = await this.take(2).toList();
        if (results.length === 0) {
            throw new Error('Sequence contains no elements');
        }
        if (results.length > 1) {
            throw new Error('Sequence contains more than one element');
        }
        return results[0];
    }

    /**
     * Get a single result or null (throws if multiple results)
     */
    async singleOrDefault(): Promise<T | null> {
        const results = await this.take(2).toList();
        if (results.length > 1) {
            throw new Error('Sequence contains more than one element');
        }
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Get the first result or throw
     */
    async firstOrThrow(): Promise<T> {
        const result = await this.first();
        if (!result) {
            throw new Error('Sequence contains no elements');
        }
        return result;
    }

    /**
     * Sum a numeric property across filtered results
     * @param selector Property selector function
     */
    async sum(selector: (entity: T) => number): Promise<number> {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) throw new Error(`Property ${propertyName} not found`);

        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT SUM(${column.columnName}) as total FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, this.params);
        return parseFloat(res.rows[0].total) || 0;
    }

    /**
     * Calculate average of a numeric property across filtered results
     * @param selector Property selector function
     */
    async average(selector: (entity: T) => number): Promise<number> {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) throw new Error(`Property ${propertyName} not found`);

        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT AVG(${column.columnName}) as avg FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, this.params);
        return parseFloat(res.rows[0].avg) || 0;
    }

    /**
     * Find minimum value of a property across filtered results
     * @param selector Property selector function
     */
    async min(selector: (entity: T) => any): Promise<any> {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) throw new Error(`Property ${propertyName} not found`);

        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT MIN(${column.columnName}) as min FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, this.params);
        return res.rows[0].min;
    }

    /**
     * Find maximum value of a property across filtered results
     * @param selector Property selector function
     */
    async max(selector: (entity: T) => any): Promise<any> {
        const propertyName = extractPropertyName(selector);
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const column = metadata?.columns.find(c => c.propertyName === propertyName);
        if (!column) throw new Error(`Property ${propertyName} not found`);

        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT MAX(${column.columnName}) as max FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, this.params);
        return res.rows[0].max;
    }

    /**
     * Project entities to a different shape
     * @param selector Projection function
     */
    select<TResult>(selector: (entity: T) => TResult): SelectQueryBuilder<T, TResult> {
        const builder = new SelectQueryBuilder(this.entityType, this.context, this.tableName, selector);
        // Copy current query state
        builder['conditions'] = [...this.conditions];
        builder['params'] = [...this.params];
        builder['orderByColumns'] = [...this.orderByColumns];
        builder['skipCount'] = this.skipCount;
        builder['takeCount'] = this.takeCount;
        builder['isDistinct'] = this.isDistinct;
        return builder;
    }

    /**
     * Remove duplicate entities
     */
    distinct(): this {
        this.isDistinct = true;
        return this;
    }

    /**
     * Group filtered results by a property
     * @param selector Property selector function
     */
    groupBy<TKey>(selector: (entity: T) => TKey): GroupedQueryBuilder<T, TKey> {
        const propertyName = extractPropertyName(selector);
        const builder = new GroupedQueryBuilder(this.entityType, this.context, this.tableName, propertyName) as GroupedQueryBuilder<T, TKey>;
        // Copy current query state (WHERE conditions)
        builder['conditions'] = [...this.conditions];
        builder['params'] = [...this.params];
        return builder;
    }

    private async loadIncludes(entities: T[]): Promise<void> {
        if (entities.length === 0) return;

        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return;

        for (const include of this.includes) {
            const relationMetadata = metadata.relations.find(r => r.propertyName === include.propertyName);
            if (!relationMetadata) continue;

            const relatedMetadata = MetadataStorage.get().getEntity(include.relatedEntityType);
            if (!relatedMetadata) continue;

            const relatedPkColumn = relatedMetadata.columns.find(c => c.isPrimaryKey);
            if (!relatedPkColumn) continue;

            // Handle different relation types
            if (relationMetadata.relationType === RelationType.ManyToOne || relationMetadata.relationType === RelationType.OneToOne) {
                // Load the single related entity
                await this.loadManyToOneRelation(entities, relationMetadata, relatedMetadata, relatedPkColumn.columnName);
            } else if (relationMetadata.relationType === RelationType.OneToMany) {
                // Load the collection of related entities
                await this.loadOneToManyRelation(entities, relationMetadata, relatedMetadata);
            } else if (relationMetadata.relationType === RelationType.ManyToMany) {
                // Load many-to-many relation through join table
                await this.loadManyToManyRelation(entities, relationMetadata, relatedMetadata);
            }
        }
    }

    private async loadManyToOneRelation(
        entities: T[],
        relationMetadata: any,
        relatedMetadata: any,
        relatedPkColumn: string
    ): Promise<void> {
        const foreignKeyColumn = relationMetadata.foreignKeyColumn;
        if (!foreignKeyColumn) return;

        // Get all unique foreign key values
        const foreignKeyValues = entities
            .map(e => (e as any)[foreignKeyColumn])
            .filter(v => v !== null && v !== undefined);

        if (foreignKeyValues.length === 0) return;

        // Load related entities
        const uniqueFkValues = [...new Set(foreignKeyValues)];
        const placeholders = uniqueFkValues.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const sql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${relatedPkColumn} IN (${placeholders})`;
        const res = await this.context.query(sql, uniqueFkValues);

        // Map related entities by their primary key
        const relatedEntitiesMap = new Map();
        res.rows.forEach((row: any) => {
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking);
            relatedEntitiesMap.set(row[relatedPkColumn], relatedEntity);
        });

        // Attach related entities to main entities
        entities.forEach(entity => {
            const fkValue = (entity as any)[foreignKeyColumn];
            if (fkValue && relatedEntitiesMap.has(fkValue)) {
                (entity as any)[relationMetadata.propertyName] = relatedEntitiesMap.get(fkValue);
            }
        });
    }

    private async loadOneToManyRelation(
        entities: T[],
        relationMetadata: any,
        relatedMetadata: any
    ): Promise<void> {
        const entityMetadata = MetadataStorage.get().getEntity(this.entityType);
        if (!entityMetadata) return;

        const pkColumn = entityMetadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) return;

        // Find the foreign key column on the related entity
        const inverseSide = relationMetadata.inverseSide;
        const relatedRelation = relatedMetadata.relations.find((r: any) => r.propertyName === inverseSide);
        if (!relatedRelation || !relatedRelation.foreignKeyColumn) return;

        const foreignKeyColumn = relatedRelation.foreignKeyColumn;

        // Get all primary key values
        const pkValues = entities.map(e => (e as any)[pkColumn.propertyName]);

        // Load all related entities
        const placeholders = pkValues.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const sql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${foreignKeyColumn} IN (${placeholders})`;
        const res = await this.context.query(sql, pkValues);

        // Group related entities by foreign key
        const relatedEntitiesMap = new Map<any, any[]>();
        res.rows.forEach((row: any) => {
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking);
            const fkValue = row[foreignKeyColumn];

            if (!relatedEntitiesMap.has(fkValue)) {
                relatedEntitiesMap.set(fkValue, []);
            }
            relatedEntitiesMap.get(fkValue)!.push(relatedEntity);
        });

        // Attach collections to main entities
        entities.forEach(entity => {
            const pkValue = (entity as any)[pkColumn.propertyName];
            (entity as any)[relationMetadata.propertyName] = relatedEntitiesMap.get(pkValue) || [];
        });
    }

    private async loadManyToManyRelation(
        entities: T[],
        relationMetadata: any,
        relatedMetadata: any
    ): Promise<void> {
        if (!relationMetadata.joinTable) return;

        const entityMetadata = MetadataStorage.get().getEntity(this.entityType);
        if (!entityMetadata) return;

        const pkColumn = entityMetadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) return;

        const pkValues = entities.map(e => (e as any)[pkColumn.propertyName]);

        // Query join table
        const placeholders = pkValues.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const joinSql = `SELECT * FROM ${relationMetadata.joinTable} WHERE ${relationMetadata.joinColumn} IN (${placeholders})`;
        const joinRes = await this.context.query(joinSql, pkValues);

        if (joinRes.rows.length === 0) {
            // No related entities
            entities.forEach(entity => {
                (entity as any)[relationMetadata.propertyName] = [];
            });
            return;
        }

        // Get related entity IDs
        const relatedIds = joinRes.rows.map((r: any) => r[relationMetadata.inverseJoinColumn!]);
        const uniqueRelatedIds = [...new Set(relatedIds)];

        // Load related entities
        const relatedPkColumn = relatedMetadata.columns.find((c: any) => c.isPrimaryKey);
        if (!relatedPkColumn) return;

        const relatedPlaceholders = uniqueRelatedIds.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const relatedSql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${relatedPkColumn.columnName} IN (${relatedPlaceholders})`;
        const relatedRes = await this.context.query(relatedSql, uniqueRelatedIds);

        // Map related entities
        const relatedEntitiesMap = new Map();
        relatedRes.rows.forEach((row: any) => {
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking);
            relatedEntitiesMap.set(row[relatedPkColumn.columnName], relatedEntity);
        });

        // Group by source entity
        const relationMap = new Map<any, any[]>();
        joinRes.rows.forEach((joinRow: any) => {
            const sourceId = joinRow[relationMetadata.joinColumn!];
            const targetId = joinRow[relationMetadata.inverseJoinColumn!];

            if (!relationMap.has(sourceId)) {
                relationMap.set(sourceId, []);
            }

            if (relatedEntitiesMap.has(targetId)) {
                relationMap.get(sourceId)!.push(relatedEntitiesMap.get(targetId));
            }
        });

        // Attach to entities
        entities.forEach(entity => {
            const pkValue = (entity as any)[pkColumn.propertyName];
            (entity as any)[relationMetadata.propertyName] = relationMap.get(pkValue) || [];
        });
    }
}

/**
 * Query builder for SELECT projections
 * Allows selecting specific properties or transforming results
 */
export class SelectQueryBuilder<T, TResult> {
    private conditions: string[] = [];
    private params: any[] = [];
    private orderByColumns: { column: string; direction: 'ASC' | 'DESC' }[] = [];
    private skipCount?: number;
    private takeCount?: number;
    private isDistinct: boolean = false;

    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private tableName: string,
        private selector: (entity: T) => TResult
    ) {}

    /**
     * Add a WHERE condition
     */
    where(column: string, operator: string, value: any): this {
        const provider = this.context.getProvider();
        const placeholder = provider.getParameterPlaceholder(this.params.length + 1);
        this.conditions.push(`${column} ${operator} ${placeholder}`);
        this.params.push(value);
        return this;
    }

    /**
     * Order results by column ascending
     */
    orderBy(column: string): this {
        this.orderByColumns.push({ column, direction: 'ASC' });
        return this;
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: string): this {
        this.orderByColumns.push({ column, direction: 'DESC' });
        return this;
    }

    /**
     * Skip N results
     */
    skip(count: number): this {
        this.skipCount = count;
        return this;
    }

    /**
     * Take N results
     */
    take(count: number): this {
        this.takeCount = count;
        return this;
    }

    /**
     * Remove duplicates
     */
    distinct(): this {
        this.isDistinct = true;
        return this;
    }

    /**
     * Execute query and return projected results
     */
    async toList(): Promise<TResult[]> {
        const provider = this.context.getProvider();
        const dialect = provider.getDialect();

        // First, get the entities
        let whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";

        // Add ORDER BY clause
        if (this.orderByColumns.length > 0) {
            const orderByClause = this.orderByColumns
                .map(o => `${o.column} ${o.direction}`)
                .join(', ');
            whereClause += (whereClause ? ' ' : '') + `ORDER BY ${orderByClause}`;
        }

        // Add pagination (database-specific)
        if (dialect === 'mssql') {
            if (this.skipCount !== undefined || this.takeCount !== undefined) {
                if (this.orderByColumns.length === 0) {
                    whereClause += (whereClause ? ' ' : '') + 'ORDER BY (SELECT NULL)';
                }
                whereClause += ` OFFSET ${this.skipCount ?? 0} ROWS`;
                if (this.takeCount !== undefined) {
                    whereClause += ` FETCH NEXT ${this.takeCount} ROWS ONLY`;
                }
            }
        } else {
            if (this.takeCount !== undefined) {
                whereClause += ` LIMIT ${this.takeCount}`;
            }
            if (this.skipCount !== undefined) {
                whereClause += ` OFFSET ${this.skipCount}`;
            }
        }

        // Check if we can optimize with SQL projection
        const projectedColumns = this.extractProjectedColumns();

        let sql: string;
        if (projectedColumns && projectedColumns.length > 0) {
            // Use SQL projection for simple property selections
            const distinctKeyword = this.isDistinct ? 'DISTINCT ' : '';
            const columnList = projectedColumns.join(', ');
            sql = `SELECT ${distinctKeyword}${columnList} FROM ${this.tableName}${whereClause ? ' ' + whereClause : ''}`;
        } else {
            // Fall back to selecting all columns and projecting in memory
            const distinctKeyword = this.isDistinct ? 'DISTINCT ' : '';
            sql = `SELECT ${distinctKeyword}* FROM ${this.tableName}${whereClause ? ' ' + whereClause : ''}`;
        }

        const res = await this.context.query(sql, this.params);

        // Apply selector to each row
        if (projectedColumns && projectedColumns.length > 0) {
            // Direct column projection - just return the rows
            return res.rows as TResult[];
        } else {
            // Map rows to entities first, then apply selector
            const entities = res.rows.map((row: any) =>
                DbSet.mapRowToEntity(this.entityType, row, false)
            );
            return entities.map(e => this.selector(e));
        }
    }

    /**
     * Get first result
     */
    async first(): Promise<TResult | null> {
        const results = await this.take(1).toList();
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Count results (doesn't apply projection)
     */
    async count(): Promise<number> {
        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, this.params);
        return parseInt(res.rows[0].count);
    }

    /**
     * Try to extract projected column names from the selector for SQL optimization
     * Returns null if the selector is too complex for SQL projection
     */
    private extractProjectedColumns(): string[] | null {
        try {
            const selectorStr = this.selector.toString();

            // Try to match simple object literal projections like: u => ({ name: u.name, age: u.age })
            const objectLiteralMatch = selectorStr.match(/\{\s*([^}]+)\s*\}/);
            if (objectLiteralMatch) {
                const properties = objectLiteralMatch[1];

                // Extract property names
                const propertyMatches = properties.matchAll(/(\w+)\s*:\s*\w+\.(\w+)/g);
                const columns: string[] = [];

                for (const match of propertyMatches) {
                    const alias = match[1];
                    const propertyName = match[2];

                    const metadata = MetadataStorage.get().getEntity(this.entityType);
                    const column = metadata?.columns.find(c => c.propertyName === propertyName);

                    if (column) {
                        // Use "columnName AS alias" format
                        columns.push(`${column.columnName} AS ${alias}`);
                    } else {
                        // Can't optimize - unknown property
                        return null;
                    }
                }

                if (columns.length > 0) {
                    return columns;
                }
            }

            // Try to match single property projection like: u => u.name
            const singlePropertyMatch = selectorStr.match(/=>\s*\w+\.(\w+)\s*$/);
            if (singlePropertyMatch) {
                const propertyName = singlePropertyMatch[1];
                const metadata = MetadataStorage.get().getEntity(this.entityType);
                const column = metadata?.columns.find(c => c.propertyName === propertyName);

                if (column) {
                    return [column.columnName];
                }
            }

            // Can't optimize - use in-memory projection
            return null;
        } catch {
            // Error parsing selector - use in-memory projection
            return null;
        }
    }
}

/**
 * Query builder for raw SQL queries
 * Allows executing custom SQL and mapping results to entities
 */
export class RawSqlQueryBuilder<T> {
    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private sql: string,
        private parameters?: any[]
    ) {}

    /**
     * Execute the raw SQL query and return results as entities
     */
    async toList(): Promise<T[]> {
        const res = await this.context.query(this.sql, this.parameters);

        // Map rows to entities
        const entities = res.rows.map((row: any) =>
            DbSet.mapRowToEntity(this.entityType, row, false, this.context)
        );

        // Apply global query filter
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata?.queryFilter) {
            return entities.filter(metadata.queryFilter);
        }

        return entities;
    }

    /**
     * Execute the raw SQL query without tracking
     */
    async toListNoTracking(): Promise<T[]> {
        const res = await this.context.query(this.sql, this.parameters);

        // Map rows to entities without tracking
        const entities = res.rows.map((row: any) =>
            DbSet.mapRowToEntity(this.entityType, row, true)
        );

        // Apply global query filter
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (metadata?.queryFilter) {
            return entities.filter(metadata.queryFilter);
        }

        return entities;
    }

    /**
     * Get first result or null
     */
    async first(): Promise<T | null> {
        const results = await this.toList();
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Count results
     */
    async count(): Promise<number> {
        const results = await this.toList();
        return results.length;
    }
}

/**
 * Represents a grouping of entities with a common key
 * Used for GroupBy operations
 */
export interface IGrouping<TKey, TElement> {
    key: TKey;
    count(): number;
    sum(selector: (element: TElement) => number): number;
    average(selector: (element: TElement) => number): number;
    min(selector: (element: TElement) => any): any;
    max(selector: (element: TElement) => any): any;
}

/**
 * Query builder for GROUP BY operations
 * Allows grouping entities and performing aggregations
 */
export class GroupedQueryBuilder<T, TKey> {
    private conditions: string[] = [];
    private params: any[] = [];
    private havingConditions: string[] = [];
    private havingParams: any[] = [];
    private orderByColumns: { column: string; direction: 'ASC' | 'DESC' }[] = [];
    private skipCount?: number;
    private takeCount?: number;

    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private tableName: string,
        private groupByProperty: string
    ) {}

    /**
     * Filter groups using HAVING clause
     * @param column Aggregate column or group column
     * @param operator Comparison operator
     * @param value Value to compare
     * @example groupBy(u => u.dept).having('COUNT(*)', '>', 5)
     */
    having(column: string, operator: string, value: any): this {
        const provider = this.context.getProvider();
        const placeholder = provider.getParameterPlaceholder(this.params.length + this.havingParams.length + 1);
        this.havingConditions.push(`${column} ${operator} ${placeholder}`);
        this.havingParams.push(value);
        return this;
    }

    /**
     * Order grouped results
     */
    orderBy(column: string): this {
        this.orderByColumns.push({ column, direction: 'ASC' });
        return this;
    }

    /**
     * Order grouped results descending
     */
    orderByDescending(column: string): this {
        this.orderByColumns.push({ column, direction: 'DESC' });
        return this;
    }

    /**
     * Skip N groups
     */
    skip(count: number): this {
        this.skipCount = count;
        return this;
    }

    /**
     * Take N groups
     */
    take(count: number): this {
        this.takeCount = count;
        return this;
    }

    /**
     * Project grouped results with aggregations
     * @param selector Function to build result from grouped data
     * @example
     * .select(g => ({
     *   department: g.key,
     *   count: g.count(),
     *   avgSalary: g.average(u => u.salary)
     * }))
     */
    select<TResult>(selector: (group: IGrouping<TKey, T>) => TResult): GroupedSelectBuilder<T, TKey, TResult> {
        return new GroupedSelectBuilder(
            this.entityType,
            this.context,
            this.tableName,
            this.groupByProperty,
            selector,
            this.conditions,
            this.params,
            this.havingConditions,
            this.havingParams,
            this.orderByColumns,
            this.skipCount,
            this.takeCount
        );
    }

    /**
     * Execute group by and return groups with their elements (in-memory grouping)
     * Warning: This loads all data into memory
     */
    async toList(): Promise<IGrouping<TKey, T>[]> {
        // This is a simple in-memory grouping fallback
        // For production, you should use .select() with aggregations
        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT * FROM ${this.tableName}${whereClause ? ' ' + whereClause : ''}`;
        const res = await this.context.query(sql, this.params);

        const entities = res.rows.map((row: any) =>
            DbSet.mapRowToEntity(this.entityType, row, false)
        );

        // Group in memory
        const groups = new Map<TKey, T[]>();
        entities.forEach(entity => {
            const key = (entity as any)[this.groupByProperty] as TKey;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(entity);
        });

        // Convert to IGrouping interface
        return Array.from(groups.entries()).map(([key, elements]) => ({
            key,
            count: () => elements.length,
            sum: (selector: (e: T) => number) => elements.reduce((sum, e) => sum + selector(e), 0),
            average: (selector: (e: T) => number) => {
                const sum = elements.reduce((s, e) => s + selector(e), 0);
                return elements.length > 0 ? sum / elements.length : 0;
            },
            min: (selector: (e: T) => any) => {
                if (elements.length === 0) return null;
                return Math.min(...elements.map(e => selector(e)));
            },
            max: (selector: (e: T) => any) => {
                if (elements.length === 0) return null;
                return Math.max(...elements.map(e => selector(e)));
            }
        }));
    }
}

/**
 * Builder for SELECT projections on grouped data
 * Handles SQL GROUP BY with aggregations
 */
export class GroupedSelectBuilder<T, TKey, TResult> {
    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private tableName: string,
        private groupByProperty: string,
        private selector: (group: IGrouping<TKey, T>) => TResult,
        private conditions: string[],
        private params: any[],
        private havingConditions: string[],
        private havingParams: any[],
        private orderByColumns: { column: string; direction: 'ASC' | 'DESC' }[],
        private skipCount?: number,
        private takeCount?: number
    ) {}

    /**
     * Execute the grouped query with aggregations
     */
    async toList(): Promise<TResult[]> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const groupColumn = metadata?.columns.find(c => c.propertyName === this.groupByProperty);

        if (!groupColumn) {
            throw new Error(`Property ${this.groupByProperty} not found on entity`);
        }

        // Parse the selector to extract aggregations
        const selectorStr = this.selector.toString();

        // Extract aggregation and key references from selector
        const aggregations = this.parseAggregations(selectorStr, groupColumn.columnName);

        // Build SQL query
        const selectClauses: string[] = [];
        const aliases: string[] = [];

        // Always include the grouping column
        selectClauses.push(`${groupColumn.columnName}`);

        // Add aggregations
        aggregations.forEach(agg => {
            selectClauses.push(agg.sql);
            aliases.push(agg.alias);
        });

        let sql = `SELECT ${selectClauses.join(', ')} FROM ${this.tableName}`;

        // WHERE clause
        if (this.conditions.length > 0) {
            sql += ` WHERE ${this.conditions.join(' AND ')}`;
        }

        // GROUP BY clause
        sql += ` GROUP BY ${groupColumn.columnName}`;

        // HAVING clause
        if (this.havingConditions.length > 0) {
            sql += ` HAVING ${this.havingConditions.join(' AND ')}`;
        }

        // ORDER BY clause
        if (this.orderByColumns.length > 0) {
            const orderBy = this.orderByColumns.map(o => `${o.column} ${o.direction}`).join(', ');
            sql += ` ORDER BY ${orderBy}`;
        }

        // LIMIT/OFFSET
        if (this.takeCount !== undefined) {
            sql += ` LIMIT ${this.takeCount}`;
        }
        if (this.skipCount !== undefined) {
            sql += ` OFFSET ${this.skipCount}`;
        }

        // Execute query
        const allParams = [...this.params, ...this.havingParams];
        const res = await this.context.query(sql, allParams);

        // Map results (rows already have the shape we want from SQL)
        return res.rows as TResult[];
    }

    /**
     * Get first grouped result
     */
    async first(): Promise<TResult | null> {
        const results = await this.toList();
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Count number of groups
     */
    async count(): Promise<number> {
        const results = await this.toList();
        return results.length;
    }

    /**
     * Parse selector string to extract SQL aggregations
     */
    private parseAggregations(selectorStr: string, groupColumn: string): Array<{ sql: string; alias: string }> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const aggregations: Array<{ sql: string; alias: string }> = [];

        // Match patterns like: count: g.count()
        const countMatch = selectorStr.match(/(\w+)\s*:\s*\w+\.count\(\)/);
        if (countMatch) {
            aggregations.push({
                sql: 'COUNT(*) as ' + countMatch[1],
                alias: countMatch[1]
            });
        }

        // Match patterns like: avgSalary: g.average(u => u.salary)
        const avgMatches = selectorStr.matchAll(/(\w+)\s*:\s*\w+\.average\(\w+\s*=>\s*\w+\.(\w+)\)/g);
        for (const match of avgMatches) {
            const alias = match[1];
            const propertyName = match[2];
            const column = metadata?.columns.find(c => c.propertyName === propertyName);
            if (column) {
                aggregations.push({
                    sql: `AVG(${column.columnName}) as ${alias}`,
                    alias
                });
            }
        }

        // Match patterns like: totalSalary: g.sum(u => u.salary)
        const sumMatches = selectorStr.matchAll(/(\w+)\s*:\s*\w+\.sum\(\w+\s*=>\s*\w+\.(\w+)\)/g);
        for (const match of sumMatches) {
            const alias = match[1];
            const propertyName = match[2];
            const column = metadata?.columns.find(c => c.propertyName === propertyName);
            if (column) {
                aggregations.push({
                    sql: `SUM(${column.columnName}) as ${alias}`,
                    alias
                });
            }
        }

        // Match patterns like: minAge: g.min(u => u.age)
        const minMatches = selectorStr.matchAll(/(\w+)\s*:\s*\w+\.min\(\w+\s*=>\s*\w+\.(\w+)\)/g);
        for (const match of minMatches) {
            const alias = match[1];
            const propertyName = match[2];
            const column = metadata?.columns.find(c => c.propertyName === propertyName);
            if (column) {
                aggregations.push({
                    sql: `MIN(${column.columnName}) as ${alias}`,
                    alias
                });
            }
        }

        // Match patterns like: maxAge: g.max(u => u.age)
        const maxMatches = selectorStr.matchAll(/(\w+)\s*:\s*\w+\.max\(\w+\s*=>\s*\w+\.(\w+)\)/g);
        for (const match of maxMatches) {
            const alias = match[1];
            const propertyName = match[2];
            const column = metadata?.columns.find(c => c.propertyName === propertyName);
            if (column) {
                aggregations.push({
                    sql: `MAX(${column.columnName}) as ${alias}`,
                    alias
                });
            }
        }

        return aggregations;
    }
}
