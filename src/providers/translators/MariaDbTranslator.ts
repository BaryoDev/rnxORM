import { AlterColumnOp, RenameColumnOp, RenameTableOp } from '../../core/query/model/DdlOperation';
import { SqlTranslator } from './SqlTranslator';

/** MariaDB has no bare OFFSET, so skip without take uses the largest LIMIT. */
const MAX_LIMIT = '18446744073709551615';

export class MariaDbTranslator extends SqlTranslator {
    protected placeholder(): string {
        return '?';
    }

    protected renderPagination(skip: number | undefined, take: number | undefined): string {
        let sql = '';
        if (take !== undefined) sql += ` LIMIT ${take}`;
        else if (skip !== undefined) sql += ` LIMIT ${MAX_LIMIT}`;
        if (skip !== undefined) sql += ` OFFSET ${skip}`;
        return sql;
    }

    protected renderIlike(left: string, placeholder: string): string {
        return `LOWER(${left}) LIKE LOWER(${placeholder})`;
    }

    protected quoteDdlPart(part: string): string {
        return `\`${part}\``;
    }

    protected renderAutoIncrementColumn(name: string): string {
        return `${name} INT AUTO_INCREMENT PRIMARY KEY`;
    }

    protected renderAlterColumn(op: AlterColumnOp, table: string, column: string, type: string): string[] {
        return [`ALTER TABLE ${table} MODIFY COLUMN ${column} ${type}${op.nullable === false ? ' NOT NULL' : ''}`];
    }

    protected renderRenameColumn(_op: RenameColumnOp, table: string, from: string, to: string): string {
        return `ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`;
    }

    protected renderRenameTable(_op: RenameTableOp, from: string, to: string): string {
        return `RENAME TABLE ${from} TO ${to}`;
    }

    protected renderDropIndex(table: string, index: string): string {
        return `DROP INDEX ${index} ON ${table}`;
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
