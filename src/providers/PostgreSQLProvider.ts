import type { Pool, PoolClient } from "pg";
import { loadDriver } from "./loadDriver";
import { SqlTranslator } from "./translators/SqlTranslator";
import { PostgresTranslator } from "./translators/PostgresTranslator";
import { DatabaseConfig, IDatabaseProvider, ITransaction, QueryResult } from "./IDatabaseProvider";
import { Dialect, QueryParameter } from "../core/types";
import { createTypeNormalizer } from "./translators/typeMapping";

/**
 * PostgreSQL database provider implementation
 */
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

    private readonly translator = new PostgresTranslator();

    getTranslator(): SqlTranslator {
        return this.translator;
    }

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
        const pg = loadDriver<typeof import("pg")>("PostgreSQLProvider", "pg", () => {
            // eslint-disable-next-line no-useless-catch
            try {
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                return require("pg");
            } catch (error) {
                throw error;
            }
        });
        this.#pool = new pg.Pool(this.#poolConfig);
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

    mapType = (tsType: string): string => this.translator.mapType(tsType);

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
}
