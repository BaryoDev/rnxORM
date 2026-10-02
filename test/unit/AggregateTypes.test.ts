import "reflect-metadata";
import { DbContext, Entity, PrimaryKey, Column, ExactNumeric } from '../../src';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

/**
 * sum() and average() keep an exact-numeric result as a string when a JS
 * number cannot hold it (issue #39), but their signatures still promised a
 * number, so `total.toFixed(2)` type-checked and threw (issue #54).
 *
 * ts-jest type-checks this file, so each `@ts-expect-error` below is the
 * assertion: it fails to compile if the line under it stops being an error.
 */

@Entity('at_orders')
class AtOrder {
    @PrimaryKey()
    id!: number;

    @Column({ type: 'decimal' })
    amount!: number;
}

const TOO_WIDE = '12345678901234567.89';

function setup(row: Record<string, unknown>) {
    const provider = new SqlCaptureProvider('postgresql');
    provider.nextResult({ rows: [row], rowCount: 1 });
    return new DbContext(provider).set(AtOrder);
}

describe('aggregate return types (#54)', () => {
    it('DbSet.sum() is typed as the string it can return', async () => {
        const total = await setup({ total: TOO_WIDE }).sum(o => o.amount);

        // @ts-expect-error a string total has no toFixed()
        expect(() => total.toFixed(2)).toThrow(TypeError);
        expect(total).toBe(TOO_WIDE);
    });

    it('DbSet.average() is typed as the string it can return', async () => {
        const avg = await setup({ avg: TOO_WIDE }).average(o => o.amount);

        // @ts-expect-error a string average has no toFixed()
        expect(() => avg.toFixed(2)).toThrow(TypeError);
        expect(avg).toBe(TOO_WIDE);
    });

    it('QueryBuilder.sum() is typed as the string it can return', async () => {
        const total = await setup({ total: TOO_WIDE }).where('id', '>', 0).sum(o => o.amount);

        // @ts-expect-error a string total has no toFixed()
        expect(() => total.toFixed(2)).toThrow(TypeError);
        expect(total).toBe(TOO_WIDE);
    });

    it('QueryBuilder.average() is typed as the string it can return', async () => {
        const avg = await setup({ avg: TOO_WIDE }).where('id', '>', 0).average(o => o.amount);

        // @ts-expect-error a string average has no toFixed()
        expect(() => avg.toFixed(2)).toThrow(TypeError);
        expect(avg).toBe(TOO_WIDE);
    });

    it('narrows to a number when the value fits one', async () => {
        const total: ExactNumeric = await setup({ total: '1250.50' }).sum(o => o.amount);

        expect(typeof total === 'number' ? total.toFixed(2) : total).toBe('1250.50');
    });
});
