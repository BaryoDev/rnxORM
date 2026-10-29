import { SqlTranslator } from './SqlTranslator';

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
}
