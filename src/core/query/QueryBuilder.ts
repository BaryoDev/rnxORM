import { DbContext } from "../DbContext";
import { QueryState } from "../QueryState";
import { DatabaseRow, QueryParameter, asQueryParameter, assertNever, ExactNumeric } from "../types";
import { RelationType, EntityMetadata } from "../MetadataStorage";
import { resolveColumn, resolvePropertyName } from "../expressions/PropertyCapture";
import { buildWhere } from "../expressions/conditions";
import { queryFilterPredicates } from "../QueryFilter";
import { toCount, toExactNumber } from "../Numerics";
import { assertColumn, assertLimit, convertValueToDb, columnTypeOf, WhereOperator } from "../Identifiers";
import { Predicate } from "./model/Predicate";
import { AggregateFn } from "./model/Operand";
import { SelectModel } from "./model/SelectModel";
import { SqlStatement } from "./model/SqlStatement";
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

    /**
     * Add a WHERE condition built with the condition builders:
     * `where(u => eq(u.email, x))`. Builders are imported from 'rnxorm'.
     */
    where(condition: (entity: T) => Predicate): this;
    /** @deprecated Use `where(u => eq(u.age, 18))` with the condition builders. Removed in 4.0. */
    where(column: keyof T & string, operator: WhereOperator, value: any): this;
    where(first: (keyof T & string) | ((entity: T) => Predicate), operator?: string, value?: any): this {
        // The lambda is recorded, the string form is validated against metadata and a
        // closed operator set (issues #13/#24). Both resolve through one path, and
        // values are always bound as parameters.
        this.state.predicates.push(buildWhere(this.entityType, first, operator, value));
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
    orderBy(selector: (entity: T) => unknown): this;
    orderBy(column: (keyof T & string) | ((entity: T) => unknown)): this {
        this.state.orderByColumns.push({ column: this.orderColumn(column, 'orderBy'), direction: 'ASC' });
        return this;
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: keyof T & string): this;
    orderByDescending(selector: (entity: T) => unknown): this;
    orderByDescending(column: (keyof T & string) | ((entity: T) => unknown)): this {
        this.state.orderByColumns.push({ column: this.orderColumn(column, 'orderByDescending'), direction: 'DESC' });
        return this;
    }

    private orderColumn(column: string | ((entity: T) => unknown), apiName: string): string {
        return this.context.withModel(() => typeof column === 'function'
            ? resolveColumn(column, this.entityType, apiName)
            : assertColumn(this.entityType, column, apiName));
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

    /** This entity's structured query filters (unless disabled) as predicates. */
    private filterPredicates(): Predicate[] {
        if (this.state.ignoreFilters) {
            return [];
        }
        return queryFilterPredicates(this.context.metadata.getEntity(this.entityType));
    }

    private whereOf(predicates: Predicate[]): Predicate | undefined {
        if (predicates.length === 0) return undefined;
        if (predicates.length === 1) return predicates[0];
        return { op: 'and', parts: predicates };
    }

    private translate(model: SelectModel): SqlStatement {
        return this.context.getProvider().getTranslator().translateSelect(model);
    }

    /** Run an aggregate over the filtered rows. Skip and take do not apply. */
    private async aggregate(fn: AggregateFn, column: string | undefined, alias: string, columnType?: string): Promise<DatabaseRow | undefined> {
        const where = this.whereOf([...this.state.predicates, ...this.filterPredicates()]);
        const stmt = this.translate({
            table: this.tableName,
            items: [{ operand: { kind: 'agg', fn, column, columnType }, alias }],
            where,
        });
        // The old builder emitted "FROM table " with a trailing space when
        // there was no WHERE, and QueryFilterCoverage pins it.
        const text = where ? stmt.text : stmt.text + ' ';
        const res = await this.context.query(text, stmt.params);
        return res.rows[0];
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

        const stmt = this.translate({
            table: this.tableName,
            distinct: this.state.isDistinct || undefined,
            where: this.whereOf([...this.state.predicates, ...this.filterPredicates()]),
            orderBy: this.state.orderByColumns.map(o => ({
                operand: { kind: 'column' as const, name: o.column },
                direction: o.direction === 'DESC' ? 'desc' as const : 'asc' as const,
            })),
            skip: this.state.skipCount,
            take: this.state.takeCount,
        });
        const res = await this.context.query(stmt.text, stmt.params);

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
        const row = await this.aggregate('count', undefined, 'count');
        return toCount(row?.count);
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
    async sum(selector: (entity: T) => number): Promise<ExactNumeric> {
        const columnName = resolveColumn(selector, this.entityType, 'sum');

        const row = await this.aggregate('sum', columnName, 'total', columnTypeOf(this.entityType, columnName));
        return toExactNumber(row?.total) ?? 0;
    }

    /**
     * Calculate average of a numeric property across filtered results
     * @param selector Property selector function
     */
    async average(selector: (entity: T) => number): Promise<ExactNumeric> {
        const columnName = resolveColumn(selector, this.entityType, 'average');

        const row = await this.aggregate('avg', columnName, 'avg', columnTypeOf(this.entityType, columnName));
        return toExactNumber(row?.avg) ?? 0;
    }

    /**
     * Find minimum value of a property across filtered results
     * @param selector Property selector function
     */
    async min(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'min');

        const row = await this.aggregate('min', columnName, 'min', columnTypeOf(this.entityType, columnName));
        return row!.min;
    }

    /**
     * Find maximum value of a property across filtered results
     * @param selector Property selector function
     */
    async max(selector: (entity: T) => any): Promise<any> {
        const columnName = resolveColumn(selector, this.entityType, 'max');

        const row = await this.aggregate('max', columnName, 'max', columnTypeOf(this.entityType, columnName));
        return row!.max;
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
        builder.adoptWhere(this.state.predicates);
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
    private relatedFilterPredicates(relatedMetadata: EntityMetadata): Predicate[] {
        if (this.state.ignoreFilters) {
            return [];
        }
        return queryFilterPredicates(relatedMetadata);
    }

    private relatedStatement(table: string, column: string, values: QueryParameter[], filters: Predicate[]): SqlStatement {
        const inList: Predicate = { op: 'in', left: { kind: 'column', name: column }, values };
        return this.translate({ table, where: this.whereOf([inList, ...filters]) });
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
        const stmt = this.relatedStatement(
            relatedMetadata.tableName, relatedPkColumn, uniqueFkValues.map(asQueryParameter),
            this.relatedFilterPredicates(relatedMetadata)
        );
        const res = await this.context.query(stmt.text, stmt.params);

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

        const stmt = this.relatedStatement(
            relatedMetadata.tableName, foreignKeyColumn, pkValues.map(asQueryParameter),
            this.relatedFilterPredicates(relatedMetadata)
        );
        const res = await this.context.query(stmt.text, stmt.params);

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

        const joinStmt = this.relatedStatement(
            relationMetadata.joinTable, relationMetadata.joinColumn, pkValues.map(asQueryParameter), []
        );
        const joinRes = await this.context.query(joinStmt.text, joinStmt.params);

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

        const relatedStmt = this.relatedStatement(
            relatedMetadata.tableName, relatedPkColumn.columnName, uniqueRelatedIds.map(asQueryParameter),
            this.relatedFilterPredicates(relatedMetadata)
        );
        const relatedRes = await this.context.query(relatedStmt.text, relatedStmt.params);

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
