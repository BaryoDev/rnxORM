import { Pool, PoolClient } from "pg";
import { DatabaseConfig, IDatabaseProvider, ITransaction, QueryResult } from "./IDatabaseProvider";
import { ColumnMetadata, EntityMetadata } from "../core/MetadataStorage";
import { Dialect, QueryParameter } from "../core/types";
import { TypeMap, createTypeMapper, createTypeNormalizer } from "./typeMapping";

/**
 * PostgreSQL database provider implementation
 */
/** Dialect spelling for each known column type. */
const TYPE_MAP = {
    text: 'TEXT',
    integer: 'INTEGER',
    boolean: 'BOOLEAN',
    timestamp: 'TIMESTAMP',
    date: 'DATE',
    time: 'TIME',
    decimal: 'DECIMAL(18,2)',
    float: 'REAL',
    double: 'DOUBLE PRECISION',
    bigint: 'BIGINT',
    json: 'JSONB',
} satisfies TypeMap;

/** Types that carry their own parameters and pass through unchanged. */
const PASSTHROUGH_TYPES = ['varchar'] as const;

/** Database type names that normalize to a different canonical name. */
const NORMALIZE_MAP: Readonly<Record<string, string>> = {
    'character varying': 'varchar',
    'timestamp without time zone': 'timestamp',
    'timestamp with time zone': 'timestamp',
    'double precision': 'double',
};

function toQueryResult(result: { rows: any[]; rowCount: number | null }): QueryResult {
    return {
        rows: result.rows,
        rowCount: result.rowCount || 0,
    };
}

/** A transaction pinned to one pooled client, released when it ends. */
class PostgreSQLTransaction implements ITransaction {
    #client: PoolClient | null;

    constructor(client: PoolClient) {
        this.#client = client;
    }

    get isOpen(): boolean {
        return this.#client !== null;
    }

    async query(text: string, params?: QueryParameter[]): Promise<QueryResult> {
        if (!this.#client) {
            throw new Error('The transaction has already ended.');
        }
        return toQueryResult(await this.#client.query(text, params));
    }

    commit(): Promise<void> {
        return this.#end('COMMIT');
    }

    rollback(): Promise<void> {
        return this.#end('ROLLBACK');
    }

    /** Run the closing statement, then release the client even if it fails. */
    async #end(statement: string): Promise<void> {
        const client = this.#client;
        if (!client) return;
        this.#client = null;
        try {
            await client.query(statement);
            client.release();
        } catch (error) {
            // The connection's state is unknown, so drop it from the pool.
            client.release(error instanceof Error ? error : true);
            throw error;
        }
    }
}

export class PostgreSQLProvider implements IDatabaseProvider {
    #pool: Pool;

    getDialect(): Dialect {
        return 'postgresql';
    }

    /**
     * The options handed to the driver, for tests that assert on TLS and
     * pool settings without opening a connection.
     *
     * These fields are `#private`, so this is the supported way to read them;
     * tests used to reach in with `provider.poolConfig`, which stopped working
     * and was never part of any contract.
     * @internal
     */
    get driverConfig(): Readonly<Record<string, unknown>> {
        return this.#poolConfig as Readonly<Record<string, unknown>>;
    }

    /**
     * The underlying connection pool, for test teardown.
     * @internal
     */
    get connectionPool(): unknown {
        return this.#pool;
    }

    /** The driver config this provider built, kept for inspection and tests. */
    readonly #poolConfig: Record<string, unknown>;

