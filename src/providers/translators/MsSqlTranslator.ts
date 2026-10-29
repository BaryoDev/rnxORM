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
}
