/**
 * Represents the state of an entity being tracked by the context
 */
export enum EntityState {
    /**
     * The entity is being tracked but does not yet exist in the database
     */
    Added = 'Added',

    /**
     * The entity is being tracked and exists in the database, and its property values have not changed
     */
    Unchanged = 'Unchanged',

    /**
     * The entity is being tracked and exists in the database, and some or all of its property values have been modified
     */
    Modified = 'Modified',

    /**
     * The entity is being tracked and exists in the database, but has been marked for deletion
     */
    Deleted = 'Deleted',

    /**
     * The entity is not being tracked by the context
     */
    Detached = 'Detached'
}

/**
 * Provides access to tracking information and operations for an entity
 */
export class EntityEntry<T> {
    private _state: EntityState;
    private _originalValues: Partial<T>;
    private _currentValues: T;

    constructor(
        public readonly entity: T,
        state: EntityState,
        originalValues?: Partial<T>
    ) {
        this._state = state;
        this._currentValues = entity;
        this._originalValues = originalValues || { ...entity };
    }

    /**
     * Gets or sets the state of the entity
     */
    get state(): EntityState {
        return this._state;
    }

    set state(value: EntityState) {
        this._state = value;
    }

    /**
     * Gets the original values of the entity (as loaded from the database)
     */
    get originalValues(): Partial<T> {
        return { ...this._originalValues };
    }

    /**
     * Gets the current values of the entity
     */
    get currentValues(): T {
        return this._currentValues;
    }

    /**
     * Check if the entity has been modified
     */
    get isModified(): boolean {
        if (this._state === EntityState.Modified) {
            return true;
        }

        // Check if any properties have changed
        for (const key in this._currentValues) {
            if (this._currentValues[key] !== this._originalValues[key]) {
                return true;
            }
        }

        return false;
    }

    /**
     * Get the names of properties that have been modified
     */
    getModifiedProperties(): string[] {
        const modified: string[] = [];

        for (const key in this._currentValues) {
            if (this._currentValues[key] !== this._originalValues[key]) {
                modified.push(key);
            }
        }

        return modified;
    }

    /**
     * Reset the entity to its original values
     */
    reload(): void {
        Object.assign(this._currentValues as any, this._originalValues);
        this._state = EntityState.Unchanged;
    }

    /**
     * Accept changes (mark current values as original)
     */
    acceptChanges(): void {
        this._originalValues = { ...this._currentValues };
        this._state = EntityState.Unchanged;
    }
}
