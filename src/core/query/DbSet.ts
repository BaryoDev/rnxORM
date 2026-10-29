import { DbContext } from "../DbContext";
import { DatabaseRow, QueryParameter, ExactNumeric } from "../types";
import { EntityState } from "../EntityEntry";
import { resolveColumn, resolvePropertyName } from "../expressions/PropertyCapture";
import { queryFilterPredicates } from "../QueryFilter";
import { Predicate } from "./model/Predicate";
import { AggregateFn } from "./model/Operand";
import { SelectModel } from "./model/SelectModel";
import { toCount, toExactNumber } from "../Numerics";
import { columnTypeOf, convertValueToDb } from "../Identifiers";
import { mapRowToEntity } from "./EntityMapper";
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
        const metadata = this.context.metadata.getEntity(this.entityType);

        // Structured query filters are translated to SQL so filtered rows
        // never leave the database; use ignoreQueryFilters() to bypass.
        const where = this.filterWhere();
        const stmt = this.translate({ table: this.tableName, where });
        const res = await this.context.query(stmt.text, where ? stmt.params : undefined);
        const entities = res.rows.map((row: DatabaseRow) => mapRowToEntity(this.entityType, row, false, this.context));

        // Predicate-form query filters are evaluated in memory
        if (metadata?.queryFilter) {
            return entities.filter(metadata.queryFilter);
        }
        return entities;
    }

    // usage: dbSet.where(u => gt(u.age, 18)).toList()
    /**
     * Add a WHERE condition built with the condition builders:
     * `where(u => eq(u.email, x))`. Builders are imported from 'rnxorm'.
     */
    where(condition: (entity: T) => Predicate): QueryBuilder<T>;
    /** @deprecated Use `where(u => eq(u.age, 18))` with the condition builders. Removed in 4.0. */
    where(column: keyof T & string, operator: string, value: any): QueryBuilder<T>;
    /** @deprecated Use `where(u => eq(u.age, 18))` with the condition builders. Removed in 4.0. */
    where(column: string, operator: string, value: any): QueryBuilder<T>;
    where(first: string | ((entity: T) => Predicate), operator?: string, value?: any): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).where(first as string, operator as string, value);
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

        // A converted key is stored in its converted form, so the caller's
        // domain value has to go through the converter before it is bound, the
        // way updateEntity()/deleteEntity() already do it (issue #35).
        const pk: Predicate = {
            op: 'eq',
            left: { kind: 'column', name: pkColumn.columnName },
            value: convertValueToDb(pkColumn, id),
        };
        // Structured query filters are ANDed after the key
        const stmt = this.translate({ table: this.tableName, where: this.andAll([pk, ...queryFilterPredicates(metadata)]) });
        const res = await this.context.query(stmt.text, stmt.params);

        if (res.rows.length === 0) return null;
        const entity = mapRowToEntity(this.entityType, res.rows[0], false, this.context); // Track the entity

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
    private filterWhere(): Predicate | undefined {
        const metadata = this.context.metadata.getEntity(this.entityType);
        return this.andAll(queryFilterPredicates(metadata));
    }

    private andAll(parts: Predicate[]): Predicate | undefined {
        if (parts.length === 0) return undefined;
        if (parts.length === 1) return parts[0];
        return { op: 'and', parts };
    }

    private translate(model: SelectModel) {
        return this.context.getProvider().getTranslator().translateSelect(model);
    }

    private async aggregate(fn: AggregateFn, column: string | undefined, alias: string, columnType?: string): Promise<any> {
        const where = this.filterWhere();
        const stmt = this.translate({
            table: this.tableName,
            items: [{ operand: { kind: 'agg', fn, column, columnType }, alias }],
            where,
        });
        const res = await this.context.query(stmt.text, where ? stmt.params : undefined);
        return res.rows[0];
    }

    /**
     * Count all entities
     */
    async count(): Promise<number> {
        const row = await this.aggregate('count', undefined, 'count');
        return toCount(row?.count);
    }

    /**
     * Sum a numeric property across all entities
     * @param selector Property selector function
     * @example await users.sum(u => u.salary)
     */
    async sum(selector: (entity: T) => number): Promise<ExactNumeric> {
        const columnName = resolveColumn(selector, this.entityType, 'sum');

        const row = await this.aggregate('sum', columnName, 'total', columnTypeOf(this.entityType, columnName));
        return toExactNumber(row?.total) ?? 0;
    }

    /**
     * Calculate average of a numeric property
     * @param selector Property selector function
     * @example await users.average(u => u.age)
     */
    async average(selector: (entity: T) => number): Promise<ExactNumeric> {
        const columnName = resolveColumn(selector, this.entityType, 'average');

        const row = await this.aggregate('avg', columnName, 'avg', columnTypeOf(this.entityType, columnName));
        return toExactNumber(row?.avg) ?? 0;
    }

    /**
     * Find minimum value of a property
     * @param selector Property selector function
     * @example await users.min(u => u.age)
     */
    async min(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'min');

        const row = await this.aggregate('min', columnName, 'min', columnTypeOf(this.entityType, columnName));
        return row.min;
    }

    /**
     * Find maximum value of a property
     * @param selector Property selector function
     * @example await users.max(u => u.createdAt)
     */
    async max(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'max');

        const row = await this.aggregate('max', columnName, 'max', columnTypeOf(this.entityType, columnName));
        return row.max;
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
}
