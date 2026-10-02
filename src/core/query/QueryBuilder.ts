import { DbContext } from "../DbContext";
import { QueryState } from "../QueryState";
import { DatabaseRow, QueryParameter, asQueryParameter, assertNever } from "../types";
import { RelationType, EntityMetadata } from "../MetadataStorage";
import { resolveColumn, resolvePropertyName } from "../expressions/PropertyCapture";
import { compileQueryFilter } from "../QueryFilter";
import { toCount, toExactNumber } from "../Numerics";
import { assertColumn, assertLimit, buildComparison, convertValueToDb, findColumn } from "../Identifiers";
import { mapRowToEntity } from "./EntityMapper";
import { SelectQueryBuilder } from "./SelectQueryBuilder";
import { GroupedQueryBuilder } from "./GroupedQueryBuilder";

interface IncludeInfo {
    propertyName: string;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    relatedEntityType: Function;
}

export class QueryBuilder<T> {
    /** WHERE conditions, bound params, ordering and row limits. */
    private readonly state = new QueryState();
    private noTracking: boolean = false;
    private includes: IncludeInfo[] = [];

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
            sqlColumn, operator, value, this.context.getProvider(), this.state.params.length + 1, 'where',
            findColumn(this.entityType, column)
        );
        this.state.conditions.push(comparison.clause);
        this.state.params.push(...comparison.params);
        return this;
    }

    /**
     * Include related entities (eager loading)
     */
    include(relation: (entity: T) => any): this {
        const propertyName = resolvePropertyName(relation, 'include');
        const metadata = this.context.metadata.getEntity(this.entityType);

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
        this.state.orderByColumns.push({ column: assertColumn(this.entityType, column, 'orderBy'), direction: 'ASC' });
        return this;
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: keyof T & string): this;
    orderByDescending(column: string): this;
    orderByDescending(column: string): this {
        this.state.orderByColumns.push({ column: assertColumn(this.entityType, column, 'orderByDescending'), direction: 'DESC' });
        return this;
    }

    /**
     * Skip N results (for pagination)
     */
    skip(count: number): this {
        this.state.skipCount = assertLimit(count, 'skip');
        return this;
    }

    /**
     * Take N results (limit)
     */
    take(count: number): this {
        this.state.takeCount = assertLimit(count, 'take');
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
        this.state.ignoreFilters = true;
        return this;
    }

    /**
     * Compile this entity's structured query filters (unless disabled) with
     * placeholder numbering continuing after the user-supplied parameters.
     */
    private compileFilters(): { clauses: string[]; params: QueryParameter[] } {
        if (this.state.ignoreFilters) {
            return { clauses: [], params: [] };
        }
        const metadata = this.context.metadata.getEntity(this.entityType);
        return compileQueryFilter(metadata, this.context.getProvider(), this.state.params.length + 1);
    }

    /**
     * Refuse a row-limited query whose entity has a predicate-form query filter.
     *
     * The predicate runs in memory, after LIMIT/OFFSET has already been applied
     * by the database, so it drops rows out of an already-truncated page: a
     * `take(20)` comes back with however many of those 20 survived, and
     * `first()` (take(1)) returns null while matching rows sit unread. There is
     * no ordering of the two that gives the right answer, so the combination
     * fails loudly instead of returning a wrong one quietly (issue #45).
     *
     * The structured filter form compiles to SQL and is unaffected.
     */
    private assertNoInMemoryFilterWithRowLimit(): void {
        if (this.state.ignoreFilters) return;
        if (this.state.skipCount === undefined && this.state.takeCount === undefined) return;

        const metadata = this.context.metadata.getEntity(this.entityType);
        if (!metadata?.queryFilter) return;

        throw new Error(
            `${this.entityType.name} has an in-memory query filter (the predicate form of ` +
            `hasQueryFilter), which is applied after the database has already applied ` +
            `LIMIT/OFFSET, so skip()/take()/first()/single() would return a wrong result. ` +
            `Use the structured filter form ({ property, operator, value }), which compiles ` +
            `to SQL, or call ignoreQueryFilters() to opt out of filtering for this query.`
        );
    }

    async toList(): Promise<T[]> {
        this.assertNoInMemoryFilterWithRowLimit();

        const provider = this.context.getProvider();
        const dialect = provider.getDialect();

        const filter = this.compileFilters();
        const allConditions = [...this.state.conditions, ...filter.clauses];
        const queryParams = [...this.state.params, ...filter.params];
        let whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";

        if (this.state.orderByColumns.length > 0) {
            const orderByClause = this.state.orderByColumns
                .map(o => `${o.column} ${o.direction}`)
                .join(', ');
            whereClause += (whereClause ? ' ' : '') + `ORDER BY ${orderByClause}`;
        }

        if (dialect === 'mssql') {
            // MSSQL uses OFFSET/FETCH syntax (requires ORDER BY)
            if (this.state.skipCount !== undefined || this.state.takeCount !== undefined) {
                // MSSQL requires ORDER BY for OFFSET/FETCH
                if (this.state.orderByColumns.length === 0) {
                    whereClause += (whereClause ? ' ' : '') + 'ORDER BY (SELECT NULL)';
                }
                whereClause += ` OFFSET ${this.state.skipCount ?? 0} ROWS`;
                if (this.state.takeCount !== undefined) {
                    whereClause += ` FETCH NEXT ${this.state.takeCount} ROWS ONLY`;
                }
            }
        } else {
            // PostgreSQL/MariaDB use LIMIT/OFFSET
            if (this.state.takeCount !== undefined) {
                whereClause += ` LIMIT ${this.state.takeCount}`;
            }
            if (this.state.skipCount !== undefined) {
                whereClause += ` OFFSET ${this.state.skipCount}`;
            }
        }

        let selectClause = "SELECT *";
        if (this.state.isDistinct) {
            selectClause = "SELECT DISTINCT *";
        }

        const sql = `${selectClause} FROM ${this.tableName}${whereClause ? ' ' + whereClause : ''}`;
        const res = await this.context.query(sql, queryParams);

        const entities = res.rows.map((row: DatabaseRow) =>
            mapRowToEntity(this.entityType, row, this.noTracking, this.context)
        );

        // Predicate-form query filters are evaluated in memory (unless ignored)
        let filteredEntities = entities;
        if (!this.state.ignoreFilters) {
            const metadata = this.context.metadata.getEntity(this.entityType);
            if (metadata?.queryFilter) {
                filteredEntities = entities.filter(metadata.queryFilter);
            }
        }

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
        const allConditions = [...this.state.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.state.params, ...filter.params]);
        return toCount(res.rows[0]?.count);
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
        const allConditions = [...this.state.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT SUM(${columnName}) as total FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.state.params, ...filter.params]);
        return toExactNumber(res.rows[0]?.total) ?? 0;
    }

    /**
     * Calculate average of a numeric property across filtered results
     * @param selector Property selector function
     */
    async average(selector: (entity: T) => number): Promise<number> {
        const columnName = resolveColumn(selector, this.entityType, 'average');

        const filter = this.compileFilters();
        const allConditions = [...this.state.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT AVG(${columnName}) as avg FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.state.params, ...filter.params]);
        return toExactNumber(res.rows[0]?.avg) ?? 0;
    }

    /**
     * Find minimum value of a property across filtered results
     * @param selector Property selector function
     */
    async min(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'min');

        const filter = this.compileFilters();
        const allConditions = [...this.state.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT MIN(${columnName}) as min FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.state.params, ...filter.params]);
        return res.rows[0].min;
    }

    /**
     * Find maximum value of a property across filtered results
     * @param selector Property selector function
     */
    async max(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'max');

        const filter = this.compileFilters();
        const allConditions = [...this.state.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT MAX(${columnName}) as max FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.state.params, ...filter.params]);
        return res.rows[0].max;
    }

    /**
     * Project entities to a different shape
     * @param selector Projection function
     */
    select<TResult>(selector: (entity: T) => TResult): SelectQueryBuilder<T, TResult> {
        const builder = new SelectQueryBuilder(this.entityType, this.context, this.tableName, selector);
        builder.adoptState(this.state.clone());
        return builder;
    }

    /**
     * Remove duplicate entities
     */
    distinct(): this {
        this.state.isDistinct = true;
        return this;
    }

    /**
     * Group filtered results by a property
     * @param selector Property selector function
     */
    groupBy<TKey>(selector: (entity: T) => TKey): GroupedQueryBuilder<T, TKey> {
        const propertyName = resolvePropertyName(selector, 'groupBy');
        const builder = new GroupedQueryBuilder(this.entityType, this.context, this.tableName, propertyName) as GroupedQueryBuilder<T, TKey>;
        // Only the WHERE state carries over: a GROUP BY re-derives its own
        // ordering and row limits, so cloning them would apply the outer
        // query's LIMIT to the grouped result.
        builder.adoptWhere(this.state.conditions, this.state.params);
        if (!this.state.ignoreFilters) {
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
    /**
     * Compile the related entity's global query filters for an include query.
     *
     * Filters were compiled into the root query but not into the queries that
     * load related entities, so an include returned rows the filter was meant
     * to hide: soft-deleted children, or another tenant's rows under a tenant
     * filter (issue #37). Placeholders continue after the key list the caller
     * has already bound. `ignoreQueryFilters()` on the root query propagates
     * here, since it is the same logical read.
     */
    private compileRelatedFilter(
        relatedMetadata: EntityMetadata,
        boundParamCount: number
    ): { clause: string; params: QueryParameter[] } {
        if (this.state.ignoreFilters) {
            return { clause: '', params: [] };
        }
        const filter = compileQueryFilter(
            relatedMetadata,
            this.context.getProvider(),
            boundParamCount + 1
        );
        return {
            clause: filter.clauses.length > 0 ? ` AND ${filter.clauses.join(' AND ')}` : '',
            params: filter.params,
        };
    }

    private async loadIncludes(entities: T[]): Promise<void> {
        if (entities.length === 0) return;

        const metadata = this.context.metadata.getEntity(this.entityType);
        if (!metadata) return;

        for (const include of this.includes) {
            const relationMetadata = metadata.relations.find(r => r.propertyName === include.propertyName);
            if (!relationMetadata) continue;

            const relatedMetadata = this.context.metadata.getEntity(include.relatedEntityType);
            if (!relatedMetadata) continue;

            const relatedPkColumn = relatedMetadata.columns.find(c => c.isPrimaryKey);
            if (!relatedPkColumn) continue;

            switch (relationMetadata.relationType) {
                case RelationType.ManyToOne:
                case RelationType.OneToOne:
                    await this.loadManyToOneRelation(entities, relationMetadata, relatedMetadata, relatedPkColumn.columnName);
                    break;

                case RelationType.OneToMany:
                    await this.loadOneToManyRelation(entities, relationMetadata, relatedMetadata);
                    break;

                case RelationType.ManyToMany:
                    await this.loadManyToManyRelation(entities, relationMetadata, relatedMetadata);
                    break;

                case RelationType.OwnsOne:
                case RelationType.OwnsMany:
                    // ModelBuilder can declare these, but no loader implements
                    // them: include() used to return silently with the
                    // navigation left undefined. Saying so beats a caller
                    // debugging an empty collection.
                    throw new Error(
                        `include('${include.propertyName}'): owned types are not supported by eager loading yet. ` +
                        `Map the relation as one-to-many or many-to-one instead.`
                    );

                default:
                    assertNever(relationMetadata.relationType, 'loadIncludes');
            }
        }
    }

    private async loadManyToOneRelation(
        entities: T[],
        relationMetadata: any,
        relatedMetadata: EntityMetadata,
        relatedPkColumn: string
    ): Promise<void> {
        const foreignKeyColumn = relationMetadata.foreignKeyColumn;
        if (!foreignKeyColumn) return;

        const foreignKeyValues = entities
            .map(e => (e as any)[foreignKeyColumn])
            .filter(v => v !== null && v !== undefined);

        if (foreignKeyValues.length === 0) return;

        const uniqueFkValues = [...new Set(foreignKeyValues)];
        const placeholders = uniqueFkValues.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const filter = this.compileRelatedFilter(relatedMetadata, uniqueFkValues.length);
        const sql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${relatedPkColumn} IN (${placeholders})${filter.clause}`;
        const res = await this.context.query(sql, [...uniqueFkValues, ...filter.params]);

        const relatedEntitiesMap = new Map();
        res.rows.forEach((row: DatabaseRow) => {
            const relatedEntity = mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking, this.context);
            relatedEntitiesMap.set(row[relatedPkColumn], relatedEntity);
        });

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
        relatedMetadata: EntityMetadata
    ): Promise<void> {
        const entityMetadata = this.context.metadata.getEntity(this.entityType);
        if (!entityMetadata) return;

        const pkColumn = entityMetadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) return;

        // Find the foreign key column on the related entity
        const inverseSide = relationMetadata.inverseSide;
        const relatedRelation = relatedMetadata.relations.find((r) => r.propertyName === inverseSide);
        if (!relatedRelation || !relatedRelation.foreignKeyColumn) return;

        const foreignKeyColumn = relatedRelation.foreignKeyColumn;

        // Get all primary key values. These come off the entity in domain form,
        // but the FK column stores the converted form, so a converted key has
        // to be converted before it is bound or the IN () matches nothing and
        // the collection silently comes back empty (issue #35).
        const pkValues = entities.map(e => convertValueToDb(pkColumn, (e as any)[pkColumn.propertyName]));

        const placeholders = pkValues.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const filter = this.compileRelatedFilter(relatedMetadata, pkValues.length);
        const sql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${foreignKeyColumn} IN (${placeholders})${filter.clause}`;
        const res = await this.context.query(sql, [...pkValues, ...filter.params]);

        const relatedEntitiesMap = new Map<any, any[]>();
        res.rows.forEach((row: DatabaseRow) => {
            const relatedEntity = mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking, this.context);
            const fkValue = row[foreignKeyColumn];

            if (!relatedEntitiesMap.has(fkValue)) {
                relatedEntitiesMap.set(fkValue, []);
            }
            relatedEntitiesMap.get(fkValue)!.push(relatedEntity);
        });

        entities.forEach(entity => {
            // The map is keyed by the row's FK value (database form), so the
            // entity's key is converted the same way before the lookup.
            const pkValue = convertValueToDb(pkColumn, (entity as any)[pkColumn.propertyName]);
            (entity as any)[relationMetadata.propertyName] = relatedEntitiesMap.get(pkValue) || [];
        });
    }

    private async loadManyToManyRelation(
        entities: T[],
        relationMetadata: any,
        relatedMetadata: EntityMetadata
    ): Promise<void> {
        if (!relationMetadata.joinTable) return;

        const entityMetadata = this.context.metadata.getEntity(this.entityType);
        if (!entityMetadata) return;

        const pkColumn = entityMetadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) return;

        // Converted keys are stored converted in the join table too (issue #35).
        const pkValues = entities.map(e => convertValueToDb(pkColumn, (e as any)[pkColumn.propertyName]));

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

        const relatedIds = joinRes.rows.map((r) => r[relationMetadata.inverseJoinColumn!]);
        const uniqueRelatedIds = [...new Set(relatedIds)];

        const relatedPkColumn = relatedMetadata.columns.find((c) => c.isPrimaryKey);
        if (!relatedPkColumn) return;

        const relatedPlaceholders = uniqueRelatedIds.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const relatedFilter = this.compileRelatedFilter(relatedMetadata, uniqueRelatedIds.length);
        const relatedSql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${relatedPkColumn.columnName} IN (${relatedPlaceholders})${relatedFilter.clause}`;
        const relatedRes = await this.context.query(relatedSql, [...uniqueRelatedIds.map(asQueryParameter), ...relatedFilter.params]);

        const relatedEntitiesMap = new Map();
        relatedRes.rows.forEach((row: DatabaseRow) => {
            const relatedEntity = mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking, this.context);
            relatedEntitiesMap.set(row[relatedPkColumn.columnName], relatedEntity);
        });

        const relationMap = new Map<any, any[]>();
        joinRes.rows.forEach((joinRow: DatabaseRow) => {
            const sourceId = joinRow[relationMetadata.joinColumn!];
            const targetId = joinRow[relationMetadata.inverseJoinColumn!];

            if (!relationMap.has(sourceId)) {
                relationMap.set(sourceId, []);
            }

            if (relatedEntitiesMap.has(targetId)) {
                relationMap.get(sourceId)!.push(relatedEntitiesMap.get(targetId));
            }
        });

        entities.forEach(entity => {
            // relationMap is keyed by the join row's source id (database form).
            const pkValue = convertValueToDb(pkColumn, (entity as any)[pkColumn.propertyName]);
            (entity as any)[relationMetadata.propertyName] = relationMap.get(pkValue) || [];
        });
    }
}
