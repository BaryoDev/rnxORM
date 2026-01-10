import "reflect-metadata";
import { EntityEntry, EntityState, ReferenceLoader, CollectionLoader } from '../../src/core/EntityEntry';

class User {
    id!: number;
    name!: string;
    email!: string;
    age!: number;
    posts!: Post[];
    profile!: Profile;
}

class Post {
    id!: number;
    title!: string;
}

class Profile {
    bio!: string;
}

describe('EntityEntry', () => {
    describe('Basic Functionality', () => {
        it('should create entry with entity and state', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged);

            expect(entry.entity).toBe(user);
            expect(entry.state).toBe(EntityState.Unchanged);
        });

        it('should create entry with original values', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const originalValues = { id: 1, name: 'John', email: 'john@test.com', age: 20 };
            const entry = new EntityEntry(user, EntityState.Modified, originalValues);

            expect(entry.originalValues.age).toBe(20);
            expect(entry.currentValues.age).toBe(25);
        });

        it('should copy entity as original values if not provided', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged);

            expect(entry.originalValues).toEqual(user);
            expect(entry.originalValues).not.toBe(user); // Should be a copy
        });
    });

    describe('State Management', () => {
        it('should get state', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Added);

            expect(entry.state).toBe(EntityState.Added);
        });

        it('should set state', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Added);

            entry.state = EntityState.Modified;
            expect(entry.state).toBe(EntityState.Modified);
        });

        it('should support all entity states', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };

            const addedEntry = new EntityEntry(user, EntityState.Added);
            expect(addedEntry.state).toBe(EntityState.Added);

            const modifiedEntry = new EntityEntry(user, EntityState.Modified);
            expect(modifiedEntry.state).toBe(EntityState.Modified);

            const deletedEntry = new EntityEntry(user, EntityState.Deleted);
            expect(deletedEntry.state).toBe(EntityState.Deleted);

            const unchangedEntry = new EntityEntry(user, EntityState.Unchanged);
            expect(unchangedEntry.state).toBe(EntityState.Unchanged);

            const detachedEntry = new EntityEntry(user, EntityState.Detached);
            expect(detachedEntry.state).toBe(EntityState.Detached);
        });
    });

    describe('Original and Current Values', () => {
        it('should get original values as copy', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged);

            const originalValues = entry.originalValues;
            originalValues.name = 'Modified';

            expect(entry.originalValues.name).toBe('John'); // Should not be affected
        });

        it('should get current values', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged);

            expect(entry.currentValues).toBe(user);
        });

        it('should track changes to current values', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged);

            user.name = 'Jane';
            expect(entry.currentValues.name).toBe('Jane');
        });
    });

    describe('Change Detection', () => {
        it('should detect if entity is modified by state', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Modified);

            expect(entry.isModified).toBe(true);
        });

        it('should detect if entity is modified by property changes', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged, { ...user });

            user.name = 'Jane';
            expect(entry.isModified).toBe(true);
        });

        it('should return false if no modifications', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged, { ...user });

            expect(entry.isModified).toBe(false);
        });

        it('should get modified property names', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged, { ...user });

            user.name = 'Jane';
            user.age = 30;

            const modifiedProps = entry.getModifiedProperties();
            expect(modifiedProps).toContain('name');
            expect(modifiedProps).toContain('age');
            expect(modifiedProps).not.toContain('email');
            expect(modifiedProps).not.toContain('id');
        });

        it('should return empty array if no properties modified', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged, { ...user });

            const modifiedProps = entry.getModifiedProperties();
            expect(modifiedProps).toEqual([]);
        });
    });

    describe('Reload', () => {
        it('should reset entity to original values', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Unchanged, { ...user });

            user.name = 'Jane';
            user.age = 30;

            entry.reload();

            expect(user.name).toBe('John');
            expect(user.age).toBe(25);
        });

        it('should set state to Unchanged after reload', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Modified, { ...user });

            entry.reload();

            expect(entry.state).toBe(EntityState.Unchanged);
        });
    });

    describe('Accept Changes', () => {
        it('should accept current values as original', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Modified, { id: 1, name: 'Old', email: 'old@test.com', age: 20 });

            entry.acceptChanges();

            expect(entry.originalValues.name).toBe('John');
            expect(entry.originalValues.age).toBe(25);
        });

        it('should set state to Unchanged', () => {
            const user = { id: 1, name: 'John', email: 'john@test.com', age: 25 };
            const entry = new EntityEntry(user, EntityState.Modified);

            entry.acceptChanges();

            expect(entry.state).toBe(EntityState.Unchanged);
        });
    });

    describe('Navigation Properties - Reference', () => {
        it('should create reference loader', () => {
            const user = new User();
            user.id = 1;
            user.name = 'John';

            const entry = new EntityEntry(user, EntityState.Unchanged);
            const refLoader = entry.reference(u => u.profile);

            expect(refLoader).toBeInstanceOf(ReferenceLoader);
        });

        it('should check if reference is loaded', () => {
            const user = new User();
            user.id = 1;
            user.name = 'John';
            user.profile = { bio: 'Test bio' };

            const entry = new EntityEntry(user, EntityState.Unchanged);
            const refLoader = entry.reference(u => u.profile);

            expect(refLoader.isLoaded()).toBe(true);
        });

        it('should return false if reference is not loaded', () => {
            const user = new User();
            user.id = 1;
            user.name = 'John';
            user.profile = null as any;

            const entry = new EntityEntry(user, EntityState.Unchanged);
            const refLoader = entry.reference(u => u.profile);

            expect(refLoader.isLoaded()).toBe(false);
        });

        it('should throw error when trying to load without context', async () => {
            const user = new User();
            const entry = new EntityEntry(user, EntityState.Unchanged);
            const refLoader = entry.reference(u => u.profile);

            await expect(refLoader.load()).rejects.toThrow('Explicit loading requires DbContext reference');
        });
    });

    describe('Navigation Properties - Collection', () => {
        it('should create collection loader', () => {
            const user = new User();
            user.id = 1;
            user.name = 'John';

            const entry = new EntityEntry(user, EntityState.Unchanged);
            const collLoader = entry.collection(u => u.posts);

            expect(collLoader).toBeInstanceOf(CollectionLoader);
        });

        it('should check if collection is loaded', () => {
            const user = new User();
            user.id = 1;
            user.name = 'John';
            user.posts = [{ id: 1, title: 'Post 1' }];

            const entry = new EntityEntry(user, EntityState.Unchanged);
            const collLoader = entry.collection(u => u.posts);

            expect(collLoader.isLoaded()).toBe(true);
        });

        it('should check if empty collection is loaded', () => {
            const user = new User();
            user.id = 1;
            user.name = 'John';
            user.posts = [];

            const entry = new EntityEntry(user, EntityState.Unchanged);
            const collLoader = entry.collection(u => u.posts);

            expect(collLoader.isLoaded()).toBe(true);
        });

        it('should throw error when trying to load without context', async () => {
            const user = new User();
            const entry = new EntityEntry(user, EntityState.Unchanged);
            const collLoader = entry.collection(u => u.posts);

            await expect(collLoader.load()).rejects.toThrow('Explicit loading requires DbContext reference');
        });

        it('should throw error when trying to query collection', () => {
            const user = new User();
            const entry = new EntityEntry(user, EntityState.Unchanged);
            const collLoader = entry.collection(u => u.posts);

            expect(() => collLoader.query()).toThrow('Collection queries not yet implemented');
        });
    });

    describe('Edge Cases', () => {
        it('should handle entity with null values', () => {
            const user = { id: 1, name: null as any, email: null as any, age: null as any };
            const entry = new EntityEntry(user, EntityState.Unchanged);

            expect(entry.currentValues.name).toBeNull();
            expect(entry.isModified).toBe(false);
        });

        it('should handle entity with undefined values', () => {
            const user = { id: 1, name: undefined as any, email: undefined as any, age: undefined as any };
            const entry = new EntityEntry(user, EntityState.Unchanged);

            expect(entry.currentValues.name).toBeUndefined();
        });

        it('should handle entity with complex nested objects', () => {
            const user = {
                id: 1,
                name: 'John',
                email: 'john@test.com',
                age: 25,
                address: {
                    street: '123 Main',
                    city: 'Test City',
                    location: {
                        lat: 40.7128,
                        lng: -74.0060
                    }
                }
            };

            const entry = new EntityEntry(user, EntityState.Unchanged);
            expect(entry.currentValues.address.location.lat).toBe(40.7128);
        });

        it('should handle entity with arrays', () => {
            const user = {
                id: 1,
                name: 'John',
                email: 'john@test.com',
                age: 25,
                tags: ['tag1', 'tag2', 'tag3']
            };

            const entry = new EntityEntry(user, EntityState.Unchanged);
            expect(entry.currentValues.tags).toHaveLength(3);
        });

        it('should detect modification when array reference changes', () => {
            const user = {
                id: 1,
                name: 'John',
                email: 'john@test.com',
                age: 25,
                tags: ['tag1', 'tag2']
            };

            const entry = new EntityEntry(user, EntityState.Unchanged, { ...user });

            user.tags = ['tag1', 'tag2', 'tag3'];

            expect(entry.isModified).toBe(true);
            expect(entry.getModifiedProperties()).toContain('tags');
        });
    });
});
