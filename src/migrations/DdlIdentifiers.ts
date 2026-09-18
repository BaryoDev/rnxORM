import { IDatabaseProvider } from "../providers/IDatabaseProvider";

/**
 * Identifier validation and quoting for DDL built by `MigrationBuilder`.
 *
 * The builder concatenates every argument it is given straight into DDL. For a
 * hand-written migration those arguments are the developer's own code, so this
 * is defense in depth. It stops being that the moment an app builds migration
 * operations from request data, which the "custom fields per tenant" shape
 * does: a string default of `x'; DROP TABLE users; --` used to close the quote
 * and run (issue #44).
 *
 * Two rules, applied everywhere:
 *
 * - Identifiers must be plain identifiers (optionally `schema.name`), and are
 *   quoted when the dialect needs them quoted. Quoting is what makes a
 *   reserved word like `order` usable as a table name.
 * - String literals have their embedded quotes doubled, so a default value can
 *   never close the literal it sits in.
 *
 * Quoting is conditional on PostgreSQL and unconditional elsewhere, which
 * follows what the Npgsql provider does rather than what EF Core's base class
 * does. PostgreSQL folds unquoted identifiers to lower case and leaves quoted
 * ones alone, so `CREATE TABLE Users` creates `users` while
 * `CREATE TABLE "Users"` creates a different table named `Users`. The
 * PostgreSQL manual's advice is to "always quote a particular name or never
 * quote it" (section 4.1.1), so quoting a name that was previously emitted
 * bare would point it at a different object. Lower-case names are byte
 * identical either way, so they stay bare and only names that actually need
 * quoting get it.
 *
 * MySQL/MariaDB and SQL Server do not work this way: backticks and brackets
 * affect reserved words and special characters, not case resolution (which
 * comes from `lower_case_table_names` and the database collation
 * respectively). Quoting there cannot re-point an identifier, so it is
 * unconditional.
 */

const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Validate one identifier part and return it unchanged.
 * @throws when the part is not a plain identifier
 */
function assertIdentifierPart(part: string, apiName: string, original: string): string {
    if (typeof part !== 'string' || !SIMPLE_IDENTIFIER.test(part)) {
        throw new Error(
            `${apiName}(): '${original}' is not a valid SQL identifier. ` +
            `Identifiers must match ${SIMPLE_IDENTIFIER.source}, optionally qualified as schema.name.`
        );
    }
    return part;
}

/**
 * Validate an identifier (`name` or `schema.name`) and quote it for the
 * provider's dialect.
 * @throws when any part is not a plain identifier
 */
export function quoteIdentifier(
    name: string,
    provider: IDatabaseProvider,
    apiName: string
): string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`${apiName}(): identifier is required`);
    }

    const parts = name.split('.');
    if (parts.length > 2) {
        throw new Error(
            `${apiName}(): '${name}' has too many qualifiers. Use 'name' or 'schema.name'.`
        );
    }

    const dialect = provider.getDialect();
    return parts
        .map(part => quotePart(assertIdentifierPart(part, apiName, name), dialect))
        .join('.');
}

/**
 * PostgreSQL reserved words that cannot be used as a bare identifier.
 *
 * This is the `reserved` and `reserved (can be function or type)` set from the
 * PostgreSQL key-word appendix. Non-reserved words are omitted deliberately:
 * they are legal bare and quoting them would change their folded form.
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

/**
 * Whether an identifier has to be quoted to mean what it says on PostgreSQL.
 *
 * Only names that are already all lower case and not reserved can be left
 * bare: those fold to themselves, so quoted and unquoted forms refer to the
 * same object. Anything else (mixed case, a reserved word) changes meaning
 * without quotes.
 */
function postgresRequiresQuoting(part: string): boolean {
    return !POSTGRES_BARE_IDENTIFIER.test(part) || POSTGRES_RESERVED_WORDS.has(part);
}

/**
 * Wrap a validated identifier part in the dialect's quote characters, where
 * the dialect needs it.
 */
function quotePart(part: string, dialect: string): string {
    switch (dialect) {
        case 'mssql':
            return `[${part}]`;
        case 'mariadb':
            return `\`${part}\``;
        default:
            // PostgreSQL: bare where bare is unambiguous, so a lower-case name
            // keeps the exact form earlier versions emitted.
            return postgresRequiresQuoting(part) ? `"${part}"` : part;
    }
}

