import { DbContext } from "../DbContext";
import { QueryState } from "../QueryState";
import { DatabaseRow } from "../types";
import { captureAggregates, AggregateSelectorEntry } from "../expressions/PropertyCapture";
import { queryFilterPredicates } from "../QueryFilter";
import { assertAlias, assertColumnOrAlias, assertHavingExpression, assertLimit, operatorToPredicate } from "../Identifiers";
import { mapRowToEntity } from "./EntityMapper";
import { Predicate } from "./model/Predicate";
import { SelectItem } from "./model/SelectModel";

/** AND the parts together; undefined when there are none. */
function allOf(parts: Predicate[]): Predicate | undefined {
    if (parts.length === 0) {
        return undefined;
    }
    return parts.length === 1 ? parts[0] : { op: 'and', parts };
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
    /** WHERE predicates, ordering and row limits. */
    private readonly state = new QueryState();

    /**
     * Take the WHERE state of the query this grouping was derived from.
     *
     * Ordering and row limits are deliberately not carried over: a GROUP BY
     * re-derives them, and inheriting an outer LIMIT would truncate groups.
     * @internal
     */
    adoptWhere(predicates: Predicate[]): void {
        this.state.predicates = [...predicates];
    }
    private havingPredicates: Predicate[] = [];
    private queryFilterApplied: boolean = false;

    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private tableName: string,
        private groupByProperty: string
    ) {}

    /**
     * Add the global query filters as WHERE predicates.
     * @internal Called by the groupBy() factories (issue #23. GroupBy was the
     * last read path that ignored structured query filters). Function-valued
     * filter conditions are resolved when groupBy() is called.
     */
    applyQueryFilter(): this {
        // Idempotent: calling it twice would add the filters a second time.
        if (this.queryFilterApplied) {
            return this;
        }
        this.queryFilterApplied = true;
        const metadata = this.context.metadata.getEntity(this.entityType);
        this.state.predicates.push(...queryFilterPredicates(metadata));
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
        // HAVING params follow the WHERE params because the translator binds
        // them in render order.
        const operand = assertHavingExpression(this.entityType, column, 'having');
        this.havingPredicates.push(operatorToPredicate(operand, operator, value, 'having'));
        return this;
    }

    /**
     * Order grouped results. Accepts a mapped column or a projection alias
     * from the select() list; aliases must be plain identifiers.
     */
    orderBy(column: string): this {
        this.state.orderByColumns.push({ column: assertColumnOrAlias(this.entityType, column, 'orderBy'), direction: 'ASC' });
        return this;
    }

    /**
     * Order grouped results descending
     */
    orderByDescending(column: string): this {
        this.state.orderByColumns.push({ column: assertColumnOrAlias(this.entityType, column, 'orderByDescending'), direction: 'DESC' });
        return this;
    }

    /**
     * Skip N groups
     */
    skip(count: number): this {
        this.state.skipCount = assertLimit(count, 'skip');
        return this;
    }

    /**
     * Take N groups
     */
    take(count: number): this {
        this.state.takeCount = assertLimit(count, 'take');
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
            this.state.clone(),
            this.havingPredicates
        );
    }

    /**
     * Execute group by and return groups with their elements (in-memory grouping)
     * Warning: This loads all data into memory
     */
    async toList(): Promise<IGrouping<TKey, T>[]> {
        // This is a simple in-memory grouping fallback
        // For production, you should use .select() with aggregations
        const stmt = this.context.getProvider().getTranslator().translateSelect({
            table: this.tableName,
            where: this.state.where(),
        });
        const res = await this.context.query(stmt.text, stmt.params);

        const entities = res.rows.map((row: DatabaseRow) =>
            mapRowToEntity(this.entityType, row, false)
        );

        const groups = new Map<TKey, T[]>();
        entities.forEach(entity => {
            const key = (entity as any)[this.groupByProperty] as TKey;
            if (!groups.has(key)) {
                groups.set(key, []);
            }
            groups.get(key)!.push(entity);
        });

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
        private readonly state: QueryState,
        private havingPredicates: Predicate[]
    ) {}

    /**
     * Execute the grouped query with aggregations
     */
    async toList(): Promise<TResult[]> {
        const metadata = this.context.metadata.getEntity(this.entityType);
        const groupColumn = metadata?.columns.find(c => c.propertyName === this.groupByProperty);

        if (!groupColumn) {
            throw new Error(`Property ${this.groupByProperty} not found on entity`);
        }

        // Extract aggregations (and, if present, the g.key alias) from the
        // result selector via property capture.
        const items = this.captureAggregations(groupColumn.columnName);

        const stmt = this.context.getProvider().getTranslator().translateSelect({
            table: this.tableName,
            items,
            where: this.state.where(),
            groupBy: [groupColumn.columnName],
            having: allOf(this.havingPredicates),
            orderBy: this.state.orderItems(),
            skip: this.state.skipCount,
            take: this.state.takeCount,
        });
        const res = await this.context.query(stmt.text, stmt.params);

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
    private captureAggregations(groupColumnName: string): SelectItem[] {
        const metadata = this.context.metadata.getEntity(this.entityType);
        const columnFor = (propertyName: string) => {
            const column = metadata?.columns.find(c => c.propertyName === propertyName);
            if (!column) {
                throw new Error(
                    `groupBy().select(): property '${propertyName}' is not a mapped column on ${this.entityType.name}`
                );
            }
            return column;
        };

        const result = captureAggregates(this.selector as unknown as (group: any) => any);
        if (result.kind === "opaque") {
            throw new Error(
                "groupBy().select(): result selector must build an object literal from " +
                "g.key, g.count(), g.sum(x => x.col), g.average(x => x.col), g.min(x => x.col), or g.max(x => x.col)"
            );
        }

        const entries = Object.entries(result.aggregates);
        const itemFor = ([alias, entry]: [string, AggregateSelectorEntry]): SelectItem => {
            if ('kind' in entry) {
                return {
                    operand: { kind: 'column', name: groupColumnName },
                    alias: assertAlias(alias, 'groupBy().select'),
                };
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
            const checkedAlias = assertAlias(alias, 'groupBy().select');
            if (entry.fn === 'count') {
                return { operand: { kind: 'agg', fn: 'count' }, alias: checkedAlias };
            }
            const column = columnFor(entry.path!);
            return {
                operand: { kind: 'agg', fn: entry.fn, column: column.columnName, columnType: column.type },
                alias: checkedAlias,
            };
        };

        const hasKey = entries.some(([, entry]) => 'kind' in entry);
        if (hasKey) {
            return entries.map(itemFor);
        }

        // No g.key entry: preserve the original bare-group-column-first shape.
        return [{ operand: { kind: 'column', name: groupColumnName } }, ...entries.map(itemFor)];
    }
}
