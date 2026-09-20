import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { createTestProvider, getTestProviders } from '../test-config';

@Entity('money_probe')
class MoneyProbe {
    @PrimaryKey()
    id!: number;

    // No explicit type: the case issue #51 was about.
    @Column()
    price!: number;
}

// Against MariaDB, `INSERT INTO t(price INT) VALUES (19.99)` stores 20.
// This is the end-to-end proof that an inferred numeric column no longer
// does that (issues #51 and #60).
describe('a bare number column keeps its cents', () => {
    for (const providerName of getTestProviders()) {
        it(`${providerName} round-trips 19.99`, async () => {
            const provider = createTestProvider(providerName);
            const db = new DbContext(provider);
            await db.connect();
            try {
                await db.query('DROP TABLE IF EXISTS money_probe').catch(() => undefined);
                await db.ensureCreated();

                const row = new MoneyProbe();
                row.price = 19.99;
                db.set(MoneyProbe).add(row);
                await db.saveChanges();

                const read = await db.set(MoneyProbe).toList();
                console.log(`${providerName}: stored 19.99 -> read back ${read[0].price}`);
                expect(Number(read[0].price)).toBeCloseTo(19.99, 2);
            } finally {
                await db.query('DROP TABLE IF EXISTS money_probe').catch(() => undefined);
                await db.disconnect();
            }
        }, 30000);
    }
});
