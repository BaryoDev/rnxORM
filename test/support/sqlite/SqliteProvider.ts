import Database from 'better-sqlite3';
import { IDatabaseProvider, ITransaction, QueryResult } from '../../../src/providers/IDatabaseProvider';
import { SqlTranslator } from '../../../src/providers/translators/SqlTranslator';
import { createTypeNormalizer } from '../../../src/providers/translators/typeMapping';
import { Dialect, QueryParameter } from '../../../src/core/types';
import { SqliteTranslator } from './SqliteTranslator';

const NORMALIZE_MAP: Readonly<Record<string, string>> = {
    int: 'integer',
    datetime: 'timestamp',
};

/** better-sqlite3 refuses boolean and Date, and has no JSON type. */
function toBindValue(value: QueryParameter): unknown {
    if (value === undefined) return null;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value instanceof Date) return value.toISOString();
    if (value === null || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
    return JSON.stringify(value);
}

/** CURRENT_TIMESTAMP gives 'YYYY-MM-DD HH:MM:SS' in UTC with no zone marker. */
const SQLITE_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/** Converts a stored value back by the declared type of the column it came from. */
export function fromDb(value: unknown, declaredType: string | null): unknown {
    if (value === null || value === undefined || declaredType === null) return value;
    const type = declaredType.toUpperCase();
    if (type === 'BOOLEAN') return typeof value === 'number' ? value !== 0 : value;
    if (type === 'DATETIME' || type === 'TIMESTAMP' || type === 'DATE') {
        if (typeof value === 'string') {
            return new Date(SQLITE_UTC_TIMESTAMP.test(value) ? `${value.replace(' ', 'T')}Z` : value);
        }
        if (typeof value === 'number') return new Date(value);
    }
    return value;
}

function runStatement(db: Database.Database, text: string, params: QueryParameter[] = []): QueryResult {
    const stmt = db.prepare(text);
    const bound = params.map(toBindValue);
    if (stmt.reader) {
        const columns = stmt.columns();
        stmt.raw(true);
        const raw = stmt.all(...bound) as unknown[][];
        const rows = raw.map((values) => {
            const row: Record<string, unknown> = {};
            columns.forEach((column, i) => {
                row[column.name] = fromDb(values[i], column.type);
            });
            return row;
        });
        return { rows, rowCount: rows.length };
    }
    const info = stmt.run(...bound);
    return { rows: [], rowCount: info.changes };
}

/**
 * Runs on the provider's one connection, so a transaction and a plain query
 * share it. SQLite has a single writer, so the real-database tests that need
 * two concurrent transactions cannot run here.
 */
class SqliteTransaction implements ITransaction {
    #open = true;

    constructor(private readonly db: Database.Database, private readonly onEnd: () => void) {}

    get isOpen(): boolean {
        return this.#open;
    }

    async query(text: string, params?: QueryParameter[]): Promise<QueryResult> {
        if (!this.#open) throw new Error('The transaction has already ended.');
        return runStatement(this.db, text, params);
    }

    async commit(): Promise<void> {
        this.end('COMMIT');
    }

    async rollback(): Promise<void> {
        this.end('ROLLBACK');
    }

    private end(statement: string): void {
        if (!this.#open) return;
        this.#open = false;
        this.onEnd();
        this.db.exec(statement);
    }
}

/** Test-only provider over better-sqlite3. Each instance is its own in-memory database. */
export class SqliteProvider implements IDatabaseProvider {
    #db: Database.Database | null = null;
    #transactionOpen = false;
    private readonly translator = new SqliteTranslator();

    constructor(private readonly filename: string = ':memory:') {}

    getDialect(): Dialect {
        return 'sqlite' as Dialect;
    }

    getTranslator(): SqlTranslator {
        return this.translator;
    }

    async connect(): Promise<void> {
        if (this.#db) return;
        this.#db = new Database(this.filename);
        this.#db.pragma('foreign_keys = ON');
    }

    async disconnect(): Promise<void> {
        this.#db?.close();
        this.#db = null;
        this.#transactionOpen = false;
    }

    private connection(): Database.Database {
        if (!this.#db) throw new Error('Not connected to database');
        return this.#db;
    }

    async query(text: string, params?: QueryParameter[]): Promise<QueryResult> {
        return runStatement(this.connection(), text, params);
    }

    async beginTransaction(): Promise<ITransaction> {
        const db = this.connection();
        if (this.#transactionOpen) {
            throw new Error('The SQLite test provider has one connection: only one transaction can be open at a time.');
        }
        db.exec('BEGIN');
        this.#transactionOpen = true;
        return new SqliteTransaction(db, () => {
            this.#transactionOpen = false;
        });
    }

    mapType = (tsType: string): string => this.translator.mapType(tsType);

    getParameterPlaceholder(_index: number): string {
        return '?';
    }

    getSchemaColumnsQuery(tableName: string): { sql: string; params: QueryParameter[] } {
        return {
            sql: 'SELECT name AS column_name, type AS data_type FROM pragma_table_info(?)',
            params: [tableName],
        };
    }

    normalizeType = createTypeNormalizer(NORMALIZE_MAP);

    getAutoIncrementType(): string {
        return 'AUTOINCREMENT';
    }

    /** SQLite is dynamically typed, so a declared type never has to be rewritten. */
    isTypeMismatch(): boolean {
        return false;
    }
}
