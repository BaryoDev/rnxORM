import { QueryParameter, SortDirection } from "./types";

/** An `ORDER BY` term: a validated column and its direction. */
export interface OrderByTerm {
    column: string;
    direction: SortDirection;
}

/**
 * The clause state a query accumulates before it is turned into SQL.
 *
 * `DbSet`, `QueryBuilder`, `SelectQueryBuilder` and `GroupedQueryBuilder` all
 * collect the same WHERE conditions, bound parameters, ordering and row
 * limits. They used to declare those fields separately and hand them over with
 * `builder['conditions'] = [...]`, reaching through `private` by index because
 * the builders are siblings rather than a hierarchy. That made the state
 * public in practice and left four copies of the same declarations.
 *
 * Holding it in one object lets a builder hand its state to the next one
 * through an ordinary method call, so the fields can stay genuinely private.
 */
export class QueryState {
    conditions: string[] = [];
    params: QueryParameter[] = [];
    orderByColumns: OrderByTerm[] = [];
    skipCount?: number;
    takeCount?: number;
    isDistinct = false;
    ignoreFilters = false;

    /**
     * Copy this state for a builder that continues the same query.
     *
     * Arrays are copied rather than shared, so a condition added to the
     * projection does not appear in the query it was derived from.
     */
    clone(): QueryState {
        const copy = new QueryState();
        copy.conditions = [...this.conditions];
        copy.params = [...this.params];
        copy.orderByColumns = [...this.orderByColumns];
        copy.skipCount = this.skipCount;
        copy.takeCount = this.takeCount;
        copy.isDistinct = this.isDistinct;
        copy.ignoreFilters = this.ignoreFilters;
        return copy;
    }

    /** The WHERE clause for the conditions collected so far, or "". */
    whereClause(): string {
        return this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
    }

    /** The ORDER BY clause for the terms collected so far, or "". */
    orderByClause(): string {
        if (this.orderByColumns.length === 0) return "";
        return `ORDER BY ${this.orderByColumns.map(o => `${o.column} ${o.direction}`).join(", ")}`;
    }

    /** Whether a row limit is in play, which several paths guard on. */
    hasRowLimit(): boolean {
        return this.skipCount !== undefined || this.takeCount !== undefined;
    }
}
