/**
 * Shared column type mapping.
 *
 * All three providers map a declared column type to a dialect type the same
 * way: look the name up in a table, pass parameterized types like
 * `varchar(50)` through untouched, and uppercase anything unrecognised. Only
 * the table and the passthrough rule differ, so the algorithm lives here and
 * each provider supplies its own data.
 */

/**
 * The column types the ORM understands by name.
 *
 * A provider's map is checked against this set, so adding a type here without
 * mapping it in every provider is a compile error rather than a value that
 * silently falls through to the uppercase branch.
 */
export const COLUMN_TYPES = [
    'text',
    'integer',
    'boolean',
    'timestamp',
    'date',
    'time',
    'decimal',
    'float',
    'double',
    'bigint',
    'json',
] as const;

export type ColumnType = (typeof COLUMN_TYPES)[number];

/** A complete mapping from every known column type to its dialect spelling. */
export type TypeMap = Record<ColumnType, string>;

/**
 * Build a `mapType` implementation from a provider's table and rules.
 *
 * @param typeMap    dialect spelling for each known column type
 * @param passthrough type prefixes that carry their own parameters
 *                    (`varchar(50)`), returned uppercased rather than looked up
 * @param transform  optional last step, for SQL Server's N-prefix on varchar
 */
export function createTypeMapper(
    typeMap: TypeMap,
    passthrough: readonly string[],
    transform?: (upperType: string, lowerType: string) => string | undefined
): (tsType: string) => string {
    return (tsType: string): string => {
        const lowerType = tsType.toLowerCase();

        // Exact names win over the passthrough prefixes. `decimal` used to
        // match the `decimal` prefix and return a bare DECIMAL, which means
        // (10,0) on MariaDB and MySQL: the fractional part was dropped and the
        // configured precision in the map below was unreachable (issue #60).
        const exact = typeMap[lowerType as ColumnType];
        if (exact !== undefined) return exact;

        // Parameterized types carry their own precision, so they pass through.
        for (const prefix of passthrough) {
            if (lowerType.startsWith(prefix)) {
                const upper = tsType.toUpperCase();
                return transform?.(upper, lowerType) ?? upper;
            }
        }

        return tsType.toUpperCase();
    };
}

/**
 * Build a `normalizeType` implementation.
 *
 * Normalizing is the same shape as mapping without the passthrough rules: a
 * lookup with a lowercase fallback, used to compare a declared type against
 * what the database reports.
 */
export function createTypeNormalizer(
    normalizeMap: Readonly<Record<string, string>>
): (dbType: string) => string {
    return (dbType: string): string => {
        const lowerType = dbType.toLowerCase();
        return normalizeMap[lowerType] ?? lowerType;
    };
}
