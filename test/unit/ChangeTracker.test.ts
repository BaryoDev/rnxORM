import "reflect-metadata";
import { ChangeTracker } from '../../src/core/ChangeTracker';
import { EntityState } from '../../src/core/EntityEntry';

class TestEntity {
    id!: number;
    name!: string;
    email!: string;
}

describe('ChangeTracker', () => {
    let tracker: ChangeTracker;

    beforeEach(() => {
        tracker = new ChangeTracker();
    });

    describe('Entity Tracking', () => {
        it('should track a new entity', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };
            const entry = tracker.track(entity, EntityState.Added);

            expect(entry).toBeDefined();
            expect(entry.state).toBe(EntityState.Added);
            expect(entry.entity).toBe(entity);
        });

        it('should check if entity is tracked', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };

            expect(tracker.isTracked(entity)).toBe(false);
            tracker.track(entity, EntityState.Added);
            expect(tracker.isTracked(entity)).toBe(true);
        });

        it('should get entry for tracked entity', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };
            tracker.track(entity, EntityState.Added);

            const entry = tracker.entry(entity);
            expect(entry).toBeDefined();
            expect(entry?.entity).toBe(entity);
        });

        it('should return undefined for untracked entity', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };
            const entry = tracker.entry(entity);
            expect(entry).toBeUndefined();
        });

        it('should update state when tracking existing entity', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };

            tracker.track(entity, EntityState.Added);
            expect(tracker.entry(entity)?.state).toBe(EntityState.Added);

            tracker.track(entity, EntityState.Modified);
            expect(tracker.entry(entity)?.state).toBe(EntityState.Modified);
        });

        it('should untrack an entity', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };
            tracker.track(entity, EntityState.Added);

            expect(tracker.isTracked(entity)).toBe(true);
            tracker.untrack(entity);
            expect(tracker.isTracked(entity)).toBe(false);
        });
    });

    describe('Multiple Entity Tracking', () => {
        it('should track multiple entities', () => {
            const entity1 = { id: 1, name: 'Test1', email: 'test1@test.com' };
            const entity2 = { id: 2, name: 'Test2', email: 'test2@test.com' };
            const entity3 = { id: 3, name: 'Test3', email: 'test3@test.com' };

            tracker.track(entity1, EntityState.Added);
            tracker.track(entity2, EntityState.Modified);
            tracker.track(entity3, EntityState.Deleted);

            expect(tracker.isTracked(entity1)).toBe(true);
            expect(tracker.isTracked(entity2)).toBe(true);
            expect(tracker.isTracked(entity3)).toBe(true);
        });

        it('should get all entries', () => {
            const entity1 = { id: 1, name: 'Test1', email: 'test1@test.com' };
            const entity2 = { id: 2, name: 'Test2', email: 'test2@test.com' };

            tracker.track(entity1, EntityState.Added);
            tracker.track(entity2, EntityState.Modified);

            const entries = Array.from(tracker.entries());
            expect(entries).toHaveLength(2);
        });

        it('should get entries by state', () => {
            const entity1 = { id: 1, name: 'Test1', email: 'test1@test.com' };
            const entity2 = { id: 2, name: 'Test2', email: 'test2@test.com' };
            const entity3 = { id: 3, name: 'Test3', email: 'test3@test.com' };

            tracker.track(entity1, EntityState.Added);
            tracker.track(entity2, EntityState.Added);
            tracker.track(entity3, EntityState.Modified);

            const addedEntries = tracker.getEntriesByState(EntityState.Added);
            const modifiedEntries = tracker.getEntriesByState(EntityState.Modified);

            expect(addedEntries).toHaveLength(2);
            expect(modifiedEntries).toHaveLength(1);
        });
    });

    describe('Change Detection', () => {
        it('should detect changes in tracked entities', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };
            tracker.track(entity, EntityState.Unchanged);

            expect(tracker.hasChanges()).toBe(false);

            entity.name = 'Modified';
            tracker.detectChanges();

            const entry = tracker.entry(entity);
            expect(entry?.state).toBe(EntityState.Modified);
        });

        it('should not change state if no modifications', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };
            tracker.track(entity, EntityState.Unchanged, { ...entity });

            tracker.detectChanges();

            const entry = tracker.entry(entity);
            expect(entry?.state).toBe(EntityState.Unchanged);
        });

        it('should get all changed entries', () => {
            const entity1 = { id: 1, name: 'Test1', email: 'test1@test.com' };
            const entity2 = { id: 2, name: 'Test2', email: 'test2@test.com' };
            const entity3 = { id: 3, name: 'Test3', email: 'test3@test.com' };

            tracker.track(entity1, EntityState.Added);
            tracker.track(entity2, EntityState.Modified);
            tracker.track(entity3, EntityState.Unchanged);

            const changedEntries = tracker.getChangedEntries();
            expect(changedEntries).toHaveLength(2);
        });

        it('should check if there are pending changes', () => {
            const entity1 = { id: 1, name: 'Test1', email: 'test1@test.com' };
            const entity2 = { id: 2, name: 'Test2', email: 'test2@test.com' };

            tracker.track(entity1, EntityState.Unchanged);
            expect(tracker.hasChanges()).toBe(false);

            tracker.track(entity2, EntityState.Added);
            expect(tracker.hasChanges()).toBe(true);
        });
    });

    describe('Auto Detect Changes', () => {
        it('should have auto detect changes enabled by default', () => {
            expect(tracker.autoDetectChangesEnabled).toBe(true);
        });

        it('should allow disabling auto detect changes', () => {
            tracker.autoDetectChangesEnabled = false;
            expect(tracker.autoDetectChangesEnabled).toBe(false);
        });
    });

    describe('Accept Changes', () => {
        it('should accept all changes', () => {
            const entity1 = { id: 1, name: 'Test1', email: 'test1@test.com' };
            const entity2 = { id: 2, name: 'Test2', email: 'test2@test.com' };
            const entity3 = { id: 3, name: 'Test3', email: 'test3@test.com' };

            tracker.track(entity1, EntityState.Added);
            tracker.track(entity2, EntityState.Modified);
            tracker.track(entity3, EntityState.Deleted);

            tracker.acceptAllChanges();

            expect(tracker.entry(entity1)?.state).toBe(EntityState.Unchanged);
            expect(tracker.entry(entity2)?.state).toBe(EntityState.Unchanged);
            expect(tracker.isTracked(entity3)).toBe(false); // Deleted entities are removed
        });

        it('should remove deleted entities after accepting changes', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };
            tracker.track(entity, EntityState.Deleted);

            expect(tracker.isTracked(entity)).toBe(true);
            tracker.acceptAllChanges();
            expect(tracker.isTracked(entity)).toBe(false);
        });
    });

    describe('Clear', () => {
        it('should clear all tracked entities', () => {
            const entity1 = { id: 1, name: 'Test1', email: 'test1@test.com' };
            const entity2 = { id: 2, name: 'Test2', email: 'test2@test.com' };

            tracker.track(entity1, EntityState.Added);
            tracker.track(entity2, EntityState.Modified);

            expect(tracker.hasChanges()).toBe(true);
            tracker.clear();
            expect(tracker.hasChanges()).toBe(false);
            expect(tracker.isTracked(entity1)).toBe(false);
            expect(tracker.isTracked(entity2)).toBe(false);
        });
    });

    describe('Statistics', () => {
        it('should provide statistics about tracked entities', () => {
            const entity1 = { id: 1, name: 'Test1', email: 'test1@test.com' };
            const entity2 = { id: 2, name: 'Test2', email: 'test2@test.com' };
            const entity3 = { id: 3, name: 'Test3', email: 'test3@test.com' };
            const entity4 = { id: 4, name: 'Test4', email: 'test4@test.com' };
            const entity5 = { id: 5, name: 'Test5', email: 'test5@test.com' };

            tracker.track(entity1, EntityState.Added);
            tracker.track(entity2, EntityState.Added);
            tracker.track(entity3, EntityState.Modified);
            tracker.track(entity4, EntityState.Deleted);
            tracker.track(entity5, EntityState.Unchanged);

            const stats = tracker.getStatistics();

            expect(stats.total).toBe(5);
            expect(stats.added).toBe(2);
            expect(stats.modified).toBe(1);
            expect(stats.deleted).toBe(1);
            expect(stats.unchanged).toBe(1);
        });

        it('should return zero statistics when no entities tracked', () => {
            const stats = tracker.getStatistics();

            expect(stats.total).toBe(0);
            expect(stats.added).toBe(0);
            expect(stats.modified).toBe(0);
            expect(stats.deleted).toBe(0);
            expect(stats.unchanged).toBe(0);
        });
    });

    describe('Edge Cases', () => {
        it('should handle tracking same entity multiple times', () => {
            const entity = { id: 1, name: 'Test', email: 'test@test.com' };

            tracker.track(entity, EntityState.Added);
            tracker.track(entity, EntityState.Modified);
            tracker.track(entity, EntityState.Unchanged);

            const entries = Array.from(tracker.entries());
            expect(entries).toHaveLength(1);
            expect(tracker.entry(entity)?.state).toBe(EntityState.Unchanged);
        });

        it('should handle entities with null/undefined properties', () => {
            const entity = { id: 1, name: null as any, email: undefined as any };

            const entry = tracker.track(entity, EntityState.Added);
            expect(entry).toBeDefined();
            expect(entry.entity.name).toBeNull();
            expect(entry.entity.email).toBeUndefined();
        });

        it('should handle empty objects', () => {
            const entity = {};

            const entry = tracker.track(entity, EntityState.Added);
            expect(entry).toBeDefined();
            expect(entry.entity).toBe(entity);
        });

        it('should handle entities with nested objects', () => {
            const entity = {
                id: 1,
                name: 'Test',
                address: {
                    street: '123 Main St',
                    city: 'Test City'
                }
            };

            const entry = tracker.track(entity, EntityState.Added);
            expect(entry).toBeDefined();
            expect(entry.entity.address.street).toBe('123 Main St');
        });
    });
});
