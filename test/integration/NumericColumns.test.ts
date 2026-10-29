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

@Entity('exact_sum_probe')
class ExactSumProbe {
    @PrimaryKey()
    id!: number;

    @Column()
    grp!: string;

    @Column({ type: 'decimal(38,10)' })
    amount!: number;

    @Column({ type: 'integer' })
    qty!: number;
}

async function withProbeTable(providerName: ReturnType<typeof getTestProviders>[number], body: (db: DbContext) => Promise<void>): Promise<void> {
    const db = new DbContext(createTestProvider(providerName));
    await db.connect();
    try {
        await db.query('DROP TABLE IF EXISTS exact_sum_probe').catch(() => undefined);
        await db.ensureCreated();
        await body(db);
    } finally {
        await db.query('DROP TABLE IF EXISTS exact_sum_probe').catch(() => undefined);
        await db.disconnect();
    }
}

// Tedious parses DECIMAL results into a double. SUM over a DECIMAL(38,10)
// has to come back as the database's own digits (issue #54).
// The mock provider has no SQL engine, so these run against real databases only.
describe('SUM over a DECIMAL(38,10) column is exact', () => {
    for (const providerName of getTestProviders().filter(p => p !== 'mock')) {
        // SQLite stores DECIMAL as a double, so 17-digit sums are not exact there.
        const exactDecimals = providerName === 'sqlite' ? it.skip : it;
        exactDecimals(`${providerName} returns the exact digits`, () =>
            withProbeTable(providerName, async (db) => {
                // Literals go straight to the database so no JS number parsing is involved.
                await db.query(
                    `INSERT INTO exact_sum_probe (grp, amount, qty) VALUES ('a', 12345678901234567.0000000001, 1), ('a', 0.1234567890, 2), ('b', 1, 4)`
                );

                const total = await db.set(ExactSumProbe).sum(r => r.amount);
                console.log(`${providerName}: sum(amount) = ${JSON.stringify(total)}`);
                expect(total).toBe('12345678901234568.1234567891');

                const grouped = await db
                    .set(ExactSumProbe)
                    .groupBy(r => r.grp)
                    .select(g => ({ grp: g.key, total: g.sum(r => r.amount) }))
                    .toList();
                const a = grouped.find((r: any) => r.grp === 'a') as any;
                console.log(`${providerName}: grouped sum a = ${JSON.stringify(a.total)}`);
                expect(String(a.total)).toBe('12345678901234567.1234567891');
            }), 30000);

        it(`${providerName} compares a grouped sum in HAVING as a number, not text`, () =>
            withProbeTable(providerName, async (db) => {
                // As text, '9.5' > '10' would be true and 'big' would be missing.
                await db.query(
                    `INSERT INTO exact_sum_probe (grp, amount, qty) VALUES ('small', 9.5, 1), ('big', 100, 1)`
                );
                const rows = await db
                    .set(ExactSumProbe)
                    .groupBy(r => r.grp)
                    .having('sum(amount)', '>', 10)
                    .select(g => ({ grp: g.key, total: g.sum(r => r.amount) }))
                    .toList();
                expect(rows.map((r: any) => r.grp)).toEqual(['big']);
            }), 30000);

        it(`${providerName} orders a grouped decimal sum by its alias as a number`, () =>
            withProbeTable(providerName, async (db) => {
                // As text, '9.5' sorts after '10' descending, so 'nine' would come last.
                await db.query(
                    `INSERT INTO exact_sum_probe (grp, amount, qty) VALUES ('nine', 9.5, 1), ('ten', 10, 1), ('hundred', 100, 1)`
                );
                const rows = await db
                    .set(ExactSumProbe)
                    .groupBy(r => r.grp)
                    .orderByDescending('total')
                    .select(g => ({ grp: g.key, total: g.sum(r => r.amount) }))
                    .toList();
                expect(rows.map((r: any) => r.grp)).toEqual(['hundred', 'ten', 'nine']);
            }), 30000);

        it(`${providerName} average over an integer column`, () =>
            withProbeTable(providerName, async (db) => {
                await db.query(`INSERT INTO exact_sum_probe (grp, amount, qty) VALUES ('a', 1, 1), ('a', 1, 2)`);
                const avg = await db.set(ExactSumProbe).average(r => r.qty);
                console.log(`${providerName}: avg(qty of 1,2) = ${JSON.stringify(avg)}`);
                expect(Number(avg)).toBe(1.5);
            }), 30000);
    }
});
