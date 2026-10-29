import { AggregateFn } from '../../core/query/model/Operand';
import { Operand } from '../../core/query/model/Operand';
import { SelectModel } from '../../core/query/model/SelectModel';
import { AlterColumnOp, RenameColumnOp, RenameTableOp } from '../../core/query/model/DdlOperation';
import { assertPlainIdentifier, assertQualifiedPlainIdentifier } from '../../migrations/DdlIdentifiers';
import { SqlTranslator } from './SqlTranslator';

const INTEGER_TYPE = /^\s*(tinyint|smallint|int|integer|bigint)\b/i;

export class MsSqlTranslator extends SqlTranslator {
    protected placeholder(n: number): string {
        return `@p${n - 1}`;
    }

    protected renderPagination(
        skip: number | undefined,
        take: number | undefined,
        hasOrder: boolean
    ): string {
        // OFFSET/FETCH is only valid after an ORDER BY.
        let sql = hasOrder ? '' : ' ORDER BY (SELECT NULL)';
        sql += ` OFFSET ${skip ?? 0} ROWS`;
        if (take !== undefined) sql += ` FETCH NEXT ${take} ROWS ONLY`;
        return sql;
    }

    protected renderIlike(left: string, placeholder: string): string {
        return `LOWER(${left}) LIKE LOWER(${placeholder})`;
    }

    protected renderInsertOutput(returning: string): string {
        return ` OUTPUT INSERTED.${returning}`;
    }

    protected wrapIdentityInsert(table: string, sql: string): string {
        return `SET IDENTITY_INSERT ${table} ON; ${sql}; SET IDENTITY_INSERT ${table} OFF`;
    }

    /**
     * SQL Server's AVG over an integer column returns an integer (1 and 2
     * average to 1), where PostgreSQL and MariaDB return 1.5. Widening the
     * operand first gives the same answer, in HAVING and ORDER BY too.
     */
    protected renderAggregate(fn: AggregateFn, column: string | undefined, columnType?: string): string {
        if (fn === 'avg' && column !== undefined && columnType !== undefined && INTEGER_TYPE.test(columnType)) {
            return `AVG(CAST(${this.quoteIdentifier(column)} AS DECIMAL(38,6)))`;
        }
        return super.renderAggregate(fn, column, columnType);
    }

    /**
     * Tedious parses DECIMAL results into a double, so a SUM or AVG over a
     * decimal column loses digits. Returning it as text keeps them exact.
     * Float and integer columns are left alone: CAST(float AS NVARCHAR) keeps
     * about 6 significant digits, which is worse than the driver's double.
     */
    protected renderAggregateOutput(fn: AggregateFn, column: string | undefined, columnType?: string): string {
        const sql = this.renderAggregate(fn, column, columnType);
        if ((fn === 'sum' || fn === 'avg') && columnType !== undefined && /^\s*(decimal|dec|numeric)\b/i.test(columnType)) {
            return `CAST(${sql} AS NVARCHAR(MAX))`;
        }
        return sql;
    }

    /**
     * T-SQL binds a bare ORDER BY name to the select alias, and an aliased
     * decimal aggregate is NVARCHAR here, so it would sort as text. Sort by
     * the numeric aggregate instead.
     */
    protected renderOrderOperand(operand: Operand, model: SelectModel): string {
        if (operand.kind === 'column') {
            const item = (model.items ?? []).find((i) => i.alias === operand.name);
            if (item && item.operand.kind === 'agg') {
                const { fn, column, columnType } = item.operand;
                if (this.renderAggregateOutput(fn, column, columnType) !== this.renderAggregate(fn, column, columnType)) {
                    return this.renderAggregate(fn, column, columnType);
                }
            }
        }
        return super.renderOrderOperand(operand, model);
    }

    protected quoteDdlPart(part: string): string {
        return `[${part}]`;
    }

    /** SQL Server has no boolean type and rejects TRUE/FALSE as bit literals. */
    protected renderDdlBoolean(value: boolean): string {
        return value ? '1' : '0';
    }

    protected renderAutoIncrementColumn(name: string): string {
        return `${name} INT IDENTITY(1,1) PRIMARY KEY`;
    }

    protected renderAlterColumn(op: AlterColumnOp, table: string, column: string, type: string): string[] {
        return [`ALTER TABLE ${table} ALTER COLUMN ${column} ${type}${op.nullable === false ? ' NOT NULL' : ''}`];
    }

    /**
     * sp_rename takes bare names inside string literals, so these positions
     * cannot be quoted and are validated instead. A payload here used to close
     * the literal and run (issue #44).
     */
    protected renderRenameColumn(op: RenameColumnOp): string {
        const table = assertQualifiedPlainIdentifier(op.table, op.op);
        const from = assertPlainIdentifier(op.from, op.op);
        const to = assertPlainIdentifier(op.to, op.op);
        return `EXEC sp_rename '${table}.${from}', '${to}', 'COLUMN'`;
    }

    protected renderRenameTable(op: RenameTableOp): string {
        const from = assertQualifiedPlainIdentifier(op.from, op.op);
        const to = assertPlainIdentifier(op.to, op.op);
        return `EXEC sp_rename '${from}', '${to}'`;
    }

    protected renderDropIndex(table: string, index: string): string {
        return `DROP INDEX ${index} ON ${table}`;
    }

    protected renderMigrationHistory(table: string): string {
        return (
            `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${table}')\n` +
            `CREATE TABLE ${table} (` +
            `migration_id NVARCHAR(255) PRIMARY KEY, ` +
            `migration_name NVARCHAR(255) NOT NULL, ` +
            `applied_at DATETIME2 NOT NULL DEFAULT GETDATE())`
        );
    }
}
