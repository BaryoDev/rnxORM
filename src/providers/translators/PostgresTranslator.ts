import { AlterColumnOp, RenameColumnOp, RenameTableOp } from '../../core/query/model/DdlOperation';
import { SqlTranslator } from './SqlTranslator';
import { TypeMap, createTypeMapper } from './typeMapping';

/**
 * PostgreSQL reserved words that cannot be used as a bare identifier: the
 * `reserved` and `reserved (can be function or type)` set from the key-word
 * appendix. Non-reserved words are omitted on purpose, they are legal bare.
 */
const POSTGRES_RESERVED_WORDS = new Set([
    'all', 'analyse', 'analyze', 'and', 'any', 'array', 'as', 'asc',
    'asymmetric', 'authorization', 'binary', 'both', 'case', 'cast', 'check',
    'collate', 'collation', 'column', 'concurrently', 'constraint', 'create',
    'cross', 'current_catalog', 'current_date', 'current_role', 'current_schema',
    'current_time', 'current_timestamp', 'current_user', 'default', 'deferrable',
    'desc', 'distinct', 'do', 'else', 'end', 'except', 'false', 'fetch', 'for',
    'foreign', 'freeze', 'from', 'full', 'grant', 'group', 'having', 'ilike',
    'in', 'initially', 'inner', 'intersect', 'into', 'is', 'isnull', 'join',
    'lateral', 'leading', 'left', 'like', 'limit', 'localtime', 'localtimestamp',
    'natural', 'not', 'notnull', 'null', 'offset', 'on', 'only', 'or', 'order',
    'outer', 'overlaps', 'placing', 'primary', 'references', 'returning',
    'right', 'select', 'session_user', 'similar', 'some', 'symmetric', 'system_user',
    'table', 'tablesample', 'then', 'to', 'trailing', 'true', 'union', 'unique',
    'user', 'using', 'variadic', 'verbose', 'when', 'where', 'window', 'with',
]);

/** A bare PostgreSQL identifier: lower case, and not starting with a digit. */
const POSTGRES_BARE_IDENTIFIER = /^[a-z_][a-z0-9_$]*$/;

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

export class PostgresTranslator extends SqlTranslator {
    readonly mapType = createTypeMapper(TYPE_MAP, PASSTHROUGH_TYPES);

    protected readonly joinKeyType = 'INTEGER';

    protected placeholder(n: number): string {
        return `$${n}`;
    }

    protected renderPagination(skip: number | undefined, take: number | undefined): string {
        let sql = '';
        if (take !== undefined) sql += ` LIMIT ${take}`;
        if (skip !== undefined) sql += ` OFFSET ${skip}`;
        return sql;
    }

    protected renderIlike(left: string, placeholder: string): string {
        return `${left} ILIKE ${placeholder}`;
    }

    protected renderInsertReturning(returning: string): string {
        return ` RETURNING ${returning}`;
    }

    /**
     * Bare where bare is unambiguous. PostgreSQL folds unquoted names to lower
     * case, so quoting a name that used to be emitted bare would point it at a
     * different object. Only mixed-case and reserved names get quotes.
     */
    protected quoteDdlPart(part: string): string {
        const needsQuotes = !POSTGRES_BARE_IDENTIFIER.test(part) || POSTGRES_RESERVED_WORDS.has(part);
        return needsQuotes ? `"${part}"` : part;
    }

    protected renderAutoIncrementColumn(name: string): string {
        return `${name} SERIAL PRIMARY KEY`;
    }

    protected renderAlterColumn(op: AlterColumnOp, table: string, column: string, type: string): string[] {
        const prefix = `ALTER TABLE ${table} ALTER COLUMN ${column}`;
        const statements = [`${prefix} TYPE ${type}`];
        if (op.nullable === false) statements.push(`${prefix} SET NOT NULL`);
        else if (op.nullable === true) statements.push(`${prefix} DROP NOT NULL`);
        if (op.defaultValue !== undefined) {
            statements.push(`${prefix} SET DEFAULT ${this.renderDdlLiteral(op.defaultValue, op.op)}`);
        }
        return statements;
    }

    protected renderEnsureAlterColumnType(table: string, column: string, type: string): string {
        return `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type} USING ${column}::${type}`;
    }

    protected renderRenameColumn(_op: RenameColumnOp, table: string, from: string, to: string): string {
        return `ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`;
    }

    protected renderRenameTable(_op: RenameTableOp, from: string, to: string): string {
        return `ALTER TABLE ${from} RENAME TO ${to}`;
    }

    protected renderDropIndex(_table: string, index: string): string {
        return `DROP INDEX IF EXISTS ${index}`;
    }

    protected renderMigrationHistory(table: string): string {
        return (
            `CREATE TABLE IF NOT EXISTS ${table} (` +
            `migration_id VARCHAR(255) PRIMARY KEY, ` +
            `migration_name VARCHAR(255) NOT NULL, ` +
            `applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`
        );
    }
}
