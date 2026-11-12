import { ColumnMetadata } from "./MetadataStorage";

/**
 * Per-column conversion of a value a driver returned into the type the entity
 * property declares.
 *
 * The three drivers disagree. pg returns NUMERIC and BIGINT as strings.
 * mariadb returns DECIMAL as a string, BIGINT as a BigInt and TINYINT(1) as
 * 0 or 1. tedious returns numbers and booleans. Without this step the same
 * entity holds different runtime types per provider.
 *
 * Rules, by the column's declared type:
 * - decimal, numeric, float, double, real and the integer types become a
 *   number. A DECIMAL with more than 15 significant digits loses precision
 *   as a double. Declare the property as `string` (or `bigint` on a bigint
 *   column) to get the database's exact value instead.
 * - boolean, bit and tinyint(1) become a boolean.
 * - bigint becomes a bigint, unless the property is declared `number` (a
 *   number, exact only up to 2^53) or `string` (exact text).
 * - everything else, and null, passes through.
 *
 * A column with its own value converter is not handled here: the converter
 * gets the driver value as it came.
 */

const BOOLEAN_TYPE = /^(boolean|bool|bit|tinyint\s*\(\s*1\s*\))$/;
const BIGINT_TYPE = /^bigint\b/;
const NUMBER_TYPE = /^(decimal|dec|numeric|float|double|real|integer|int|smallint|mediumint|tinyint)\b/;

type Declared = ColumnMetadata['designType'];

function toBoolean(value: unknown): unknown {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number' || typeof value === 'bigint') return value != 0;
    if (typeof value === 'string') {
        const v = value.trim().toLowerCase();
        if (v === '1' || v === 't' || v === 'true') return true;
        if (v === '0' || v === 'f' || v === 'false') return false;
    }
    return value;
}

function toNumber(value: unknown): unknown {
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'string' && value.trim().length > 0) {
        const n = Number(value);
        return Number.isNaN(n) ? value : n;
    }
    return value;
}

function toBigInt(value: unknown): unknown {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value) : value;
    if (typeof value === 'string' && /^\s*-?\d+\s*$/.test(value)) return BigInt(value.trim());
    return value;
}

function toText(value: unknown): unknown {
    return typeof value === 'number' || typeof value === 'bigint' ? String(value) : value;
}

/** Convert one driver value for a column, per the rules above. */
export function convertColumnValue(
    column: Pick<ColumnMetadata, 'type' | 'designType'>,
    value: unknown
): unknown {
    if (value === null || value === undefined) return value;

    const type = (column.type ?? '').trim().toLowerCase();
    if (BOOLEAN_TYPE.test(type)) return toBoolean(value);

    const isBigint = BIGINT_TYPE.test(type);
    if (!isBigint && !NUMBER_TYPE.test(type)) return value;

    const declared: Declared = column.designType;
    if (declared === String) return toText(value);
    if (declared === BigInt || (isBigint && declared !== Number)) return toBigInt(value);
    return toNumber(value);
}
