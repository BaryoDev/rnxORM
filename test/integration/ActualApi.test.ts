import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { createTestProvider, getTestProviders } from '../test-config';

@Entity('api_test_users')
class ApiTestUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    email!: string;

    @Column()
    age!: number;
}

describe('Actual API Integration Tests', () => {
    const providers = getTestProviders();

    providers.forEach(providerName => {
        describe(`${providerName} - Basic CRUD`, () => {
            let db: DbContext;

            beforeAll(async () => {
                const provider = createTestProvider(providerName);
                db = new DbContext(provider);
                await db.connect();
                await db.ensureCreated();
            });

            afterAll(async () => {
                try {
                    await db.query(`DROP TABLE IF EXISTS api_test_users`);
                } catch (e) {
                    // Ignore
                }
                await db.disconnect();
            });

            beforeEach(async () => {
                await db.query(`DELETE FROM api_test_users`);
            });

            it('should insert and retrieve a single entity', async () => {
                const users = db.set(ApiTestUser);

                const user = new ApiTestUser();
                user.id = 1;
                user.name = 'John Doe';
                user.email = 'john@test.com';
                user.age = 30;

                users.add(user);
                const changes = await db.saveChanges();

                expect(changes).toBeGreaterThan(0);

                // Retrieve using find
                const found = await users.find(1);
                expect(found).not.toBeNull();
                expect(found?.name).toBe('John Doe');
            });

            it('should handle WHERE queries', async () => {
                const users = db.set(ApiTestUser);

                // Insert test data
                for (let i = 1; i <= 5; i++) {
                    const user = new ApiTestUser();
                    user.id = i;
                    user.name = `User${i}`;
                    user.email = `user${i}@test.com`;
                    user.age = 20 + i;

                    users.add(user);
                }
                await db.saveChanges();

                // Query with WHERE
                const result = await users.where("age", ">", 23).toList();

                expect(result.length).toBeGreaterThan(0);
                result.forEach(u => expect(u.age).toBeGreaterThan(23));
            });

            it('should handle ORDER BY', async () => {
                const users = db.set(ApiTestUser);

                for (let i = 1; i <= 5; i++) {
                    const user = new ApiTestUser();
                    user.id = i;
                    user.name = `User${i}`;
                    user.email = `user${i}@test.com`;
                    user.age = 25 - i; // Reverse order: 24, 23, 22, 21, 20

                    users.add(user);
                }
                await db.saveChanges();

                const ordered = await users.orderBy("age").toList();

                expect(ordered[0].age).toBe(20);
                expect(ordered[4].age).toBe(24);
            });

            it('should handle SKIP and TAKE pagination', async () => {
                const users = db.set(ApiTestUser);

                for (let i = 1; i <= 10; i++) {
                    const user = new ApiTestUser();
                    user.id = i;
                    user.name = `User${i}`;
                    user.email = `user${i}@test.com`;
                    user.age = 20 + i;

                    users.add(user);
                }
                await db.saveChanges();

                const page2 = await users.skip(3).take(3).toList();

                expect(page2).toHaveLength(3);
            });

            it('should update entities', async () => {
                const users = db.set(ApiTestUser);

                const user = new ApiTestUser();
                user.id = 1;
                user.name = 'Original';
                user.email = 'original@test.com';
                user.age = 30;

                users.add(user);
                await db.saveChanges();

                // Load and modify
                const loaded = await users.find(1);
                if (loaded) {
                    loaded.name = 'Modified';
                    users.update(loaded);
                    await db.saveChanges();
                }

                // Verify
                const updated = await users.find(1);
                expect(updated?.name).toBe('Modified');
            });

            it('should delete entities', async () => {
                const users = db.set(ApiTestUser);

                const user = new ApiTestUser();
                user.id = 1;
                user.name = 'ToDelete';
                user.email = 'delete@test.com';
                user.age = 30;

                users.add(user);
                await db.saveChanges();

                const loaded = await users.find(1);
                if (loaded) {
                    users.remove(loaded);
                    await db.saveChanges();
                }

                const deleted = await users.find(1);
                expect(deleted).toBeNull();
            });

            it('should handle addRange bulk insert', async () => {
                const users = db.set(ApiTestUser);

                const batch: ApiTestUser[] = [];
                for (let i = 1; i <= 100; i++) {
                    const user = new ApiTestUser();
                    user.id = i;
                    user.name = `User${i}`;
                    user.email = `user${i}@test.com`;
                    user.age = 20 + (i % 50);

                    batch.push(user);
                }

                users.addRange(batch);
                await db.saveChanges();

                const count = await users.count();
                expect(count).toBe(100);
            });

            it('should handle SQL injection attempts safely', async () => {
                const users = db.set(ApiTestUser);

                const user = new ApiTestUser();
                user.id = 1;
                user.name = "'; DROP TABLE api_test_users; --";
                user.email = "malicious@test.com";
                user.age = 30;

                users.add(user);
                await db.saveChanges();

                // Table should still exist
                const all = await users.toList();
                expect(all.length).toBe(1);

                // Data should be stored literally
                expect(all[0].name).toBe("'; DROP TABLE api_test_users; --");
            });

            it('should handle special characters in strings', async () => {
                const users = db.set(ApiTestUser);

                const user = new ApiTestUser();
                user.id = 1;
                user.name = "O'Brien";
                user.email = 'test@test.com';
                user.age = 30;

                users.add(user);
                await db.saveChanges();

                const found = await users.find(1);
                expect(found?.name).toBe("O'Brien");
            });

            it('should handle unicode and emojis', async () => {
                const users = db.set(ApiTestUser);

                const user = new ApiTestUser();
                user.id = 1;
                user.name = '你好世界 😀';
                user.email = 'unicode@test.com';
                user.age = 25;

                users.add(user);
                await db.saveChanges();

                const found = await users.find(1);
                expect(found?.name).toBe('你好世界 😀');
            });

            it('should handle very long strings', async () => {
                const users = db.set(ApiTestUser);

                const longString = 'A'.repeat(5000);

                const user = new ApiTestUser();
                user.id = 1;
                user.name = longString;
                user.email = 'long@test.com';
                user.age = 30;

                users.add(user);
                await db.saveChanges();

                const found = await users.find(1);
                expect(found?.name.length).toBe(5000);
            });

            it('should handle zero and negative numbers', async () => {
                const users = db.set(ApiTestUser);

                const user1 = new ApiTestUser();
                user1.id = 1;
                user1.name = 'Zero';
                user1.email = 'zero@test.com';
                user1.age = 0;

                const user2 = new ApiTestUser();
                user2.id = 2;
                user2.name = 'Negative';
                user2.email = 'neg@test.com';
                user2.age = -5;

                users.addRange([user1, user2]);
                await db.saveChanges();

                const zero = await users.find(1);
                const neg = await users.find(2);

                expect(zero?.age).toBe(0);
                expect(neg?.age).toBe(-5);
            });

            it('should handle empty result sets', async () => {
                const users = db.set(ApiTestUser);

                const result = await users.where("age", ">", 1000).toList();
                expect(result).toEqual([]);
                expect(result).toHaveLength(0);
            });

            it('should handle duplicate primary key gracefully', async () => {
                const users = db.set(ApiTestUser);

                const user1 = new ApiTestUser();
                user1.id = 1;
                user1.name = 'First';
                user1.email = 'first@test.com';
                user1.age = 30;

                users.add(user1);
                await db.saveChanges();

                // Try to add with same ID
                const user2 = new ApiTestUser();
                user2.id = 1;
                user2.name = 'Second';
                user2.email = 'second@test.com';
                user2.age = 25;

                users.add(user2);

                await expect(db.saveChanges()).rejects.toThrow();
            });

            it('should handle rapid consecutive queries', async () => {
                const users = db.set(ApiTestUser);

                // Insert test data
                for (let i = 1; i <= 50; i++) {
                    const user = new ApiTestUser();
                    user.id = i;
                    user.name = `User${i}`;
                    user.email = `user${i}@test.com`;
                    user.age = 20 + i;

                    users.add(user);
                }
                await db.saveChanges();

                // Fire multiple queries simultaneously
                const promises = [];
                for (let i = 1; i <= 10; i++) {
                    promises.push(users.find(i));
                }

                const results = await Promise.all(promises);

                expect(results).toHaveLength(10);
                results.forEach((r, idx) => {
                    expect(r).not.toBeNull();
                    expect(r?.id).toBe(idx + 1);
                });
            });
        });
    });
});
