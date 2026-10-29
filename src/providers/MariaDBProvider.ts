import type * as mariadb from "mariadb";
import { loadDriver } from "./loadDriver";
import { SqlTranslator } from "./translators/SqlTranslator";
import { MariaDbTranslator } from "./translators/MariaDbTranslator";
import { DatabaseConfig, IDatabaseProvider, ITransaction, QueryResult } from "./IDatabaseProvider";
import { Dialect, QueryParameter } from "../core/types";
import { createTypeNormalizer } from "./translators/typeMapping";
import { toExactNumber } from "../core/Numerics";

/**
 * MariaDB database provider implementation
 */
/** Database type names that normalize to a different canonical name. */
const NORMALIZE_MAP: Readonly<Record<string, string>> = {
    'int': 'integer',
    'tinyint': 'boolean',
    'datetime': 'timestamp',
    'varchar': 'varchar',
};

async function runQuery(
    conn: mariadb.Connection,
    text: string,
    params?: QueryParameter[]
): Promise<QueryResult> {
    const result = await conn.query(text, params);

    // MariaDB returns different formats depending on query type
    const rows = Array.isArray(result) ? result : [result];
    const rowCount = result.affectedRows !== undefined ? result.affectedRows : rows.length;

    return {
        rows: rows,
        rowCount: rowCount,
        // mariadb returns insertId as a BigInt. Number() truncated
        // anything above 2^53 into a wrong key (issue #39).
        insertId: toExactNumber(result.insertId) ?? undefined,
    };
}

/** A transaction pinned to one pooled connection, released when it ends. */
class MariaDBTransaction implements ITransaction {
    #conn: mariadb.PoolConnection | null;

    constructor(conn: mariadb.PoolConnection) {
        this.#conn = conn;
    }

    get isOpen(): boolean {
        return this.#conn !== null;
    }

    async query(text: string, params?: QueryParameter[]): Promise<QueryResult> {
        if (!this.#conn) {
            throw new Error('The transaction has already ended.');
        }
        return runQuery(this.#conn, text, params);
    }

    async commit(): Promise<void> {
        const conn = this.#conn;
        if (!conn) return;
        this.#conn = null;
        try {
            await conn.commit();
        } finally {
            await conn.release();
        }
    }

    async rollback(): Promise<void> {
        const conn = this.#conn;
        if (!conn) return;
        this.#conn = null;
        try {
            await conn.rollback();
        } finally {
            await conn.release();
        }
    }
}

export class MariaDBProvider implements IDatabaseProvider {
    #pool: mariadb.Pool;

    private readonly translator = new MariaDbTranslator();

    getTranslator(): SqlTranslator {
        return this.translator;
    }

    getDialect(): Dialect {
        return 'mariadb';
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
            connectionLimit: config.max || 10,
            idleTimeout: config.idleTimeoutMillis || 30000,
            ...(config.ssl !== undefined ? { ssl: config.ssl } : {}),
        };
        const driver = loadDriver<typeof mariadb>("MariaDBProvider", "mariadb", () => {
            // eslint-disable-next-line no-useless-catch
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                return require("mariadb");
            } catch (error) {
                throw error;
            }
        });
        this.#pool = driver.createPool(this.#poolConfig);
    }

    async connect(): Promise<void> {
        // Fail fast on bad credentials or an unreachable host. The connection
        // goes straight back: queries use the pool, never a pinned connection.
        const conn = await this.#pool.getConnection();
        await conn.release();
    }

    async disconnect(): Promise<void> {
        await this.#pool.end();
    }

    async query(text: string, params?: QueryParameter[]): Promise<QueryResult> {
        const conn = await this.#pool.getConnection();
        try {
            return await runQuery(conn, text, params);
        } finally {
            await conn.release();
        }
    }

    async beginTransaction(): Promise<ITransaction> {
        const conn = await this.#pool.getConnection();
        try {
            await conn.beginTransaction();
        } catch (error) {
            await conn.release();
            throw error;
        }
        return new MariaDBTransaction(conn);
    }

    mapType = (tsType: string): string => this.translator.mapType(tsType);

    getParameterPlaceholder(index: number): string {
        return "?";
    }

    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] } {
        return {
            sql: `
                SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE();
            `,
            params: [tableName],
        };
    }

    normalizeType = createTypeNormalizer(NORMALIZE_MAP);

    getAutoIncrementType(): string {
        return 'AUTO_INCREMENT';
    }

    isTypeMismatch(entityType: string, dbType: string): boolean {
        const normalizedEntity = this.normalizeType(entityType.toLowerCase());
        const normalizedDb = this.normalizeType(dbType.toLowerCase());

        // Simple comparison
        if (normalizedEntity === 'integer' && normalizedDb !== 'integer') return true;
        if (normalizedEntity === 'text' && normalizedDb !== 'text') return true;
        if (normalizedEntity === 'boolean' && normalizedDb !== 'boolean') return true;
        if (normalizedEntity.startsWith('varchar') && !normalizedDb.includes('varchar')) return true;
        if (normalizedEntity === 'timestamp' && !normalizedDb.includes('timestamp') && !normalizedDb.includes('datetime')) return true;

        return false;
    }
}
