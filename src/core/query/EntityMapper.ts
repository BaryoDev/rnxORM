import { DbContext } from "../DbContext";
import { DatabaseRow } from "../types";
import { MetadataStorage, EntityMetadata, ColumnMetadata } from "../MetadataStorage";
import { EntityState, snapshotEntity } from "../EntityEntry";

/**
 * Resolve the (converted) primary key value for a row, using the same
 * conversion the column mapping loop applies, so identity map keys stay
 * consistent with mapped entity property values.
 * Returns null when the entity is keyless or has no non-null pk value in
 * the row - those rows never touch the identity map.
 * @internal
 */
export function resolvePkValue(
    metadata: EntityMetadata | undefined,
    row: DatabaseRow
): { pkColumn: ColumnMetadata; pkValue: unknown } | null {
    const pkColumn = metadata?.columns.find((c) => c.isPrimaryKey);
    if (!pkColumn) return null;

    let pkValue = row[pkColumn.columnName];
    if (pkColumn.hasConversion && pkColumn.convertFromDb) {
        pkValue = pkColumn.convertFromDb(pkValue);
    }

    if (pkValue === null || pkValue === undefined) return null;

    return { pkColumn, pkValue };
}

/**
 * Shared helper to map database rows to entities
 * @internal
 */
export function mapRowToEntity<T>(
    entityType: new () => T,
    row: any,
    noTracking: boolean = false,
    context?: DbContext
): T {
    // Static, so it reads the caller's context model when there is one and
    // falls back to the ambient model otherwise (issue #32).
    const metadata = (context?.metadata ?? MetadataStorage.get()).getEntity(entityType);
    const track = !noTracking && !!context;

    // Identity map lookup (see DbSet.mapRowToEntity for rationale).
    const pk = track ? resolvePkValue(metadata, row) : null;
    if (pk) {
        const existing = context!.changeTracker.findByKey(entityType, pk.pkValue);
        if (existing !== undefined) {
            return existing as T;
        }
    }

    const entity = new entityType();
    metadata?.columns.forEach(col => {
        let value = row[col.columnName];

        if (col.hasConversion && col.convertFromDb) {
            value = col.convertFromDb(value);
        }

        // Only set non-shadow properties on the entity
        if (!col.isShadowProperty) {
            (entity as any)[col.propertyName] = value;
        }
    });

    // Track the entity if tracking is enabled and context is provided
    if (track) {
        const originalValues = snapshotEntity(entity);
        context!.changeTracker.track(entity, EntityState.Unchanged, originalValues);
        if (pk) {
            context!.changeTracker.registerIdentity(entityType, pk.pkValue, entity);
        }
    }

    return entity;
}
