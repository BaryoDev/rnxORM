/**
 * Identifier, type and action validation for DDL.
 *
 * The dialect translators concatenate every name they are given into DDL. For a
 * hand-written migration those names are the developer's own code, so this is
 * defense in depth. It stops being that the moment an app builds migration
 * operations from request data, which the "custom fields per tenant" shape
 * does: a string default of `x'; DROP TABLE users; --` used to close the quote
 * and run (issue #44).
 *
 * These functions only validate. Quoting lives in the translators
 * (`SqlTranslator.translateDdl`), which call them before rendering anything.
 */

const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/**
 * Validate one identifier part and return it unchanged.
 * @throws when the part is not a plain identifier
 */
export function assertIdentifierPart(part: string, apiName: string, original: string): string {
    if (typeof part !== 'string' || !SIMPLE_IDENTIFIER.test(part)) {
        throw new Error(
            `${apiName}(): '${original}' is not a valid SQL identifier. ` +
            `Identifiers must match ${SIMPLE_IDENTIFIER.source}, optionally qualified as schema.name.`
        );
    }
    return part;
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
