import { DbContext } from "./DbContext";
import { MetadataStorage, RelationType } from "./MetadataStorage";
import { EntityState } from "./EntityEntry";
import { capture, captureAggregates, resolveColumn, resolvePropertyName, AggregateFn, AggregateSelectorEntry } from "./expressions/PropertyCapture";
import { compileQueryFilter, matchesQueryFilter } from "./QueryFilter";
import { assertColumn, assertColumnOrAlias, assertHavingExpression, assertLimit, buildComparison } from "./Identifiers";

/** Renders a captured aggregate into its SQL function call. `col` is undefined for count(). */
const AGG_SQL: Record<AggregateFn, (col?: string) => string> = {
    count: () => "COUNT(*)",
    sum: (col?: string) => `SUM(${col})`,
    avg: (col?: string) => `AVG(${col})`,
    min: (col?: string) => `MIN(${col})`,
    max: (col?: string) => `MAX(${col})`,
};

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
        const metadata = MetadataStorage.get().getEntity(this.entityType);

        // Structured query filters are translated to SQL so filtered rows
        // never leave the database; use ignoreQueryFilters() to bypass.
        const filter = compileQueryFilter(metadata, provider, 1);
        let sql = provider.generateSelectSql(this.tableName);
        if (filter.clauses.length > 0) {
            sql += ` WHERE ${filter.clauses.join(' AND ')}`;
        }

        const res = await this.context.query(sql, filter.clauses.length > 0 ? filter.params : undefined);
        const entities = res.rows.map((row: any) => this.mapRowToEntity(row, true));

        // Predicate-form query filters are evaluated in memory
        if (metadata?.queryFilter) {
            return entities.filter(metadata.queryFilter);
        }
        return entities;
    }

    // Simple Fluent API for WHERE
    // usage: dbSet.where("age", ">", 18).toList()
    where(column: keyof T & string, operator: string, value: any): QueryBuilder<T>;
    where(column: string, operator: string, value: any): QueryBuilder<T>;
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
     * Entities returned are not registered in the change tracker, so
     * modifications to them are not persisted by saveChanges().
     * @returns QueryBuilder with no-tracking enabled
     */
    asNoTracking(): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName, false, true);
    }

    /**
     * Returns a query builder with global query filters disabled.
     * Useful for accessing soft-deleted entities or bypassing tenant filters.
     * @returns QueryBuilder with query filters disabled
     */
    ignoreQueryFilters(): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).ignoreQueryFilters();
    }

    /**
     * Order results by column ascending
     */
    orderBy(column: keyof T & string): QueryBuilder<T>;
    orderBy(column: string): QueryBuilder<T>;
    orderBy(column: string): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).orderBy(column);
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: keyof T & string): QueryBuilder<T>;
    orderByDescending(column: string): QueryBuilder<T>;
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
        let sql = `SELECT * FROM ${this.tableName} WHERE ${pkColumn.columnName} = ${placeholder}`;
        const params: any[] = [id];

        // Structured query filters are appended to the SQL WHERE clause
        const filter = compileQueryFilter(metadata, provider, 2);
        if (filter.clauses.length > 0) {
            sql += ` AND ${filter.clauses.join(' AND ')}`;
            params.push(...filter.params);
        }

        const res = await this.context.query(sql, params);

        if (res.rows.length === 0) return null;
        const entity = this.mapRowToEntity(res.rows[0], true); // Track the entity

        // Predicate-form query filters are evaluated in memory
        if (metadata.queryFilter && !metadata.queryFilter(entity)) {
            return null;
        }
        return entity;
    }

    /**
     * Build the WHERE clause for this entity's structured query filters,
     * or an empty clause when none are configured.
     */
    private compileFilterWhere(): { where: string; params?: any[] } {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const filter = compileQueryFilter(metadata, this.context.getProvider(), 1);
        if (filter.clauses.length === 0) {
            return { where: '' };
        }
        return { where: ` WHERE ${filter.clauses.join(' AND ')}`, params: filter.params };
    }

    /**
     * Count all entities
     */
    async count(): Promise<number> {
        const filter = this.compileFilterWhere();
        const res = await this.context.query(`SELECT COUNT(*) as count FROM ${this.tableName}${filter.where}`, filter.params);
        return parseInt(res.rows[0].count);
    }

    /**
     * Sum a numeric property across all entities
     * @param selector Property selector function
     * @example await users.sum(u => u.salary)
     */
    async sum(selector: (entity: T) => number): Promise<number> {
        const columnName = resolveColumn(selector, this.entityType, 'sum');

        const filter = this.compileFilterWhere();
        const res = await this.context.query(`SELECT SUM(${columnName}) as total FROM ${this.tableName}${filter.where}`, filter.params);
        return parseFloat(res.rows[0].total) || 0;
    }

    /**
     * Calculate average of a numeric property
     * @param selector Property selector function
     * @example await users.average(u => u.age)
     */
    async average(selector: (entity: T) => number): Promise<number> {
        const columnName = resolveColumn(selector, this.entityType, 'average');

        const filter = this.compileFilterWhere();
        const res = await this.context.query(`SELECT AVG(${columnName}) as avg FROM ${this.tableName}${filter.where}`, filter.params);
        return parseFloat(res.rows[0].avg) || 0;
    }

    /**
     * Find minimum value of a property
     * @param selector Property selector function
     * @example await users.min(u => u.age)
     */
    async min(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'min');

        const filter = this.compileFilterWhere();
        const res = await this.context.query(`SELECT MIN(${columnName}) as min FROM ${this.tableName}${filter.where}`, filter.params);
        return res.rows[0].min;
    }

    /**
     * Find maximum value of a property
     * @param selector Property selector function
     * @example await users.max(u => u.createdAt)
     */
    async max(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'max');

        const filter = this.compileFilterWhere();
        const res = await this.context.query(`SELECT MAX(${columnName}) as max FROM ${this.tableName}${filter.where}`, filter.params);
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
        const propertyName = resolvePropertyName(selector, 'groupBy');
        const builder = new GroupedQueryBuilder(this.entityType, this.context, this.tableName, propertyName) as GroupedQueryBuilder<T, TKey>;
        return builder.applyQueryFilter();
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
        const metadata = MetadataStorage.get().getEntity(this.entityType);

        // Identity map lookup: if this row's (converted) primary key is already
        // tracked, return the SAME instance rather than mapping a new one -
        // the tracked instance's current values win over fresh database values
        // (EF Core semantics), so local unsaved modifications survive a re-query.
        const pk = track ? DbSet.resolvePkValue(metadata, row) : null;
        if (pk) {
            const existing = this.context.changeTracker.findByKey(this.entityType, pk.pkValue);
            if (existing !== undefined) {
                return existing as T;
            }
        }

        const entity = new this.entityType();
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
            if (pk) {
                this.context.changeTracker.registerIdentity(this.entityType, pk.pkValue, entity);
            }
        }

        return entity;
    }

    /**
     * Resolve the (converted) primary key value for a row, using the same
     * conversion the column mapping loop applies, so identity map keys stay
     * consistent with mapped entity property values.
     * Returns null when the entity is keyless or has no non-null pk value in
     * the row - those rows never touch the identity map.
     * @internal
     */
    private static resolvePkValue(metadata: any, row: any): { pkColumn: any; pkValue: any } | null {
        const pkColumn = metadata?.columns.find((c: any) => c.isPrimaryKey);
        if (!pkColumn) return null;

        let pkValue = row[pkColumn.columnName];
        if (pkColumn.hasConversion && pkColumn.convertFromDb) {
            pkValue = pkColumn.convertFromDb(pkValue);
        }

        if (pkValue === null || pkValue === undefined) return null;

        return { pkColumn, pkValue };
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
        const metadata = MetadataStorage.get().getEntity(entityType);
        const track = !noTracking && !!context;

        // Identity map lookup (see the instance mapRowToEntity for rationale).
        const pk = track ? DbSet.resolvePkValue(metadata, row) : null;
        if (pk) {
            const existing = context!.changeTracker.findByKey(entityType, pk.pkValue);
            if (existing !== undefined) {
                return existing as T;
            }
        }

        const entity = new entityType();
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
        if (track) {
            const originalValues = { ...entity };
            context!.changeTracker.track(entity, EntityState.Unchanged, originalValues);
            if (pk) {
                context!.changeTracker.registerIdentity(entityType, pk.pkValue, entity);
            }
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

    where(column: keyof T & string, operator: string, value: any): this;
    where(column: string, operator: string, value: any): this;
    where(column: string, operator: string, value: any): this {
        // Column and operator are validated against metadata and a closed
        // operator set before touching SQL (issues #13/#24); the value is
        // always bound as a parameter. buildComparison owns placeholder
        // expansion, so IN binds one placeholder per element and IS binds none
        //. The next condition numbers from the updated params length.
        const sqlColumn = assertColumn(this.entityType, column, 'where');
        const comparison = buildComparison(
            sqlColumn, operator, value, this.context.getProvider(), this.params.length + 1, 'where'
        );
        this.conditions.push(comparison.clause);
        this.params.push(...comparison.params);
        return this;
    }

    /**
     * Include related entities (eager loading)
     */
    include(relation: (entity: T) => any): this {
        const propertyName = resolvePropertyName(relation, 'include');
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
    orderBy(column: keyof T & string): this;
    orderBy(column: string): this;
    orderBy(column: string): this {
        this.orderByColumns.push({ column: assertColumn(this.entityType, column, 'orderBy'), direction: 'ASC' });
        return this;
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: keyof T & string): this;
    orderByDescending(column: string): this;
    orderByDescending(column: string): this {
        this.orderByColumns.push({ column: assertColumn(this.entityType, column, 'orderByDescending'), direction: 'DESC' });
        return this;
    }

    /**
     * Skip N results (for pagination)
     */
    skip(count: number): this {
        this.skipCount = assertLimit(count, 'skip');
        return this;
    }

    /**
     * Take N results (limit)
     */
    take(count: number): this {
        this.takeCount = assertLimit(count, 'take');
        return this;
    }

    /**
     * Enables no-tracking mode for this query.
     * Entities are not registered in the change tracker, so modifications
     * to them are not persisted by saveChanges().
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

    /**
     * Compile this entity's structured query filters (unless disabled) with
     * placeholder numbering continuing after the user-supplied parameters.
     */
    private compileFilters(): { clauses: string[]; params: any[] } {
        if (this.ignoreFilters) {
            return { clauses: [], params: [] };
        }
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        return compileQueryFilter(metadata, this.context.getProvider(), this.params.length + 1);
    }

    async toList(): Promise<T[]> {
        const provider = this.context.getProvider();
        const dialect = provider.getDialect();

        const filter = this.compileFilters();
        const allConditions = [...this.conditions, ...filter.clauses];
        const queryParams = [...this.params, ...filter.params];
        let whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";

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
        const res = await this.context.query(sql, queryParams);

        // Map rows to entities
        const entities = res.rows.map((row: any) =>
            DbSet.mapRowToEntity(this.entityType, row, this.noTracking, this.context)
        );

        // Predicate-form query filters are evaluated in memory (unless ignored)
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
        const filter = this.compileFilters();
        const allConditions = [...this.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.params, ...filter.params]);
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
        const columnName = resolveColumn(selector, this.entityType, 'sum');

        const filter = this.compileFilters();
        const allConditions = [...this.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT SUM(${columnName}) as total FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.params, ...filter.params]);
        return parseFloat(res.rows[0].total) || 0;
    }

    /**
     * Calculate average of a numeric property across filtered results
     * @param selector Property selector function
     */
    async average(selector: (entity: T) => number): Promise<number> {
        const columnName = resolveColumn(selector, this.entityType, 'average');

        const filter = this.compileFilters();
        const allConditions = [...this.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT AVG(${columnName}) as avg FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.params, ...filter.params]);
        return parseFloat(res.rows[0].avg) || 0;
    }

    /**
     * Find minimum value of a property across filtered results
     * @param selector Property selector function
     */
    async min(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'min');

        const filter = this.compileFilters();
        const allConditions = [...this.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT MIN(${columnName}) as min FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.params, ...filter.params]);
        return res.rows[0].min;
    }

    /**
     * Find maximum value of a property across filtered results
     * @param selector Property selector function
     */
    async max(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'max');

        const filter = this.compileFilters();
        const allConditions = [...this.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT MAX(${columnName}) as max FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.params, ...filter.params]);
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
        builder['ignoreFilters'] = this.ignoreFilters;
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
        const propertyName = resolvePropertyName(selector, 'groupBy');
        const builder = new GroupedQueryBuilder(this.entityType, this.context, this.tableName, propertyName) as GroupedQueryBuilder<T, TKey>;
        // Copy current query state (WHERE conditions)
        builder['conditions'] = [...this.conditions];
        builder['params'] = [...this.params];
        if (!this.ignoreFilters) {
            builder.applyQueryFilter();
        }
        return builder;
    }

    /**
     * Eager-load the requested relations for the already-materialized entities.
     *
     * Every related row is mapped with this query's context, so related
     * entities are change-tracked and identity-mapped exactly like the roots
     * are (issue #5's "wrong object graphs on eager load"): including an entity
     * that is already tracked yields the SAME instance, local edits included.
     * `asNoTracking()` still propagates and keeps the whole graph untracked.
     */
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
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking, this.context);
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
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking, this.context);
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
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking, this.context);
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
    private ignoreFilters: boolean = false;

    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private tableName: string,
        private selector: (entity: T) => TResult
    ) {}

    /**
     * Disables global query filters for this query.
     * @returns This query builder
     */
    ignoreQueryFilters(): this {
        this.ignoreFilters = true;
        return this;
    }

    /**
     * Compile this entity's structured query filters (unless disabled) with
     * placeholder numbering continuing after the user-supplied parameters.
     */
    private compileFilters(): { clauses: string[]; params: any[] } {
        if (this.ignoreFilters) {
            return { clauses: [], params: [] };
        }
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        return compileQueryFilter(metadata, this.context.getProvider(), this.params.length + 1);
    }

    /**
     * Add a WHERE condition
     */
    where(column: keyof T & string, operator: string, value: any): this;
    where(column: string, operator: string, value: any): this;
    where(column: string, operator: string, value: any): this {
        const sqlColumn = assertColumn(this.entityType, column, 'where');
        const comparison = buildComparison(
            sqlColumn, operator, value, this.context.getProvider(), this.params.length + 1, 'where'
        );
        this.conditions.push(comparison.clause);
        this.params.push(...comparison.params);
        return this;
    }

    /**
     * Order results by column ascending
     */
    orderBy(column: keyof T & string): this;
    orderBy(column: string): this;
    orderBy(column: string): this {
        this.orderByColumns.push({ column: assertColumn(this.entityType, column, 'orderBy'), direction: 'ASC' });
        return this;
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: keyof T & string): this;
    orderByDescending(column: string): this;
    orderByDescending(column: string): this {
        this.orderByColumns.push({ column: assertColumn(this.entityType, column, 'orderByDescending'), direction: 'DESC' });
        return this;
    }

    /**
     * Skip N results
     */
    skip(count: number): this {
        this.skipCount = assertLimit(count, 'skip');
        return this;
    }

    /**
     * Take N results
     */
    take(count: number): this {
        this.takeCount = assertLimit(count, 'take');
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
        const filter = this.compileFilters();
        const allConditions = [...this.conditions, ...filter.clauses];
        const queryParams = [...this.params, ...filter.params];
        let whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";

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

        const res = await this.context.query(sql, queryParams);

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
        const filter = this.compileFilters();
        const allConditions = [...this.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.params, ...filter.params]);
        return parseInt(res.rows[0].count);
    }

    /**
     * Try to extract projected column names from the selector for SQL optimization.
     * Returns null if the selector is too complex for SQL projection (e.g. it computes
     * a value rather than naming columns) - callers fall back to in-memory projection.
     * Throws if the selector names a property that isn't a mapped column: an unmapped
     * property is a caller bug, not something to silently degrade into a full-table scan.
     */
    private extractProjectedColumns(): string[] | null {
        const result = capture(this.selector as unknown as (entity: any) => any);
        if (result.kind === "opaque") {
            // Honest fallback: the selector computes something SQL cannot express,
            // so fetch full rows and project in memory.
            return null;
        }

        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const columnFor = (propertyName: string): string => {
            const column = metadata?.columns.find(c => c.propertyName === propertyName);
            if (!column) {
                throw new Error(
                    `select(): property '${propertyName}' is not a mapped column on ${this.entityType.name}`
                );
            }
            return column.columnName;
        };

        if (result.kind === "property") {
            return [columnFor(result.path)];
        }

        return Object.entries(result.aliases).map(
            ([alias, propertyName]) => `${columnFor(propertyName)} AS ${alias}`
        );
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

        // Raw SQL cannot be rewritten, so global query filters (both forms)
        // are evaluated in memory here
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        return entities.filter((e: T) => matchesQueryFilter(metadata, e));
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

        // Raw SQL cannot be rewritten, so global query filters (both forms)
        // are evaluated in memory here
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        return entities.filter((e: T) => matchesQueryFilter(metadata, e));
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
    private queryFilterApplied: boolean = false;

    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private tableName: string,
        private groupByProperty: string
    ) {}

    /**
     * Inject compiled global query filters as WHERE conditions.
     * @internal Called by the groupBy() factories, and deliberately BEFORE the
     * caller can invoke having(): having() bakes placeholder indices from the
     * current params length at call time, so filters appended any later would
     * silently shift every HAVING placeholder (issue #23. GroupBy was the
     * last read path that ignored structured query filters). Function-valued
     * filter conditions are therefore resolved when groupBy() is called.
     */
    applyQueryFilter(): this {
        // Idempotent: calling it twice would append the filter clauses (and
        // their parameters) a second time, shifting every later placeholder.
        if (this.queryFilterApplied) {
            return this;
        }
        this.queryFilterApplied = true;
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const filter = compileQueryFilter(metadata, this.context.getProvider(), this.params.length + 1);
        this.conditions.push(...filter.clauses);
        this.params.push(...filter.params);
        return this;
    }

    /**
     * Filter groups using HAVING clause
     * @param column Aggregate column or group column
     * @param operator Comparison operator
     * @param value Value to compare
     * @example groupBy(u => u.dept).having('COUNT(*)', '>', 5)
     */
    having(column: string, operator: string, value: any): this {
        // Only aggregate-over-mapped-column expressions or mapped columns are
        // accepted; the operator comes from the closed set (issues #13/#24).
        // HAVING placeholders are numbered after the WHERE parameters, which is
        // why applyQueryFilter() must have run before this point.
        const sqlExpression = assertHavingExpression(this.entityType, column, 'having');
        const comparison = buildComparison(
            sqlExpression,
            operator,
            value,
            this.context.getProvider(),
            this.params.length + this.havingParams.length + 1,
            'having'
        );
        this.havingConditions.push(comparison.clause);
        this.havingParams.push(...comparison.params);
        return this;
    }

    /**
     * Order grouped results. Accepts a mapped column or a projection alias
     * from the select() list; aliases must be plain identifiers.
     */
    orderBy(column: string): this {
        this.orderByColumns.push({ column: assertColumnOrAlias(this.entityType, column, 'orderBy'), direction: 'ASC' });
        return this;
    }

    /**
     * Order grouped results descending
     */
    orderByDescending(column: string): this {
        this.orderByColumns.push({ column: assertColumnOrAlias(this.entityType, column, 'orderByDescending'), direction: 'DESC' });
        return this;
    }

    /**
     * Skip N groups
     */
    skip(count: number): this {
        this.skipCount = assertLimit(count, 'skip');
        return this;
    }

    /**
     * Take N groups
     */
    take(count: number): this {
        this.takeCount = assertLimit(count, 'take');
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

        // Extract aggregations (and, if present, the g.key alias) from the
        // result selector via property capture.
        const selectClauses = this.captureAggregations(groupColumn.columnName);

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

        // Pagination (database-specific)
        if (this.context.getProvider().getDialect() === 'mssql') {
            if (this.skipCount !== undefined || this.takeCount !== undefined) {
                // MSSQL requires ORDER BY for OFFSET/FETCH
                if (this.orderByColumns.length === 0) {
                    sql += ` ORDER BY (SELECT NULL)`;
                }
                sql += ` OFFSET ${this.skipCount ?? 0} ROWS`;
                if (this.takeCount !== undefined) {
                    sql += ` FETCH NEXT ${this.takeCount} ROWS ONLY`;
                }
            }
        } else {
            if (this.takeCount !== undefined) {
                sql += ` LIMIT ${this.takeCount}`;
            }
            if (this.skipCount !== undefined) {
                sql += ` OFFSET ${this.skipCount}`;
            }
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
     * Capture the result selector's `g.key` / aggregate calls (g.count(),
     * g.sum(x => x.col), ...) and resolve each referenced property to its
     * mapped column name, producing the list of SELECT clauses in the order
     * the selector declared them.
     *
     * Throws if the selector isn't a plain object of supported entries, or if
     * an aggregate references a property that isn't a mapped column - an honest
     * failure in place of the previous regex silently dropping the aggregate.
     *
     * When the selector contains no `g.key` entry, the grouping column is
     * still emitted first, bare (un-aliased) - this preserves the exact SQL
     * shape of every pre-existing groupBy().select() call site that never
     * referenced `g.key`.
     */
    private captureAggregations(groupColumnName: string): string[] {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        const columnFor = (propertyName: string): string => {
            const column = metadata?.columns.find(c => c.propertyName === propertyName);
            if (!column) {
                throw new Error(
                    `groupBy().select(): property '${propertyName}' is not a mapped column on ${this.entityType.name}`
                );
            }
            return column.columnName;
        };

        const result = captureAggregates(this.selector as unknown as (group: any) => any);
        if (result.kind === "opaque") {
            throw new Error(
                "groupBy().select(): result selector must build an object literal from " +
                "g.key, g.count(), g.sum(x => x.col), g.average(x => x.col), g.min(x => x.col), or g.max(x => x.col)"
            );
        }

        const entries = Object.entries(result.aggregates);
        const clauseFor = ([alias, entry]: [string, AggregateSelectorEntry]): string => {
            if ('kind' in entry) {
                return `${groupColumnName} AS ${alias}`;
            }
            // count() is the only aggregate that is meaningful without a column
            // (it renders COUNT(*)). Every other one needs a selector, or the
            // rendered SQL would read `SUM(undefined)`.
            if (entry.fn !== 'count' && entry.path === undefined) {
                throw new Error(
                    `groupBy().select(): g.${entry.fn}() requires a column selector, ` +
                    `e.g. g.${entry.fn}(x => x.total)`
                );
            }
            const column = entry.path ? columnFor(entry.path) : undefined;
            return `${AGG_SQL[entry.fn](column)} as ${alias}`;
        };

        const hasKey = entries.some(([, entry]) => 'kind' in entry);
        if (hasKey) {
            return entries.map(clauseFor);
        }

        // No g.key entry: preserve the original bare-group-column-first shape.
        return [groupColumnName, ...entries.map(clauseFor)];
    }
}
