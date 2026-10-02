import { DbContext } from "../DbContext";
import { QueryState } from "../QueryState";
import { DatabaseRow, QueryParameter } from "../types";
import { capture } from "../expressions/PropertyCapture";
import { compileQueryFilter } from "../QueryFilter";
import { toCount } from "../Numerics";
import { assertAlias, assertColumn, assertLimit, buildComparison, findColumn } from "../Identifiers";
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
     * Add a WHERE condition
     */
    where(column: keyof T & string, operator: string, value: any): this;
    where(column: string, operator: string, value: any): this;
    where(column: string, operator: string, value: any): this {
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
        const provider = this.context.getProvider();
        const dialect = provider.getDialect();

        // First, get the entities
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
            if (this.state.skipCount !== undefined || this.state.takeCount !== undefined) {
                if (this.state.orderByColumns.length === 0) {
                    whereClause += (whereClause ? ' ' : '') + 'ORDER BY (SELECT NULL)';
                }
                whereClause += ` OFFSET ${this.state.skipCount ?? 0} ROWS`;
                if (this.state.takeCount !== undefined) {
                    whereClause += ` FETCH NEXT ${this.state.takeCount} ROWS ONLY`;
                }
            }
        } else {
            if (this.state.takeCount !== undefined) {
                whereClause += ` LIMIT ${this.state.takeCount}`;
            }
            if (this.state.skipCount !== undefined) {
                whereClause += ` OFFSET ${this.state.skipCount}`;
            }
        }

        // Check if we can optimize with SQL projection
        const projectedColumns = this.extractProjectedColumns();

        let sql: string;
        if (projectedColumns && projectedColumns.length > 0) {
            // Use SQL projection for simple property selections
            const distinctKeyword = this.state.isDistinct ? 'DISTINCT ' : '';
            const columnList = projectedColumns.join(', ');
            sql = `SELECT ${distinctKeyword}${columnList} FROM ${this.tableName}${whereClause ? ' ' + whereClause : ''}`;
        } else {
            // Fall back to selecting all columns and projecting in memory
            const distinctKeyword = this.state.isDistinct ? 'DISTINCT ' : '';
            sql = `SELECT ${distinctKeyword}* FROM ${this.tableName}${whereClause ? ' ' + whereClause : ''}`;
        }

        const res = await this.context.query(sql, queryParams);

        if (projectedColumns && projectedColumns.length > 0) {
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
        const filter = this.compileFilters();
        const allConditions = [...this.state.conditions, ...filter.clauses];
        const whereClause = allConditions.length > 0 ? `WHERE ${allConditions.join(" AND ")}` : "";
        const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, [...this.state.params, ...filter.params]);
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
    private extractProjectedColumns(): string[] | null {
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
            return [columnFor(result.path)];
        }

        return Object.entries(result.aliases).map(
            ([alias, propertyName]) => `${columnFor(propertyName)} AS ${assertAlias(alias, 'select')}`
        );
    }
}
