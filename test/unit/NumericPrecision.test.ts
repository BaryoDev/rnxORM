import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

/**
 * The three drivers return three different JS types for the same declared
 * column, and the ORM converted several of them lossily: Number() on a BigInt
 * insertId and parseFloat on DECIMAL aggregates both silently round past
 * 2^53 (issue #39).
 */

@Entity('np_rows')
class NpRow {
    @PrimaryKey()
    id!: number;

    @Column({ type: 'decimal' })
    amount!: number;
}

function makeDb() {
    const provider = new SqlCaptureProvider('postgresql');
    return { db: new DbContext(provider), provider };
}

describe('generated keys beyond 2^53 (#39)', () => {
    it('does not truncate a BigInt generated key', async () => {
        const { db, provider } = makeDb();
        // 2^53 + 1: the smallest integer a double cannot represent exactly.
        provider.nextResult({ rows: [{ id: 9007199254740993n }], rowCount: 1 });

        const row = new NpRow();
        row.amount = 1;
        db.set(NpRow).add(row);
        await db.saveChanges();

        expect(String(row.id)).toBe('9007199254740993');
    });

    it('does not truncate a string generated key', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: '9007199254740993' }], rowCount: 1 });

        const row = new NpRow();
        row.amount = 1;
        db.set(NpRow).add(row);
        await db.saveChanges();

        expect(String(row.id)).toBe('9007199254740993');
    });

    it('still returns an ordinary key as a number', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 42 }], rowCount: 1 });

        const row = new NpRow();
        row.amount = 1;
        db.set(NpRow).add(row);
        await db.saveChanges();

        expect(row.id).toBe(42);
    });
});

describe('aggregates on exact-numeric columns (#39)', () => {
    it('does not round a DECIMAL sum that exceeds double precision', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ total: '12345678901234567.89' }], rowCount: 1 });

        const total = await db.set(NpRow).sum(r => r.amount);

        // parseFloat gave 12345678901234568, losing the cents entirely.
        expect(String(total)).toBe('12345678901234567.89');
    });

    it('returns an ordinary sum as a number', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ total: '150.25' }], rowCount: 1 });

        expect(await db.set(NpRow).sum(r => r.amount)).toBe(150.25);
    });

    it('returns 0 for a sum over no rows', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ total: null }], rowCount: 1 });

        expect(await db.set(NpRow).sum(r => r.amount)).toBe(0);
    });

    it('does not round a DECIMAL average', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ avg: '12345678901234567.89' }], rowCount: 1 });

        expect(String(await db.set(NpRow).average(r => r.amount))).toBe('12345678901234567.89');
    });
});

describe('count() guards (#39)', () => {
    it('returns 0 when the result set is empty rather than NaN', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 0 });

        expect(await db.set(NpRow).count()).toBe(0);
    });

    it('parses a decimal count with an explicit radix', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '08' }], rowCount: 1 });

        expect(await db.set(NpRow).count()).toBe(8);
    });

    it('still counts normally', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ count: '5' }], rowCount: 1 });

        expect(await db.set(NpRow).count()).toBe(5);
    });
});