/**
 * Validate an unquoted identifier, for the one position that cannot take
 * quoting: the `sp_rename` new-name argument, which SQL Server expects as a
 * bare name inside a string literal.
 * @throws when the name is not a plain identifier
 */
export function assertPlainIdentifier(name: string, apiName: string): string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`${apiName}(): identifier is required`);
    }
    return assertIdentifierPart(name, apiName, name);
}

/**
 * Validate a possibly schema-qualified name for the `sp_rename` source
 * position, returning it unquoted.
 *
 * `sp_rename 'dbo.users.name', ...` is legal and worked before these
 * identifiers were validated, so each part is checked separately and rejoined
 * rather than rejecting the dot outright. The *new* name stays a single
 * identifier, because sp_rename requires an unqualified target.
 * @throws when any part is not a plain identifier
 */
export function assertQualifiedPlainIdentifier(name: string, apiName: string): string {
    if (typeof name !== 'string' || name.length === 0) {
        throw new Error(`${apiName}(): identifier is required`);
    }
    const parts = name.split('.');
    if (parts.length > 2) {
        throw new Error(
            `${apiName}(): '${name}' has too many qualifiers. Use 'name' or 'schema.name'.`
        );
    }
    return parts.map(part => assertIdentifierPart(part, apiName, name)).join('.');
}

/**
 * Render a value as a SQL literal for a DEFAULT clause.
 *
 * Strings are single-quoted with embedded quotes doubled, which is the
 * standard escape every supported dialect accepts. Numbers are rendered bare,
 * and booleans per dialect (SQL Server has no boolean type). Anything else is
 * rejected rather than stringified into something like `[object Object]`.
 * @throws when the value is not a string, number, or boolean
 */
export function quoteLiteral(value: any, apiName: string, dialect?: string): string {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`${apiName}(): default value ${value} is not a finite number`);
        }
        return String(value);
    }

    if (typeof value === 'boolean') {
        // SQL Server has no boolean type and rejects TRUE/FALSE as bit
        // literals, so a boolean default there has to be 1 or 0.
        if (dialect === 'mssql') return value ? '1' : '0';
        return value ? 'TRUE' : 'FALSE';
    }

    if (typeof value === 'string') {
        return `'${value.replace(/'/g, "''")}'`;
    }

    throw new Error(
        `${apiName}(): default value must be a string, number, or boolean, received ${
            value === null ? 'null' : typeof value
        }`
    );
}

/**
 * Validate a column type expression.
 *
 * Types are not identifiers: they carry length and precision (`varchar(100)`,
 * `decimal(18,4)`) and multi-word forms (`double precision`, `timestamp with
 * time zone`). They cannot be quoted, so they are matched against a grammar
 * that allows those shapes and nothing else.
 * @throws when the type is not a recognizable type expression
 */
const TYPE_EXPRESSION = /^[A-Za-z][A-Za-z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;

export function assertColumnType(type: string, apiName: string): string {
    if (typeof type !== 'string' || !TYPE_EXPRESSION.test(type.trim())) {
        throw new Error(
            `${apiName}(): '${type}' is not a valid column type. ` +
            `Expected a type name with optional length or precision, such as ` +
            `'integer', 'varchar(100)', or 'decimal(18,4)'.`
        );
    }
    return type.trim();
}

/**
 * Validate a referential action for `ON DELETE`.
 *
 * The parameter is typed as a union, but TypeScript erases at runtime and the
 * value reaches DDL directly, so an `as any` cast or untyped input used to land
 * verbatim in the statement.
 * @throws when the action is not one of the four SQL referential actions
 */
const CASCADE_ACTIONS = ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION'];

export function assertCascadeAction(action: string): string {
    const normalized = String(action).trim().toUpperCase().replace(/\s+/g, ' ');
    if (!CASCADE_ACTIONS.includes(normalized)) {
        throw new Error(
            `addForeignKey(): '${action}' is not a supported ON DELETE action. ` +
            `Allowed: ${CASCADE_ACTIONS.join(', ')}`
        );
    }
    return normalized;
}
