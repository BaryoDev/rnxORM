import { SqlTranslator } from './SqlTranslator';

export class PostgresTranslator extends SqlTranslator {
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
}
