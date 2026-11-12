import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { createTestProvider, getTestProviders } from '../test-config';

@Entity('row_types_probe')
class RowTypesProbe {
    @PrimaryKey()
    id!: number;

    @Column()
    price!: number;

    @Column()
    active!: boolean;

    @Column({ type: 'bigint' })
    big!: bigint;

    @Column({ type: 'bigint' })
    small!: number;

    @Column({ type: 'decimal(38,10)' })
    exact!: string;
}

// pg returns NUMERIC and BIGINT as strings, mariadb returns DECIMAL as a
// string, BIGINT as a BigInt and TINYINT(1) as 0 or 1. Each read below uses a
// fresh context, because a context that wrote the row hands back the tracked
// instance and would hide what the driver returned.
describe('rows come back in the declared property types', () => {
    const realProviders = getTestProviders().filter(p => p !== 'mock');
    // The mock provider has no SQL engine. Without a real database the suite
    // would hold no test, which Jest fails.
    if (realProviders.length === 0) it.skip('needs a real database (USE_REAL_DB=true)', () => undefined);

    for (const providerName of realProviders) {
        it(`${providerName} reads number, boolean, bigint and string columns as declared`, async () => {
            const writer = new DbContext(createTestProvider(providerName));
            await writer.connect();
            try {
                await writer.query('DROP TABLE IF EXISTS row_types_probe').catch(() => undefined);
                await writer.ensureCreated();

                const row = new RowTypesProbe();
                row.price = 19.99;
                row.active = true;
                row.big = 9007199254740993n;
                row.small = 12;
                row.exact = '1234.5';
                writer.set(RowTypesProbe).add(row);
                await writer.saveChanges();

                const reader = new DbContext(createTestProvider(providerName));
                await reader.connect();
                try {
                    const [read] = await reader.set(RowTypesProbe).toList();
                    expect(typeof read.price).toBe('number');
                    expect(read.price).toBeCloseTo(19.99, 2);
                    expect(read.active).toBe(true);
                    expect(read.big).toBe(9007199254740993n);
                    expect(read.small).toBe(12);
                    expect(typeof read.exact).toBe('string');
                    expect(Number(read.exact)).toBe(1234.5);
                } finally {
                    await reader.disconnect();
                }
            } finally {
                await writer.query('DROP TABLE IF EXISTS row_types_probe').catch(() => undefined);
                await writer.disconnect();
            }
        }, 30000);
    }
});
