import type * as mssql from "mssql";
import { loadDriver } from "./loadDriver";
import { SqlTranslator } from "./translators/SqlTranslator";
import { MsSqlTranslator } from "./translators/MsSqlTranslator";
import { DatabaseConfig, IDatabaseProvider, ITransaction, QueryResult } from "./IDatabaseProvider";
import { ColumnMetadata, EntityMetadata } from "../core/MetadataStorage";
import { Dialect, QueryParameter } from "../core/types";
import { TypeMap, createTypeMapper, createTypeNormalizer } from "./typeMapping";

/**
 * Microsoft SQL Server database provider implementation
 */
/** Dialect spelling for each known column type. */
const TYPE_MAP = {
    text: 'NVARCHAR(MAX)',
    integer: 'INT',
    boolean: 'BIT',
    timestamp: 'DATETIME2',
    date: 'DATE',
    time: 'TIME',
    decimal: 'DECIMAL(18,2)',
    float: 'REAL',
    double: 'FLOAT',
    bigint: 'BIGINT',
    // SQL Server 2016+ supports JSON functions over NVARCHAR
    json: 'NVARCHAR(MAX)',
} satisfies TypeMap;

/** Types that carry their own parameters and pass through unchanged. */
const PASSTHROUGH_TYPES = ['varchar', 'nvarchar', 'decimal'] as const;

/** Database type names that normalize to a different canonical name. */
const NORMALIZE_MAP: Readonly<Record<string, string>> = {
    'nvarchar': 'varchar',
    'int': 'integer',
    'bit': 'boolean',
    'datetime2': 'timestamp',
    'datetime': 'timestamp',
};

async function runRequest(
    request: mssql.Request,
    text: string,
    params?: QueryParameter[]
): Promise<QueryResult> {
    if (params) {
        params.forEach((param, index) => {
            request.input(`p${index}`, param);
        });
    }

    const result = await request.query(text);

    return {
        rows: result.recordset || [],
        rowCount: result.rowsAffected[0] || 0,
    };
}

/** A transaction on its own pooled connection, released when it ends. */
class MSSQLTransaction implements ITransaction {
    #transaction: mssql.Transaction | null;

    constructor(transaction: mssql.Transaction) {
        this.#transaction = transaction;
    }

    get isOpen(): boolean {
        return this.#transaction !== null;
    }

    async query(text: string, params?: QueryParameter[]): Promise<QueryResult> {
        if (!this.#transaction) {
            throw new Error('The transaction has already ended.');
        }
        return runRequest(this.#transaction.request(), text, params);
    }

    async commit(): Promise<void> {
        const transaction = this.#transaction;
        if (!transaction) return;
        this.#transaction = null;
        await transaction.commit();
    }

    async rollback(): Promise<void> {
        const transaction = this.#transaction;
        if (!transaction) return;
        this.#transaction = null;
        await transaction.rollback();
    }
}

export class MSSQLProvider implements IDatabaseProvider {
    #pool: mssql.ConnectionPool | null = null;
    readonly #driver: typeof mssql;
    private config: mssql.config;

    private readonly translator = new MsSqlTranslator();

    getTranslator(): SqlTranslator {
        return this.translator;
    }

    getDialect(): Dialect {
        return 'mssql';
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
        return this.config as unknown as Readonly<Record<string, unknown>>;
    }

    /**
     * The underlying connection pool, for test teardown.
     * @internal
     */
    get connectionPool(): unknown {
        return this.#pool;
    }

    /**
     * Install a stand-in pool so connect() idempotence can be exercised
     * without reaching a server.
     *
     * The field is `#private`, so a test cannot assign it directly the way it
     * used to. Kept narrow on purpose: this only exists for that test.
     * @internal
     */
    set connectionPool(pool: unknown) {
        this.#pool = pool as mssql.ConnectionPool | null;
    }

