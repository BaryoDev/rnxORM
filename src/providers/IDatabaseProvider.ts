import { ColumnMetadata, EntityMetadata } from "../core/MetadataStorage";

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
 * Result from database query execution
 */
export interface QueryResult {
    rows: any[];
    rowCount: number;
    /**
     * Generated key for an auto-increment primary key.
     *
     * A string when the value is outside the range a JS number represents
     * exactly, so a key above 2^53 is not silently rounded (issue #39).
     */
    insertId?: number | string;
}

/**
 * Interface for database providers
 * Abstracts database-specific SQL generation and operations
 */
export interface IDatabaseProvider {
    /**
     * Get the SQL dialect identifier for this provider.
     * Used for provider-specific SQL generation (e.g., pagination, DDL).
     */
    getDialect(): string;

    /**
     * Connect to the database
     */
    connect(): Promise<void>;

    /**
     * Disconnect from the database
     */
    disconnect(): Promise<void>;

    /**
     * Execute a SQL query
     */
    query(text: string, params?: any[]): Promise<QueryResult>;

    /**
     * Begin a transaction
     */
    beginTransaction(): Promise<void>;

    /**
     * Commit a transaction
     */
    commitTransaction(): Promise<void>;

    /**
     * Rollback a transaction
     */
    rollbackTransaction(): Promise<void>;

    /**
     * Whether a transaction is currently open on this provider.
     *
     * Lets a caller-opened transaction take precedence over the one
     * `saveChanges()` would otherwise wrap around its writes. Without it,
     * `saveChanges()` committed the caller's transaction early and the
     * caller's later rollback rolled back nothing (issue #38).
     */
    isInTransaction(): boolean;

    /**
     * Map TypeScript type to database-specific type
     */
    mapType(tsType: string): string;

    /**
     * Generate CREATE TABLE SQL
     */
    generateCreateTableSql(entity: EntityMetadata): string;

    /**
     * Generate ALTER TABLE ADD COLUMN SQL
     */
    generateAddColumnSql(tableName: string, column: ColumnMetadata): string;

    /**
     * Generate ALTER TABLE ALTER COLUMN SQL (for type changes)
     */
    generateAlterColumnTypeSql(tableName: string, column: ColumnMetadata): string;

    /**
     * Generate INSERT SQL
     */
    generateInsertSql(tableName: string, columns: ColumnMetadata[]): string;

    /**
     * Generate UPDATE SQL
     */
    generateUpdateSql(tableName: string, columns: ColumnMetadata[], pkColumn: ColumnMetadata): string;

    /**
     * Generate DELETE SQL
     */
    generateDeleteSql(tableName: string, pkColumn: ColumnMetadata): string;

    /**
     * Generate SELECT SQL
     */
    generateSelectSql(tableName: string, whereClause?: string): string;

    /**
     * Generate parameterized placeholder (e.g., $1, $2 for PostgreSQL or @p1, @p2 for MSSQL)
     */
    getParameterPlaceholder(index: number): string;

    /**
     * Get query to fetch existing columns from database schema
     */
    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] };

    /**
     * Normalize database type for comparison
     */
    normalizeType(dbType: string): string;

    /**
     * Get auto-increment/identity column definition
     */
    getAutoIncrementType(): string;

    /**
     * Check if a type mismatch exists between entity and database
     */
    isTypeMismatch(entityType: string, dbType: string): boolean;

    /**
     * Generate ADD FOREIGN KEY constraint SQL
     */
    generateAddForeignKeySql(
        tableName: string,
        columnName: string,
        referencedTable: string,
        referencedColumn: string,
        onDelete?: string,
        onUpdate?: string
    ): string;

    /**
     * Generate CREATE INDEX SQL
     */
    generateCreateIndexSql(
        tableName: string,
        indexName: string,
        columns: string[],
        unique: boolean
    ): string;

    /**
     * Generate CREATE UNIQUE CONSTRAINT SQL
     */
    generateCreateUniqueConstraintSql(
        tableName: string,
        constraintName: string,
        columns: string[]
    ): string;

    /**
     * Generate CREATE TABLE SQL for join table (Many-to-Many)
     */
    generateCreateJoinTableSql(
        joinTableName: string,
        column1: string,
        column2: string,
        referencedTable1: string,
        referencedTable2: string,
        onDelete?: string,
        referencedColumn1?: string,
        referencedColumn2?: string
    ): string;
}
