import { AggregateFn } from '../../core/query/model/Operand';
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
        if ((fn === 'sum' || fn === 'avg') && columnType !== undefined && /^\s*(decimal|numeric)\b/i.test(columnType)) {
            return `CAST(${sql} AS NVARCHAR(MAX))`;
        }
        return sql;
    }
}