    constructor(config: DatabaseConfig) {
        this.#poolConfig = {
            ...config.driverOptions,
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            max: config.max,
            min: config.min,
            idleTimeoutMillis: config.idleTimeoutMillis,
            // Only set ssl when the caller asked for it, so the driver's own
            // default (and PGSSLMODE) still applies when they did not.
            ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
        };
        this.#pool = new Pool(this.#poolConfig);
    }

    async connect(): Promise<void> {
        // Fail fast on bad credentials or an unreachable host. The client goes
        // straight back: queries use the pool, never a pinned connection.
        const client = await this.#pool.connect();
        client.release();
    }

    async disconnect(): Promise<void> {
        await this.#pool.end();
    }

    async query(text: string, params?: QueryParameter[]): Promise<QueryResult> {
        return toQueryResult(await this.#pool.query(text, params));
    }

    async beginTransaction(): Promise<ITransaction> {
        const client = await this.#pool.connect();
        try {
            await client.query('BEGIN');
        } catch (error) {
            client.release(error instanceof Error ? error : true);
            throw error;
        }
        return new PostgreSQLTransaction(client);
    }

    mapType = createTypeMapper(TYPE_MAP, PASSTHROUGH_TYPES);

    generateCreateTableSql(entity: EntityMetadata): string {
        const columns = entity.columns.map((col) => {
            let colDef = `${col.columnName} ${this.mapType(col.type)}`;

            if (col.isPrimaryKey) {
                // If it's an integer PK, make it SERIAL for auto-increment
                if (col.type === "integer") {
                    colDef = `${col.columnName} SERIAL PRIMARY KEY`;
                } else {
                    colDef += " PRIMARY KEY";
                }
            } else if (!col.isNullable) {
                colDef += " NOT NULL";
            }

            return colDef;
        });

        return `CREATE TABLE IF NOT EXISTS ${entity.tableName} (${columns.join(", ")});`;
    }

    generateAddColumnSql(tableName: string, column: ColumnMetadata): string {
        const colDef = this.mapType(column.type);
        return `ALTER TABLE ${tableName} ADD COLUMN ${column.columnName} ${colDef}`;
    }

    generateAlterColumnTypeSql(tableName: string, column: ColumnMetadata): string {
        return `ALTER TABLE ${tableName} ALTER COLUMN ${column.columnName} TYPE ${this.mapType(column.type)} USING ${column.columnName}::${this.mapType(column.type)}`;
    }

    generateInsertSql(tableName: string, columns: ColumnMetadata[]): string {
        const colNames = columns.map(c => c.columnName).join(", ");
        const values = columns.map((_, i) => `$${i + 1}`).join(", ");
        return `INSERT INTO ${tableName} (${colNames}) VALUES (${values})`;
    }

    generateUpdateSql(tableName: string, columns: ColumnMetadata[], pkColumn: ColumnMetadata): string {
        const setClause = columns.map((c, i) => `${c.columnName} = $${i + 1}`).join(", ");
        return `UPDATE ${tableName} SET ${setClause} WHERE ${pkColumn.columnName} = $${columns.length + 1}`;
    }

    generateDeleteSql(tableName: string, pkColumn: ColumnMetadata): string {
        return `DELETE FROM ${tableName} WHERE ${pkColumn.columnName} = $1`;
    }

    generateSelectSql(tableName: string, whereClause?: string): string {
        const where = whereClause ? ` ${whereClause}` : "";
        return `SELECT * FROM ${tableName}${where}`;
    }

    getParameterPlaceholder(index: number): string {
        return `$${index}`;
    }

    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] } {
        return {
            sql: `
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_name = $1;
            `,
            params: [tableName],
        };
    }

    normalizeType = createTypeNormalizer(NORMALIZE_MAP);

    getAutoIncrementType(): string {
        return 'SERIAL';
    }

    isTypeMismatch(entityType: string, dbType: string): boolean {
        const normalizedEntity = this.normalizeType(entityType.toLowerCase());
        const normalizedDb = this.normalizeType(dbType.toLowerCase());

        // Simple comparison
        if (normalizedEntity === 'integer' && normalizedDb !== 'integer') return true;
        if (normalizedEntity === 'text' && normalizedDb !== 'text') return true;
        if (normalizedEntity === 'boolean' && normalizedDb !== 'boolean') return true;
        if (normalizedEntity.startsWith('varchar') && normalizedDb !== 'varchar') return true;
        if (normalizedEntity === 'timestamp' && !normalizedDb.includes('timestamp')) return true;

        return false;
    }

    generateAddForeignKeySql(
        tableName: string,
        columnName: string,
        referencedTable: string,
        referencedColumn: string,
        onDelete?: string,
        onUpdate?: string
    ): string {
        const constraintName = `fk_${tableName}_${columnName}`;
        let sql = `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${columnName}) REFERENCES ${referencedTable}(${referencedColumn})`;

        if (onDelete) {
            sql += ` ON DELETE ${onDelete}`;
        }
        if (onUpdate) {
            sql += ` ON UPDATE ${onUpdate}`;
        }

        return sql;
    }

    generateCreateIndexSql(
        tableName: string,
        indexName: string,
        columns: string[],
        unique: boolean
    ): string {
        const uniqueKeyword = unique ? 'UNIQUE ' : '';
        const columnList = columns.join(', ');
        return `CREATE ${uniqueKeyword}INDEX ${indexName} ON ${tableName} (${columnList})`;
    }

    generateCreateUniqueConstraintSql(
        tableName: string,
        constraintName: string,
        columns: string[]
    ): string {
        const columnList = columns.join(', ');
        return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} UNIQUE (${columnList})`;
    }

    generateCreateJoinTableSql(
        joinTableName: string,
        column1: string,
        column2: string,
        referencedTable1: string,
        referencedTable2: string,
        onDelete?: string,
        referencedColumn1: string = 'id',
        referencedColumn2: string = 'id'
    ): string {
        const cascadeClause = onDelete ? ` ON DELETE ${onDelete}` : ' ON DELETE CASCADE';

        return `CREATE TABLE IF NOT EXISTS ${joinTableName} (
            ${column1} INTEGER NOT NULL,
            ${column2} INTEGER NOT NULL,
            PRIMARY KEY (${column1}, ${column2}),
            FOREIGN KEY (${column1}) REFERENCES ${referencedTable1}(${referencedColumn1})${cascadeClause},
            FOREIGN KEY (${column2}) REFERENCES ${referencedTable2}(${referencedColumn2})${cascadeClause}
        )`;
    }
}
