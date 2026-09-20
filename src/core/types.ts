/**
 * Shared vocabulary types.
 *
 * Values that reach SQL as strings are declared here as closed unions derived
 * from `as const` arrays, so the compiler rejects a typo and the runtime
 * validator has a single list to check against. The runtime checks stay:
 * TypeScript erases, and these values arrive from callers who may not be
 * type-checked at all.
 */

/** SQL dialects with a shipped provider. */
export const DIALECTS = ['postgresql', 'mssql', 'mariadb'] as const;

/**
 * The dialect identifier a provider reports from `getDialect()`.
 *
 * Previously `string`, which meant a misspelled comparison silently took the
 * fallback branch instead of failing to compile.
 */
export type Dialect = (typeof DIALECTS)[number];

/** Narrow an arbitrary string to a `Dialect`. */
export function isDialect(value: string): value is Dialect {
    return (DIALECTS as readonly string[]).includes(value);
}

/** The four SQL referential actions valid after `ON DELETE` / `ON UPDATE`. */
export const REFERENTIAL_ACTIONS = ['CASCADE', 'SET NULL', 'RESTRICT', 'NO ACTION'] as const;

export type ReferentialAction = (typeof REFERENTIAL_ACTIONS)[number];

/** Sort direction for `ORDER BY`. */
export type SortDirection = 'ASC' | 'DESC';

/**
 * A value that can be bound as a query parameter.
 *
 * Deliberately wider than the column types: a value converter may hand back
 * anything the driver accepts, and `Date` and `Buffer` both reach the wire
 * unconverted.
 */
export type QueryParameter =
    | string
    | number
    | bigint
    | boolean
    | Date
    | Buffer
    | null
    | undefined;

/**
 * Narrow an entity property (or a value converter's output) to something
 * bindable as a query parameter.
 *
 * Column values are `unknown` once metadata is involved, and a value converter
 * may return anything, so this is the one place that decision is made. It is a
 * cast, not a check: the driver is the thing that ultimately validates a bound
 * value, and rejecting here would break converters that legitimately return a
 * driver-specific type.
 */
export function asQueryParameter(value: unknown): QueryParameter {
    return value as QueryParameter;
}

/**
 * A row as it comes off the driver.
 *
 * Column names are not known at compile time, so the index signature is the
 * honest type. It is `unknown` rather than `any` so that reading a column
 * forces a narrowing decision at the point of use.
 */
export type DatabaseRow = Record<string, unknown>;

/**
 * An entity instance as the ORM handles it internally.
 *
 * Property names are not statically known when reflecting over metadata, so
 * this is the internal shape. Public APIs stay generic over `T`.
 */
export type EntityLike = Record<string, unknown>;

/** Constructor of an entity class, as stored in metadata and used as a map key. */
export type EntityConstructor<T = unknown> = new (...args: never[]) => T;
