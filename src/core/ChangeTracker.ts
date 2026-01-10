import { EntityEntry, EntityState } from "./EntityEntry";

/**
 * Tracks changes to entities loaded from or added to the context
 */
export class ChangeTracker {
    private trackedEntities: Map<any, EntityEntry<any>> = new Map();
    private autoDetectChanges: boolean = true;

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
        return entry;
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

        // Remove deleted entities from tracking
        for (const entity of entriesToRemove) {
            this.trackedEntities.delete(entity);
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

