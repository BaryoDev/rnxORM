import { EntityEntry, EntityState } from "./EntityEntry";
import { MetadataStorage } from "./MetadataStorage";

/**
 * Tracks changes to entities loaded from or added to the context
 */
export class ChangeTracker {
    private trackedEntities: Map<any, EntityEntry<any>> = new Map();
    private autoDetectChanges: boolean = true;

    /**
     * Identity map: entity constructor -> primary key value -> tracked entity instance.
     * Lets the row-mapping path (DbSet) return the SAME tracked instance when the
     * same row is loaded more than once, instead of two conflicting instances.
     */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    private identityMap: Map<Function, Map<any, any>> = new Map();

    /**
     * Gets or sets whether DetectChanges is called automatically
     */
    get autoDetectChangesEnabled(): boolean {
        return this.autoDetectChanges;
    }

    set autoDetectChangesEnabled(value: boolean) {
        this.autoDetectChanges = value;
    }

    /**
     * Track an entity with the specified state
     */
    track<T>(entity: T, state: EntityState, originalValues?: Partial<T>): EntityEntry<T> {
        if (this.trackedEntities.has(entity)) {
            const entry = this.trackedEntities.get(entity)!;
            entry.state = state;
            return entry;
        }

        const entry = new EntityEntry<T>(entity, state, originalValues);
        this.trackedEntities.set(entity, entry);
        this.registerIdentityFromEntity(entity, state);
        return entry;
    }

    /**
     * Identity-map an entity that entered tracking without a database round
     * trip. `attach()`, `update()`, or `add()` with an explicit key. Without
     * this, a later `find()` for the same key maps a second instance and the
     * context holds two tracked copies of one row (issue #5's third door).
     *
     * Entities with no key value yet (a pending auto-increment insert) are
     * skipped here and registered by DbContext once the key is backfilled;
     * Detached entities are deliberately not identity-mapped.
     */
    private registerIdentityFromEntity(entity: any, state: EntityState): void {
        if (state === EntityState.Detached || entity === null || typeof entity !== 'object') {
            return;
        }
        const metadata = MetadataStorage.get().getEntity(entity.constructor);
        const pkColumn = metadata?.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) return;

        // The identity map is keyed by the ENTITY-side value, which is what the
        // row-mapping path registers after applying convertFromDb.
        const pkValue = entity[pkColumn.propertyName];
        if (pkValue === undefined || pkValue === null) return;

        this.registerIdentity(entity.constructor, pkValue, entity);
    }

    /**
     * Get the entry for a tracked entity
     */
    entry<T>(entity: T): EntityEntry<T> | undefined {
        return this.trackedEntities.get(entity);
    }

    /**
     * Check if an entity is being tracked
     */
    isTracked<T>(entity: T): boolean {
        return this.trackedEntities.has(entity);
    }

    /**
     * Stop tracking an entity
     */
    untrack<T>(entity: T): void {
        this.trackedEntities.delete(entity);
        this.removeFromIdentityMap(entity);
    }

    /**
     * Look up a tracked entity by its type and primary key value.
     * @param entityType The entity's constructor function
     * @param pkValue The primary key value (already converted, if the column has a conversion)
     */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    findByKey(entityType: Function, pkValue: any): any | undefined {
        return this.identityMap.get(entityType)?.get(pkValue);
    }

    /**
     * Register an entity in the identity map so subsequent loads of the same
     * primary key return this same instance.
     * @param entityType The entity's constructor function
     * @param pkValue The primary key value (already converted, if the column has a conversion)
     * @param entity The entity instance to register
     */
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    registerIdentity(entityType: Function, pkValue: any, entity: any): void {
        let typeMap = this.identityMap.get(entityType);
        if (!typeMap) {
            typeMap = new Map();
            this.identityMap.set(entityType, typeMap);
        }
        typeMap.set(pkValue, entity);
    }

    /**
     * Remove any identity map entry pointing at this entity instance.
     * Scans by value (O(n) per type map) since the map is keyed by pk value,
     * not by entity reference.
     */
    private removeFromIdentityMap(entity: any): void {
        for (const typeMap of this.identityMap.values()) {
            for (const [key, value] of typeMap.entries()) {
                if (value === entity) {
                    typeMap.delete(key);
                }
            }
        }
    }

    /**
     * Get all tracked entities
     */
    entries(): IterableIterator<EntityEntry<any>> {
        return this.trackedEntities.values();
    }

    /**
     * Get all entries with a specific state
     */
    getEntriesByState(state: EntityState): EntityEntry<any>[] {
        const result: EntityEntry<any>[] = [];
        for (const entry of this.trackedEntities.values()) {
            if (entry.state === state) {
                result.push(entry);
            }
        }
        return result;
    }

    /**
     * Get all entries that have changes (Added, Modified, or Deleted)
     */
    getChangedEntries(): EntityEntry<any>[] {
        const result: EntityEntry<any>[] = [];
        for (const entry of this.trackedEntities.values()) {
            if (entry.state === EntityState.Added ||
                entry.state === EntityState.Modified ||
                entry.state === EntityState.Deleted) {
                result.push(entry);
            }
        }
        return result;
    }

    /**
     * Detect changes in all tracked entities
     */
    detectChanges(): void {
        for (const entry of this.trackedEntities.values()) {
            if (entry.state === EntityState.Unchanged) {
                if (entry.isModified) {
                    entry.state = EntityState.Modified;
                }
            }
        }
    }

    /**
     * Check if there are any pending changes
     */
    hasChanges(): boolean {
        for (const entry of this.trackedEntities.values()) {
            if (entry.state === EntityState.Added ||
                entry.state === EntityState.Modified ||
                entry.state === EntityState.Deleted) {
                return true;
            }
        }
        return false;
    }

    /**
     * Clear all tracked entities
     */
    clear(): void {
        this.trackedEntities.clear();
        this.identityMap.clear();
    }

    /**
     * Accept all changes (mark all entities as Unchanged)
     */
    acceptAllChanges(): void {
        const entriesToRemove: any[] = [];

        for (const entry of this.trackedEntities.values()) {
            if (entry.state === EntityState.Deleted) {
                entriesToRemove.push(entry.entity);
            } else {
                entry.acceptChanges();
            }
        }

        // Remove deleted entities from tracking (and from the identity map)
        for (const entity of entriesToRemove) {
            this.trackedEntities.delete(entity);
            this.removeFromIdentityMap(entity);
        }
    }

    /**
     * Get statistics about tracked entities
     */
    getStatistics(): {
        total: number;
        added: number;
        modified: number;
        deleted: number;
        unchanged: number;
    } {
        let added = 0, modified = 0, deleted = 0, unchanged = 0;

        for (const entry of this.trackedEntities.values()) {
            switch (entry.state) {
                case EntityState.Added:
                    added++;
                    break;
                case EntityState.Modified:
                    modified++;
                    break;
                case EntityState.Deleted:
                    deleted++;
                    break;
                case EntityState.Unchanged:
                    unchanged++;
                    break;
            }
        }

        return {
            total: this.trackedEntities.size,
            added,
            modified,
            deleted,
            unchanged
        };
    }
}

