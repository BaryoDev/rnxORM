/**
 * Conversions for values that arrive from a driver as a string, a BigInt, or a
 * number depending on which driver it was.
 *
 * The three supported drivers disagree about BIGINT and DECIMAL: pg returns
 * both as strings, mariadb returns BIGINT as a JS BigInt and DECIMAL as a
 * string, tedious returns BIGINT as a string and parses DECIMAL into a double.
 * The ORM used to funnel all of them through Number()/parseFloat(), which
 * silently rounds anything a double cannot represent: a generated key above
 * 2^53 came back wrong, and a DECIMAL sum lost its cents (issue #39).
 *
 * The rule here: convert to a number when that is exact, and otherwise keep
 * the database's own string, which is lossless and still compares and prints
 * correctly. Callers that need arbitrary-precision arithmetic can parse the
 * string with a decimal library.
 */

/**
 * Convert a driver-supplied numeric value to a JS number when that round-trips
 * exactly, otherwise return the value's exact string form.
 *
 * Returns `undefined`/`null` unchanged so callers can apply their own default.
 */
export function toExactNumber(value: any): any {
    if (value === undefined || value === null) return value;

    if (typeof value === 'number') return value;

    if (typeof value === 'bigint') {
        // A BigInt within the safe range is an ordinary number; beyond it,
        // Number() would round, so the exact decimal string is kept.
        return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
            ? Number(value)
            : value.toString();
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (trimmed === '') return value;
        const asNumber = Number(trimmed);
        if (!Number.isFinite(asNumber)) return value;
        // Round-trip test: if the number prints back to the same digits, the
        // conversion was exact. "12345678901234567.89" does not, so it stays a
        // string rather than becoming 12345678901234568.
        return numericStringsMatch(trimmed, asNumber) ? asNumber : trimmed;
    }

    return value;
}

/**
 * Whether a numeric string and the number it parsed to represent the same
 * value, comparing normalized decimal forms rather than raw text so that
 * "1.50" and 1.5, or "+7" and 7, still count as an exact conversion.
 */
function numericStringsMatch(text: string, parsed: number): boolean {
    return normalizeNumericString(text) === normalizeNumericString(String(parsed));
}

/** Strip a leading +, leading zeros, and trailing fractional zeros. */
function normalizeNumericString(text: string): string {
    const match = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
    if (!match) return text.trim();

    const sign = match[1] === '-' ? '-' : '';
    const whole = (match[2] ?? '').replace(/^0+(?=\d)/, '') || '0';
    const fraction = (match[3] ?? '').replace(/0+$/, '');

    const digits = fraction ? `${whole}.${fraction}` : whole;
    return digits === '0' ? '0' : `${sign}${digits}`;
}

/**
 * Parse a COUNT() result, which is a string on pg and mariadb and a number on
 * tedious. Counts are row totals, so they stay within the safe range; the
 * guards here are for an absent row and for the missing radix that made
 * parseInt() dependent on the string's leading characters.
 */
export function toCount(value: any): number {
    if (value === undefined || value === null) return 0;
    if (typeof value === 'number') return value;
    if (typeof value === 'bigint') return Number(value);
    const parsed = parseInt(String(value), 10);
    return Number.isNaN(parsed) ? 0 : parsed;
}
