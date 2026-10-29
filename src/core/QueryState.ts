import { SortDirection } from "./types";
import { Predicate } from "./query/model/Predicate";
import { OrderItem } from "./query/model/SelectModel";

/** An `ORDER BY` term: a validated column and its direction. */
export interface OrderByTerm {
    column: string;
    direction: SortDirection;
}

/**
 * The clause state a query accumulates before it is turned into SQL.
 *
 * `DbSet`, `QueryBuilder`, `SelectQueryBuilder` and `GroupedQueryBuilder` all
 * collect the same WHERE predicates, ordering and row
 * limits. They used to declare those fields separately and hand them over with
 * `builder['conditions'] = [...]`, reaching through `private` by index because
 * the builders are siblings rather than a hierarchy. That made the state
 * public in practice and left four copies of the same declarations.
 *
 * Holding it in one object lets a builder hand its state to the next one
 * through an ordinary method call, so the fields can stay genuinely private.
 */
export class QueryState {
    /** WHERE predicates in call order, ANDed together. */
    predicates: Predicate[] = [];
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
        copy.predicates = [...this.predicates];
        copy.orderByColumns = [...this.orderByColumns];
        copy.skipCount = this.skipCount;
        copy.takeCount = this.takeCount;
        copy.isDistinct = this.isDistinct;
        copy.ignoreFilters = this.ignoreFilters;
        return copy;
    }

    /** The collected predicates as one WHERE predicate, or undefined. */
    where(extra: Predicate[] = []): Predicate | undefined {
        const all = [...this.predicates, ...extra];
        if (all.length === 0) return undefined;
        if (all.length === 1) return all[0];
        return { op: 'and', parts: all };
    }

    /** The ORDER BY terms as model items. */
    orderItems(): OrderItem[] {
        return this.orderByColumns.map(o => ({
            operand: { kind: 'column', name: o.column },
            direction: o.direction === 'DESC' ? 'desc' : 'asc',
        }));
    }

    /** Whether a row limit is in play, which several paths guard on. */
    hasRowLimit(): boolean {
        return this.skipCount !== undefined || this.takeCount !== undefined;
    }
}
