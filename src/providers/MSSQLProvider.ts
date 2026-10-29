import type * as mssql from "mssql";
import { loadDriver } from "./loadDriver";
import { SqlTranslator } from "./translators/SqlTranslator";
import { MsSqlTranslator } from "./translators/MsSqlTranslator";
import { DatabaseConfig, IDatabaseProvider, ITransaction, QueryResult } from "./IDatabaseProvider";
import { Dialect, QueryParameter } from "../core/types";
import { createTypeNormalizer } from "./translators/typeMapping";

/**
 * Microsoft SQL Server database provider implementation
 */
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

    mapType = (tsType: string): string => this.translator.mapType(tsType);

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
}
