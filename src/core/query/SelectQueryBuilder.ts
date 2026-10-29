import { DbContext } from "../DbContext";
import { QueryState } from "../QueryState";
import { DatabaseRow } from "../types";
import { capture } from "../expressions/PropertyCapture";
import { queryFilterPredicates } from "../QueryFilter";
import { toCount } from "../Numerics";
import { assertAlias, assertColumn, assertLimit, findColumn, resolvePredicate } from "../Identifiers";
import { Predicate } from "./model/Predicate";
import { SelectItem } from "./model/SelectModel";
import { mapRowToEntity } from "./EntityMapper";

/**
 * Query builder for SELECT projections
 * Allows selecting specific properties or transforming results
 */
export class SelectQueryBuilder<T, TResult> {
    /** WHERE conditions, bound params, ordering and row limits. */
    private state = new QueryState();

    /**
     * Continue the query the projection was derived from.
     *
     * Takes ownership of an already-cloned state, so the two builders never
     * share an array. Replaces `builder['conditions'] = ...`, which reached
     * through `private` because these builders are siblings, not a hierarchy.
     * @internal
     */
    adoptState(state: QueryState): void {
        this.state = state;
    }

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

    /**
     * Add a WHERE condition
     */
    where(column: keyof T & string, operator: string, value: any): this;
    where(column: string, operator: string, value: any): this;
    where(column: string, operator: string, value: any): this {
        const sqlColumn = assertColumn(this.entityType, column, 'where');
        this.state.predicates.push(resolvePredicate(
            { columnName: sqlColumn, ...findColumn(this.entityType, column) }, operator, value, 'where'
        ));
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
     * Skip N results
     */
    skip(count: number): this {
        this.state.skipCount = assertLimit(count, 'skip');
        return this;
    }

    /**
     * Take N results
     */
    take(count: number): this {
        this.state.takeCount = assertLimit(count, 'take');
        return this;
    }

    /**
     * Remove duplicates
     */
    distinct(): this {
        this.state.isDistinct = true;
        return this;
    }

    /**
     * Execute query and return projected results
     */
    async toList(): Promise<TResult[]> {
        // Check if we can optimize with SQL projection
        const projectedColumns = this.extractProjectedColumns();
        const hasProjection = projectedColumns !== null && projectedColumns.length > 0;

        const stmt = this.context.getProvider().getTranslator().translateSelect({
            table: this.tableName,
            distinct: this.state.isDistinct || undefined,
            // No projection: select all columns and project in memory.
            items: hasProjection ? projectedColumns : undefined,
            where: this.state.where(this.filterPredicates()),
            orderBy: this.state.orderItems(),
            skip: this.state.skipCount,
            take: this.state.takeCount,
        });

        const res = await this.context.query(stmt.text, stmt.params);

        if (hasProjection) {
            if (this.projectsSingleProperty) {
                // `u => u.age` is typed TResult[] (number[]), so the caller gets
                // the values, not the one-key driver rows they arrive in. The
                // key is the *column* name, which differs from the property
                // whenever @Column renames it, so read the row's only value
                // rather than looking the property up by name (issue #45).
                return res.rows.map((row: DatabaseRow) => {
                    const values = Object.values(row);
                    return (values.length === 1 ? values[0] : row) as TResult;
                });
            }
            // Object-literal projection: the aliases already shape the row.
            return res.rows as TResult[];
        } else {
            // Map rows to entities first, then apply selector
            const entities = res.rows.map((row: DatabaseRow) =>
                mapRowToEntity(this.entityType, row, false)
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
        const where = this.state.where(this.filterPredicates());
        const stmt = this.context.getProvider().getTranslator().translateSelect({
            table: this.tableName,
            items: [{ operand: { kind: 'agg', fn: 'count' }, alias: 'count' }],
            where,
        });
        // The old builder left a trailing space when there was no WHERE.
        const res = await this.context.query(where ? stmt.text : stmt.text + ' ', stmt.params);
        return toCount(res.rows[0]?.count);
    }

    /**
     * True when the selector was a single bare property (`u => u.age`) rather
     * than an object literal. Set by extractProjectedColumns(); read by
     * toList() to decide whether rows need unwrapping to scalars.
     */
    private projectsSingleProperty = false;

    /**
     * Try to extract projected column names from the selector for SQL optimization.
     * Returns null if the selector is too complex for SQL projection (e.g. it computes
     * a value rather than naming columns) - callers fall back to in-memory projection.
     * Throws if the selector names a property that isn't a mapped column: an unmapped
     * property is a caller bug, not something to silently degrade into a full-table scan.
     */
    private extractProjectedColumns(): SelectItem[] | null {
        const result = capture(this.selector as unknown as (entity: any) => any);
        if (result.kind === "opaque") {
            // Honest fallback: the selector computes something SQL cannot express,
            // so fetch full rows and project in memory.
            return null;
        }

        const metadata = this.context.metadata.getEntity(this.entityType);
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
            this.projectsSingleProperty = true;
            return [{ operand: { kind: 'column', name: columnFor(result.path) } }];
        }

        return Object.entries(result.aliases).map(([alias, propertyName]) => ({
            operand: { kind: 'column' as const, name: columnFor(propertyName) },
            alias: assertAlias(alias, 'select'),
        }));
    }
}
