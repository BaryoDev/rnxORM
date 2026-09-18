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
 *   then quoted for the dialect. Quoting is what makes a reserved word like
 *   `order` usable as a table name.
 * - String literals have their embedded quotes doubled, so a default value can
 *   never close the literal it sits in.
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

/** Wrap a validated identifier part in the dialect's quote characters. */
function quotePart(part: string, dialect: string): string {
    switch (dialect) {
        case 'mssql':
            return `[${part}]`;
        case 'mariadb':
            return `\`${part}\``;
        default:
            // PostgreSQL and the SQL standard.
            return `"${part}"`;
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
 * Render a value as a SQL literal for a DEFAULT clause.
 *
 * Strings are single-quoted with embedded quotes doubled, which is the
 * standard escape every supported dialect accepts. Numbers and booleans are
 * rendered bare. Anything else is rejected rather than stringified into
 * something like `[object Object]`.
 * @throws when the value is not a string, number, or boolean
 */
export function quoteLiteral(value: any, apiName: string): string {
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new Error(`${apiName}(): default value ${value} is not a finite number`);
        }
        return String(value);
    }

    if (typeof value === 'boolean') {
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
