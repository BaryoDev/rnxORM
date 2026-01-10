import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { createTestProvider } from '../test-config';

@Entity('test_users')
class TestUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

describe('DbContext', () => {
    let db: DbContext;

    beforeEach(() => {
        const provider = createTestProvider('mock');
        db = new DbContext(provider);
    });

    it('should be defined', () => {
        expect(db).toBeDefined();
    });

    it('should create a DbSet for an entity', () => {
        const users = db.set(TestUser);
        expect(users).toBeDefined();
    });

    it('should have a change tracker', () => {
        expect(db.changeTracker).toBeDefined();
    });

    it('should track change tracker statistics', () => {
        const stats = db.changeTracker.getStatistics();
        expect(stats.total).toBe(0);
        expect(stats.added).toBe(0);
        expect(stats.modified).toBe(0);
        expect(stats.deleted).toBe(0);
        expect(stats.unchanged).toBe(0);
    });
});
