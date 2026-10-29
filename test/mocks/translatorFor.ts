import { SqlTranslator } from '../../src/providers/translators/SqlTranslator';
import { PostgresTranslator } from '../../src/providers/translators/PostgresTranslator';
import { MsSqlTranslator } from '../../src/providers/translators/MsSqlTranslator';
import { MariaDbTranslator } from '../../src/providers/translators/MariaDbTranslator';

/** The shipped translator for a dialect name. Unknown names get PostgreSQL. */
export function translatorFor(dialect: string): SqlTranslator {
    if (dialect === 'mssql') return new MsSqlTranslator();
    if (dialect === 'mariadb') return new MariaDbTranslator();
    return new PostgresTranslator();
}
