import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { MockDatabaseProvider } from '../mocks/MockDatabaseProvider';

@Entity('ct_products')
class CtProduct {
    @PrimaryKey()
    id!: number;

    @Column()
    price!: number;

    @Column()
    version!: number;
}

/**
 * End-to-end optimistic concurrency against the mock provider.
 * Requires the mock's WHERE parser to handle multiple AND conditions
 * (UPDATE ... WHERE id = $n AND version = $m).
 */
describe('Optimistic concurrency (mock provider)', () => {
    let provider: MockDatabaseProvider;

    beforeAll(() => {
        new ModelBuilder().entity(CtProduct).property(p => p.version).isConcurrencyToken();
    });

    beforeEach(async () => {
        provider = new MockDatabaseProvider();
        const db = new DbContext(provider);
        await db.connect();
        await db.ensureCreated();

        const product = new CtProduct();
        product.id = 1;
        product.price = 10;
        product.version = 1;
        db.set(CtProduct).add(product);
        await db.saveChanges();
    });

    it('increments the token on a successful save', async () => {
        const db = new DbContext(provider);
        const product = (await db.set(CtProduct).find(1))!;
        expect(product.version).toBe(1);

        product.price = 20;
        await db.saveChanges();
        expect(product.version).toBe(2);

        // Verify the new token was persisted
        const db2 = new DbContext(provider);
        const reloaded = (await db2.set(CtProduct).find(1))!;
        expect(reloaded.version).toBe(2);
        expect(reloaded.price).toBe(20);
    });

    it('throws a concurrency violation when another context saved first', async () => {
        const dbA = new DbContext(provider);
        const dbB = new DbContext(provider);

        const productA = (await dbA.set(CtProduct).find(1))!;
        const productB = (await dbB.set(CtProduct).find(1))!;

        // B wins the race: stored version becomes 2
        productB.price = 15;
        await dbB.saveChanges();

        // A still expects version 1 -> UPDATE matches no rows -> violation
        productA.price = 20;
        await expect(dbA.saveChanges()).rejects.toThrow(/Concurrency violation/);

        // The stored row still holds B's update
        const dbC = new DbContext(provider);
        const reloaded = (await dbC.set(CtProduct).find(1))!;
        expect(reloaded.price).toBe(15);
        expect(reloaded.version).toBe(2);
    });
});
