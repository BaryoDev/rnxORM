import { DbContext } from "../DbContext";
import { DatabaseRow, QueryParameter, ExactNumeric } from "../types";
import { EntityState, snapshotEntity } from "../EntityEntry";
import { resolveColumn, resolvePropertyName } from "../expressions/PropertyCapture";
import { compileQueryFilter } from "../QueryFilter";
import { toCount, toExactNumber } from "../Numerics";
import { convertValueToDb } from "../Identifiers";
import { mapRowToEntity, resolvePkValue } from "./EntityMapper";
import { QueryBuilder } from "./QueryBuilder";
import { SelectQueryBuilder } from "./SelectQueryBuilder";
import { RawSqlQueryBuilder } from "./RawSqlQueryBuilder";
import { GroupedQueryBuilder } from "./GroupedQueryBuilder";

/**
 * Represents a collection of entities in the database.
 * @template T The type of entity.
 */
export class DbSet<T> {
    private tableName: string;
    private columns: string[];

    constructor(private entityType: new () => T, private context: DbContext) {
        const metadata = this.context.metadata.getEntity(entityType);
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
        const metadata = this.context.metadata.getEntity(this.entityType);

        // Structured query filters are translated to SQL so filtered rows
        // never leave the database; use ignoreQueryFilters() to bypass.
        const filter = compileQueryFilter(metadata, provider, 1);
        let sql = provider.generateSelectSql(this.tableName);
        if (filter.clauses.length > 0) {
            sql += ` WHERE ${filter.clauses.join(' AND ')}`;
        }

        const res = await this.context.query(sql, filter.clauses.length > 0 ? filter.params : undefined);
        const entities = res.rows.map((row: DatabaseRow) => this.mapRowToEntity(row, true));

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
        const metadata = this.context.metadata.getEntity(this.entityType);
        if (!metadata) return null;

        const pkColumn = metadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) throw new Error("Primary key not defined");

        const provider = this.context.getProvider();
        const placeholder = provider.getParameterPlaceholder(1);
        let sql = `SELECT * FROM ${this.tableName} WHERE ${pkColumn.columnName} = ${placeholder}`;
        // A converted key is stored in its converted form, so the caller's
        // domain value has to go through the converter before it is bound, the
        // way updateEntity()/deleteEntity() already do it (issue #35).
        const params: QueryParameter[] = [convertValueToDb(pkColumn, id)];

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
    private compileFilterWhere(): { where: string; params?: QueryParameter[] } {
        const metadata = this.context.metadata.getEntity(this.entityType);
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
        return toCount(res.rows[0]?.count);
    }

    /**
     * Sum a numeric property across all entities
     * @param selector Property selector function
     * @example await users.sum(u => u.salary)
     */
    async sum(selector: (entity: T) => number): Promise<ExactNumeric> {
        const columnName = resolveColumn(selector, this.entityType, 'sum');

        const filter = this.compileFilterWhere();
        const res = await this.context.query(`SELECT SUM(${columnName}) as total FROM ${this.tableName}${filter.where}`, filter.params);
        return toExactNumber(res.rows[0]?.total) ?? 0;
    }

    /**
     * Calculate average of a numeric property
     * @param selector Property selector function
     * @example await users.average(u => u.age)
     */
    async average(selector: (entity: T) => number): Promise<ExactNumeric> {
        const columnName = resolveColumn(selector, this.entityType, 'average');

        const filter = this.compileFilterWhere();
        const res = await this.context.query(`SELECT AVG(${columnName}) as avg FROM ${this.tableName}${filter.where}`, filter.params);
        return toExactNumber(res.rows[0]?.avg) ?? 0;
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
    fromSqlRaw(sql: string, parameters?: QueryParameter[]): RawSqlQueryBuilder<T> {
        return new RawSqlQueryBuilder(this.entityType, this.context, sql, parameters);
    }

    private mapRowToEntity(row: any, track: boolean = false): T {
        const metadata = this.context.metadata.getEntity(this.entityType);

        // Identity map lookup: if this row's (converted) primary key is already
        // tracked, return the SAME instance rather than mapping a new one -
        // the tracked instance's current values win over fresh database values
        // (EF Core semantics), so local unsaved modifications survive a re-query.
        const pk = track ? resolvePkValue(metadata, row) : null;
        if (pk) {
            const existing = this.context.changeTracker.findByKey(this.entityType, pk.pkValue);
            if (existing !== undefined) {
                return existing as T;
            }
        }

        const entity = new this.entityType();
        metadata?.columns.forEach(col => {
            let value = row[col.columnName];

            if (col.hasConversion && col.convertFromDb) {
                value = col.convertFromDb(value);
            }

            // Only set non-shadow properties on the entity
            if (!col.isShadowProperty) {
                (entity as any)[col.propertyName] = value;
            }
        });

        if (track) {
            const originalValues = snapshotEntity(entity);
            this.context.changeTracker.track(entity, EntityState.Unchanged, originalValues);
            if (pk) {
                this.context.changeTracker.registerIdentity(this.entityType, pk.pkValue, entity);
            }
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
        return mapRowToEntity(entityType, row, noTracking, context);
    }
}
