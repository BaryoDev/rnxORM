import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { Pool } from 'pg';

// Define mocks outside to access them
const mClient = {
    connect: jest.fn(),
    query: jest.fn(),
    release: jest.fn(),
    end: jest.fn(),
};
const mPool = {
    connect: jest.fn(() => Promise.resolve(mClient)),
    query: jest.fn(),
    end: jest.fn(),
    on: jest.fn(),
};

jest.mock('pg', () => {
    return {
        Client: jest.fn(() => mClient),
        Pool: jest.fn(() => mPool),
    };
});

@Entity('integration_users')
class User {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    age!: number;
}

describe('User Integration Flow', () => {
    let db: DbContext;

    beforeAll(async () => {
        db = new DbContext({
            host: 'localhost',
            port: 5432,
            user: 'postgres',
            password: 'password',
            database: 'mydb',
        });
        await db.connect();
        // Mock ensureCreated query
        // ensureCreated uses db.query which uses pool.query or client.query
        // Since we connected, it uses client.query
        mClient.query.mockResolvedValue({ rows: [], rowCount: 0 });
        await db.ensureCreated();
    });

    afterAll(async () => {
        await db.disconnect();
    });

    it('should add, query, update, and remove a user', async () => {
        const users = db.set(User);

        // Add
        mClient.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // Insert
        const newUser = new User();
        newUser.name = 'Integration Test User';
        newUser.age = 25;
        await users.add(newUser);
        expect(mClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO'), expect.any(Array));

        // Query
        mClient.query.mockResolvedValueOnce({ rows: [{ id: 1, name: 'Integration Test User', age: 25 }] }); // Select
        const allUsers = await users.toList();
        expect(allUsers).toHaveLength(1);
        expect(allUsers[0].name).toBe('Integration Test User');

        // Update
        mClient.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // Update
        const userToUpdate = allUsers[0];
        userToUpdate.age = 26;
        await users.update(userToUpdate);
        expect(mClient.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE'), expect.any(Array));

        // Remove
        mClient.query.mockResolvedValueOnce({ rows: [], rowCount: 1 }); // Delete
        await users.remove(userToUpdate);
        expect(mClient.query).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM'), expect.any(Array));
    });
});
