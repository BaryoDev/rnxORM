import { MetadataStorage } from "./MetadataStorage";

/**
 * Runtime validation for SQL identifiers and operators that arrive as strings
 * through the public query API (`where()`, `orderBy()`, `having()`, query
 * filter conditions). Values are always parameterized elsewhere; these checks
 * close the remaining injection surface: column names and operators used to be
 * interpolated into SQL unvalidated (issue #13).
 */

export const ALLOWED_OPERATORS = [
    '=', '!=', '<>', '>', '<', '>=', '<=', 'LIKE', 'ILIKE', 'NOT LIKE',
] as const;

export type ComparisonOperator = (typeof ALLOWED_OPERATORS)[number];

const AGGREGATE_EXPRESSION = /^(COUNT|SUM|AVG|MIN|MAX)\s*\(\s*(\*|[A-Za-z_][A-Za-z0-9_]*)\s*\)$/i;
const SIMPLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Validate a comparison operator against the closed allowed set.
 * Keyword operators (LIKE/ILIKE/NOT LIKE) are matched case-insensitively and
 * returned uppercased; symbolic operators are returned as-is.
 * @throws when the operator is not in the allowed set
 */
export function assertOperator(operator: string, apiName: string): string {
    const normalized = operator.trim().toUpperCase().replace(/\s+/g, ' ');
    if ((ALLOWED_OPERATORS as readonly string[]).includes(normalized)) {
        return normalized;
    }
    throw new Error(
        `${apiName}(): operator '${operator}' is not supported. ` +
        `Allowed operators: ${ALLOWED_OPERATORS.join(', ')}`
    );
}

/**
 * Validate a column reference against the entity's mapped columns and return
 * the database column name to embed in SQL.
 *
 * Accepts either a property name or a column name: the string-based query API
 * predates validation and callers may already pass either form (they are
 * usually identical because @Column defaults the column name to the
 * lowercased property name).
 * @throws when the name matches no mapped column and no mapped property
 */
export function assertColumn(
    entityType: new (...args: any[]) => any,
    name: string,
    apiName: string
): string {
    const metadata = MetadataStorage.get().getEntity(entityType);
    if (!metadata) {
        throw new Error(
            `${apiName}(): cannot validate column '${name}' — ${entityType.name} has no entity metadata`
        );
    }

    const byProperty = metadata.columns.find(c => c.propertyName === name);
    if (byProperty) return byProperty.columnName;

    const byColumn = metadata.columns.find(c => c.columnName === name);
    if (byColumn) return byColumn.columnName;

    throw new Error(
        `${apiName}(): '${name}' is not a mapped column or property of ${metadata.target.name}. ` +
        `Mapped properties: ${metadata.columns.map(c => c.propertyName).join(', ')}`
    );
}

/**
 * Validate the first argument of `having()`: either a mapped column reference
 * or an aggregate expression over one (`COUNT(*)`, `SUM(price)`, ...).
 * Returns the string to embed in SQL.
 * @throws when the expression is neither
 */
export function assertHavingExpression(
    entityType: new (...args: any[]) => any,
    expression: string,
    apiName: string
): string {
    const aggregate = expression.trim().match(AGGREGATE_EXPRESSION);
    if (aggregate) {
        const fn = aggregate[1].toUpperCase();
        const inner = aggregate[2];
        if (inner === '*') return `${fn}(*)`;
        return `${fn}(${assertColumn(entityType, inner, apiName)})`;
    }
    return assertColumn(entityType, expression, apiName);
}

/**
 * Validate an ORDER BY target on grouped queries, where the target may be a
 * mapped column or a projection alias that only exists in the SELECT list.
 * Aliases cannot be checked against metadata, so they must at least be shaped
 * like a plain identifier — which rules out every injection vector (quotes,
 * whitespace, semicolons, comment markers).
 * @throws when the name is neither a mapped column/property nor a plain identifier
 */
export function assertColumnOrAlias(
    entityType: new (...args: any[]) => any,
    name: string,
    apiName: string
): string {
    const metadata = MetadataStorage.get().getEntity(entityType);
    const byProperty = metadata?.columns.find(c => c.propertyName === name);
    if (byProperty) return byProperty.columnName;
    const byColumn = metadata?.columns.find(c => c.columnName === name);
    if (byColumn) return byColumn.columnName;
    if (SIMPLE_IDENTIFIER.test(name)) return name;
    throw new Error(
        `${apiName}(): '${name}' is neither a mapped column of ` +
        `${entityType.name} nor a plain identifier`
    );
}
