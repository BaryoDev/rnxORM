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
}
