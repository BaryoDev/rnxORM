import { MetadataStorage } from "./MetadataStorage";

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
 * The property names change detection should compare: an entity's mapped
 * columns, or every own property when there is no metadata (a plain object in
 * a unit test, for instance).
 *
 * Navigation properties are deliberately excluded. They are relations, not
 * column values, and `include()` assigns them after the original-values
 * snapshot is taken, which used to make every eagerly-loaded root look
 * modified and earn a phantom UPDATE (issue #34).
 */
function comparableProperties(entity: any): string[] {
    const metadata = entity && typeof entity === 'object'
        ? MetadataStorage.get().getEntity(entity.constructor)
        : undefined;
    if (metadata) {
        return metadata.columns
            .filter((c: any) => !c.isShadowProperty)
            .map((c: any) => c.propertyName);
    }
    return Object.keys(entity ?? {});
}

/**
 * Compare two column values for equality the way the database would see them.
 *
 * Reference equality is wrong in both directions for column values: two Dates
 * holding the same instant are different references (a spurious UPDATE on
 * every save), and a nested object or array shared between the snapshot and
 * the entity is the *same* reference however much it was edited (a silently
 * lost write). Dates compare by instant and objects/arrays structurally
 * (issue #40).
 */
export function valuesEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;

    if (a instanceof Date || b instanceof Date) {
        return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
    }

    if (typeof a !== 'object' || typeof b !== 'object') return false;

    if (Array.isArray(a) || Array.isArray(b)) {
        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
        return a.every((item, i) => valuesEqual(item, b[i]));
    }

    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => Object.prototype.hasOwnProperty.call(b, k) && valuesEqual(a[k], b[k]));
}

/**
 * Deep-copy a value for the original-values snapshot.
 *
 * A shallow `{ ...entity }` shares nested objects and arrays with the entity,
 * so `user.config.theme = 'light'` mutates the "original" too and the edit can
 * never be detected. Only the shapes a column can hold are copied; anything
 * else (a class instance a converter will handle) is kept by reference.
 */
export function snapshotValue(value: any): any {
    if (value === null || typeof value !== 'object') return value;
    if (value instanceof Date) return new Date(value.getTime());
    if (Array.isArray(value)) return value.map(snapshotValue);
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
        const copy: Record<string, any> = {};
        for (const [k, v] of Object.entries(value)) copy[k] = snapshotValue(v);
        return copy;
    }
    return value;
}

/**
 * Take an original-values snapshot of an entity's comparable properties.
 */
export function snapshotEntity<T>(entity: T): Partial<T> {
    const snapshot: Record<string, any> = {};
    for (const key of comparableProperties(entity)) {
        snapshot[key] = snapshotValue((entity as any)[key]);
    }
    return snapshot as Partial<T>;
}

/**
 * Provides access to tracking information and operations for an entity
 */
export class EntityEntry<T> {
    private _state: EntityState;
    private _originalValues: Partial<T>;
    private _currentValues: T;
    private _hasBaseline: boolean;

    constructor(
        public readonly entity: T,
        state: EntityState,
        originalValues?: Partial<T>
    ) {
        this._state = state;
        this._currentValues = entity;
        this._hasBaseline = originalValues !== undefined;
        this._originalValues = originalValues || snapshotEntity(entity);
    }

    /**
     * Whether this entry has original values from a database read.
     *
     * False for an entity that entered tracking directly (`update()`,
     * `attach(e, Modified)`), where the snapshot was taken from the entity
     * itself and so cannot say which properties the caller changed. Such an
     * entry must write every column rather than none (issue #33).
     */
    get hasBaseline(): boolean {
        return this._hasBaseline;
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

        return this.getModifiedProperties().length > 0;
    }

    /**
     * Get the names of properties that have been modified
     */
    getModifiedProperties(): string[] {
        const modified: string[] = [];

        for (const key of comparableProperties(this._currentValues)) {
            const current = (this._currentValues as any)[key];
            const original = (this._originalValues as any)[key];
            if (!valuesEqual(current, original)) {
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
        this._originalValues = snapshotEntity(this._currentValues);
        this._hasBaseline = true;
        this._state = EntityState.Unchanged;
    }

    /**
     * Get a reference loader for explicit loading of a reference navigation property
     * @param navigationProperty Property selector for the navigation property
     * @example
     * const userEntry = db.entry(order);
     * await userEntry.reference(o => o.customer).load();
     */
    reference<TProperty>(navigationProperty: (entity: T) => TProperty): ReferenceLoader<T, TProperty> {
        return new ReferenceLoader(this.entity, navigationProperty);
    }

    /**
     * Get a collection loader for explicit loading of a collection navigation property
     * @param navigationProperty Property selector for the collection property
     * @example
     * const userEntry = db.entry(user);
     * await userEntry.collection(u => u.orders).load();
     */
    collection<TProperty>(navigationProperty: (entity: T) => TProperty[]): CollectionLoader<T, TProperty> {
        return new CollectionLoader(this.entity, navigationProperty);
    }
}

/**
 * Loader for explicit loading of reference navigation properties
 */
export class ReferenceLoader<TEntity, TProperty> {
    constructor(
        private entity: TEntity,
        private navigationProperty: (entity: TEntity) => TProperty
    ) {}

    /**
     * Load the related entity
     */
    async load(): Promise<void> {
        // Implementation will be added when we have DbContext reference
        throw new Error('Explicit loading requires DbContext reference - use db.entry(entity).reference().load()');
    }

    /**
     * Check if the related entity is loaded
     */
    isLoaded(): boolean {
        const value = this.navigationProperty(this.entity);
        return value !== null && value !== undefined;
    }
}

/**
 * Loader for explicit loading of collection navigation properties
 */
export class CollectionLoader<TEntity, TElement> {
    constructor(
        private entity: TEntity,
        private navigationProperty: (entity: TEntity) => TElement[]
    ) {}

    /**
     * Load the related collection
     */
    async load(): Promise<void> {
        // Implementation will be added when we have DbContext reference
        throw new Error('Explicit loading requires DbContext reference - use db.entry(entity).collection().load()');
    }

    /**
     * Check if the collection is loaded
     */
    isLoaded(): boolean {
        const value = this.navigationProperty(this.entity);
        return Array.isArray(value) && value.length >= 0;
    }

    /**
     * Query the collection (returns a query builder)
     */
    query(): any {
        throw new Error('Collection queries not yet implemented');
    }
}
