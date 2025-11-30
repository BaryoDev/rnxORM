import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

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
        db = new DbContext({
            host: 'localhost',
            port: 5432,
            user: 'test',
            password: 'test',
            database: 'test_db',
        });
    });

    it('should be defined', () => {
        expect(db).toBeDefined();
    });

    it('should create a DbSet for an entity', () => {
        const users = db.set(TestUser);
        expect(users).toBeDefined();
    });
});
