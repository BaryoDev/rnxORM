import { AlterColumnOp, DdlOperation, RenameColumnOp, RenameTableOp } from '../../../src/core/query/model/DdlOperation';
import { SqlStatement } from '../../../src/core/query/model/SqlStatement';
import { SqlTranslator } from '../../../src/providers/translators/SqlTranslator';
import { TypeMap, createTypeMapper } from '../../../src/providers/translators/typeMapping';

/**
 * Declared types keep the names the wrapper reads back (`BOOLEAN`,
 * `DATETIME`), because SQLite itself stores 0/1 and text.
 */
const TYPE_MAP = {
    text: 'TEXT',
    integer: 'INTEGER',
    boolean: 'BOOLEAN',
    timestamp: 'DATETIME',
    date: 'DATE',
    time: 'TIME',
    decimal: 'DECIMAL(18,2)',
    float: 'REAL',
    double: 'DOUBLE',
    bigint: 'BIGINT',
    json: 'TEXT',
} satisfies TypeMap;

const PASSTHROUGH_TYPES = ['varchar', 'decimal'] as const;

/**
 * Test-only SQLite dialect. It covers what the integration suite and
 * ensureCreated need. SQLite cannot alter a column or add a constraint to an
 * existing table, so those operations either throw a clear error or are
 * skipped, as noted on each.
 */
export class SqliteTranslator extends SqlTranslator {
    readonly mapType = createTypeMapper(TYPE_MAP, PASSTHROUGH_TYPES);

    protected readonly joinKeyType = 'INTEGER';

    protected placeholder(): string {
        return '?';
    }

    protected renderPagination(skip: number | undefined, take: number | undefined): string {
        let sql = '';
        if (take !== undefined) sql += ` LIMIT ${take}`;
        else if (skip !== undefined) sql += ' LIMIT -1';
        if (skip !== undefined) sql += ` OFFSET ${skip}`;
        return sql;
    }

    protected renderIlike(left: string, placeholder: string): string {
        return `LOWER(${left}) LIKE LOWER(${placeholder})`;
    }

    protected renderInsertReturning(returning: string): string {
        return ` RETURNING ${returning}`;
    }

    protected renderDdlBoolean(value: boolean): string {
        return value ? '1' : '0';
    }

    protected quoteDdlPart(part: string): string {
        return `"${part}"`;
    }

    protected renderAutoIncrementColumn(name: string): string {
        return `${name} INTEGER PRIMARY KEY AUTOINCREMENT`;
    }

    protected renderAlterColumn(_op: AlterColumnOp): string[] {
        throw new Error(
            'SQLite cannot alter a column in place. alterColumn needs the full table definition ' +
            'to copy the table, and this test translator does not carry one.'
        );
    }

    protected renderEnsureAlterColumnType(): string {
        throw new Error('SQLite cannot alter a column type in place.');
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
            `applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`
        );
    }

    translateDdl(op: DdlOperation): SqlStatement[] {
        switch (op.op) {
            case 'addForeignKey':
            case 'dropForeignKey':
                throw new Error(
                    `SQLite cannot ${op.op === 'addForeignKey' ? 'add' : 'drop'} a foreign key on an existing table. ` +
                    'Declare it in createTable.'
                );
            // A constraint added later is a no-op here: SQLite cannot add a foreign key to an
            // existing table, and the column type needs no change because SQLite is dynamically typed.
            case 'ensureForeignKey':
            case 'ensureAlterColumnType':
                return [];
            case 'ensureUniqueConstraint':
                return [{
                    text: `CREATE UNIQUE INDEX ${op.constraint} ON ${op.table} (${op.columns.join(', ')})`,
                    params: [],
                }];
            default:
                return super.translateDdl(op);
        }
    }
}
