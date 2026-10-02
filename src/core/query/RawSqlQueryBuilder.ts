import { DbContext } from "../DbContext";
import { DatabaseRow, QueryParameter } from "../types";
import { matchesQueryFilter } from "../QueryFilter";
import { mapRowToEntity } from "./EntityMapper";

/**
 * Query builder for raw SQL queries
 * Allows executing custom SQL and mapping results to entities
 */
export class RawSqlQueryBuilder<T> {
    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private sql: string,
        private parameters?: QueryParameter[]
    ) {}

    /**
     * Execute the raw SQL query and return results as entities
     */
    async toList(): Promise<T[]> {
        const res = await this.context.query(this.sql, this.parameters);

        const entities = res.rows.map((row: DatabaseRow) =>
            mapRowToEntity(this.entityType, row, false, this.context)
        );

        // Raw SQL cannot be rewritten, so global query filters (both forms)
        // are evaluated in memory here
        const metadata = this.context.metadata.getEntity(this.entityType);
        return entities.filter((e: T) => matchesQueryFilter(metadata, e));
    }

    /**
     * Execute the raw SQL query without tracking
     */
    async toListNoTracking(): Promise<T[]> {
        const res = await this.context.query(this.sql, this.parameters);

        const entities = res.rows.map((row: DatabaseRow) =>
            mapRowToEntity(this.entityType, row, true)
        );

        // Raw SQL cannot be rewritten, so global query filters (both forms)
        // are evaluated in memory here
        const metadata = this.context.metadata.getEntity(this.entityType);
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
