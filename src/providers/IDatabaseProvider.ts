import { SqlTranslator } from "./translators/SqlTranslator";
import {
    DatabaseRow,
    Dialect,
    ExactNumeric,
    QueryParameter,
} from "../core/types";

/**
 * Configuration for database connection
 */
export interface DatabaseConfig {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
    // Optional connection pool settings
    max?: number;
    min?: number;
    idleTimeoutMillis?: number;

    /**
     * Enable TLS for the connection.
     *
     * `true` turns it on with driver defaults; an object is passed through to
     * the driver's own TLS options (`rejectUnauthorized`, `ca`, and so on).
     * Omitted means the driver default, except on SQL Server, which encrypts
     * unless this is explicitly `false`.
     */
    ssl?: boolean | Record<string, unknown>;

    /**
     * Trust the server certificate without validating it (SQL Server).
     *
     * Only meaningful for local development against a self-signed certificate.
     * Defaults to false: a connection that cannot validate its peer is not
     * protected against an interceptor.
     */
    trustServerCertificate?: boolean;

    /**
     * Options passed straight through to the underlying driver, merged under
     * everything this interface sets. An escape hatch for driver features the
     * ORM does not model.
     */
    driverOptions?: Record<string, unknown>;
}

/**
 * The result of executing a statement.
 *
 * `TRow` defaults to an index-signature row because column names are not known
 * at compile time; a caller that knows the shape can supply it.
 */
export interface QueryResult<TRow = DatabaseRow> {
    rows: TRow[];
    rowCount: number;
    /**
     * Generated key for an auto-increment primary key.
     *
     * A string when the value is outside the range a JS number represents
     * exactly, so a key above 2^53 is not silently rounded (issue #39).
     */
    insertId?: ExactNumeric;
}

/**
 * An open transaction, bound to one connection.
 *
 * Statements run through `query()` are inside the transaction until
 * `commit()` or `rollback()` ends it and releases the connection.
 */
export interface ITransaction {
    query(text: string, params?: QueryParameter[]): Promise<QueryResult>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    /** False once the transaction has been committed or rolled back. */
    readonly isOpen: boolean;
}

/**
 * Interface for database providers
 * Abstracts database-specific SQL generation and operations
 */
export interface IDatabaseProvider {
    /**
     * Get the SQL dialect identifier for this provider.
     * For display and diagnostics. Code outside src/providers does not branch on it.
     */
    getDialect(): Dialect;

    /**
     * The translator that renders query models to SQL for this dialect.
     */
    getTranslator(): SqlTranslator;

    /**
     * Connect to the database
     */
    connect(): Promise<void>;

    /**
     * Disconnect from the database
     */
    disconnect(): Promise<void>;

    /**
     * Execute a SQL query on the pool, outside any transaction.
     */
    query(text: string, params?: QueryParameter[]): Promise<QueryResult>;

    /**
     * Open a transaction on its own connection.
     *
     * The provider keeps no transaction state: `query()` above always uses the
     * pool, and the returned handle is the only way to run statements inside
     * this transaction. Whoever holds the handle commits or rolls it back,
     * which also releases the connection (issue #52).
     */
    beginTransaction(): Promise<ITransaction>;

    /**
     * Map TypeScript type to database-specific type
     */
    mapType(tsType: string): string;

    /**
     * Generate parameterized placeholder (e.g., $1, $2 for PostgreSQL or @p1, @p2 for MSSQL)
     */
    getParameterPlaceholder(index: number): string;

    /**
     * Get query to fetch existing columns from database schema
     */
    getSchemaColumnsQuery(tableName: string): { sql: string; params: QueryParameter[] };

    /**
     * Normalize database type for comparison
     */
    normalizeType(dbType: string): string;

    getAutoIncrementType(): string;

    /**
     * Check if a type mismatch exists between entity and database
     */
    isTypeMismatch(entityType: string, dbType: string): boolean;
}