    constructor(config: DatabaseConfig) {
        this.#driver = loadDriver<typeof mssql>("MSSQLProvider", "mssql", () => {
            // eslint-disable-next-line no-useless-catch
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                return require("mssql");
            } catch (error) {
                throw error;
            }
        });
        // Encrypt unless the caller explicitly turns it off, and validate the
        // certificate unless they explicitly opt out. The previous defaults
        // (encrypt false, trust any certificate) put every query and result set
        // on the wire in cleartext (issue #43).
        const { driverOptions, ...rest } = config;
        const encrypt = rest.ssl === undefined ? true : rest.ssl !== false;

        this.config = {
            ...(driverOptions as mssql.config | undefined),
            server: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            options: {
                ...(typeof rest.ssl === 'object' ? rest.ssl : {}),
                ...((driverOptions?.options as Record<string, unknown>) ?? {}),
                encrypt,
                trustServerCertificate: rest.trustServerCertificate ?? false,
            },
            pool: {
                max: config.max || 10,
                min: config.min || 0,
                idleTimeoutMillis: config.idleTimeoutMillis || 30000,
            },
        };
    }

    async connect(): Promise<void> {
        // Idempotent: a second call used to build another pool and overwrite
        // the field, leaving the first one open with its sockets held until
        // process exit.
        if (this.#pool) return;

        // A dedicated pool, not the module-global mssql.connect() one: two
        // providers with different configs used to share a single global pool,
        // so disconnect() on either closed it for both (issue #38).
        this.#pool = await new this.#driver.ConnectionPool(this.config).connect();
    }

    async disconnect(): Promise<void> {
        if (this.#pool) {
            await this.#pool.close();
            this.#pool = null;
        }
    }

    async query(text: string, params?: QueryParameter[]): Promise<QueryResult> {
        if (!this.#pool) {
            throw new Error("Not connected to database");
        }
        return runRequest(this.#pool.request(), text, params);
    }

    async beginTransaction(): Promise<ITransaction> {
        if (!this.#pool) await this.connect();
        const transaction = new this.#driver.Transaction(this.#pool!);
        try {
            await transaction.begin();
        } catch (error) {
            // A rejected begin() still holds the pooled connection; only
            // commit and rollback release it.
            await transaction.rollback().catch(() => undefined);
            throw error;
        }
        return new MSSQLTransaction(transaction);
    }

    mapType = createTypeMapper(TYPE_MAP, PASSTHROUGH_TYPES,
    (upper, lower) => (lower.startsWith('varchar') ? 'N' + upper : upper));

    generateCreateTableSql(entity: EntityMetadata): string {
        const columns = entity.columns.map((col) => {
            let colDef = `${col.columnName} ${this.mapType(col.type)}`;

            if (col.isPrimaryKey) {
                // If it's an integer PK, make it IDENTITY for auto-increment
                if (col.type === "integer") {
                    colDef = `${col.columnName} INT IDENTITY(1,1) PRIMARY KEY`;
                } else {
                    colDef += " PRIMARY KEY";
                }
            } else if (!col.isNullable) {
                colDef += " NOT NULL";
            }

            return colDef;
        });

        return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${entity.tableName}')
                CREATE TABLE ${entity.tableName} (${columns.join(", ")});`;
    }

    generateAddColumnSql(tableName: string, column: ColumnMetadata): string {
        const colDef = this.mapType(column.type);
        return `ALTER TABLE ${tableName} ADD ${column.columnName} ${colDef}`;
    }

    generateAlterColumnTypeSql(tableName: string, column: ColumnMetadata): string {
        // SQL Server doesn't support USING clause like PostgreSQL
        // Need to convert data manually if needed
        return `ALTER TABLE ${tableName} ALTER COLUMN ${column.columnName} ${this.mapType(column.type)}`;
    }

    getParameterPlaceholder(index: number): string {
        // Convert from 1-based caller convention to 0-based MSSQL binding
        return `@p${index - 1}`;
    }

    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] } {
        return {
            sql: `
                SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = @p0;
            `,
            params: [tableName],
        };
    }

    normalizeType = createTypeNormalizer(NORMALIZE_MAP);

    getAutoIncrementType(): string {
        return 'IDENTITY(1,1)';
    }

    isTypeMismatch(entityType: string, dbType: string): boolean {
        const normalizedEntity = this.normalizeType(entityType.toLowerCase());
        const normalizedDb = this.normalizeType(dbType.toLowerCase());

        // Simple comparison
        if (normalizedEntity === 'integer' && normalizedDb !== 'integer') return true;
        if (normalizedEntity === 'text' && !normalizedDb.includes('varchar')) return true;
        if (normalizedEntity === 'boolean' && normalizedDb !== 'boolean') return true;
        if (normalizedEntity.startsWith('varchar') && !normalizedDb.includes('varchar')) return true;
        if (normalizedEntity === 'timestamp' && !normalizedDb.includes('timestamp') && !normalizedDb.includes('datetime')) return true;

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

        return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${joinTableName}')
                CREATE TABLE ${joinTableName} (
                    ${column1} INT NOT NULL,
                    ${column2} INT NOT NULL,
                    PRIMARY KEY (${column1}, ${column2}),
                    FOREIGN KEY (${column1}) REFERENCES ${referencedTable1}(${referencedColumn1})${cascadeClause},
                    FOREIGN KEY (${column2}) REFERENCES ${referencedTable2}(${referencedColumn2})${cascadeClause}
                )`;
    }
}
