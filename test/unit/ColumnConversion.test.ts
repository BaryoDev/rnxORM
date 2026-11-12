import "reflect-metadata";
import { convertColumnValue } from '../../src/core/ColumnConversion';
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

describe('convertColumnValue', () => {
    it('turns decimal and bigint driver strings into numbers for number columns', () => {
        expect(convertColumnValue({ type: 'decimal', designType: Number }, '19.99')).toBe(19.99);
        expect(convertColumnValue({ type: 'decimal(38,10)', designType: Number }, '0.1234567890')).toBe(0.123456789);
        expect(convertColumnValue({ type: 'integer', designType: Number }, '7')).toBe(7);
        expect(convertColumnValue({ type: 'float', designType: Number }, 1.5)).toBe(1.5);
        expect(convertColumnValue({ type: 'bigint', designType: Number }, '42')).toBe(42);
        expect(convertColumnValue({ type: 'bigint', designType: Number }, 42n)).toBe(42);
    });

    it('turns 0, 1 and text booleans into booleans', () => {
        for (const type of ['boolean', 'bit', 'tinyint(1)']) {
            expect(convertColumnValue({ type, designType: Boolean }, 1)).toBe(true);
            expect(convertColumnValue({ type, designType: Boolean }, 0)).toBe(false);
        }
        expect(convertColumnValue({ type: 'boolean' }, 't')).toBe(true);
        expect(convertColumnValue({ type: 'boolean' }, 'false')).toBe(false);
        expect(convertColumnValue({ type: 'boolean' }, true)).toBe(true);
    });

    it('returns a bigint for a bigint column unless the property is number or string', () => {
        expect(convertColumnValue({ type: 'bigint', designType: BigInt }, '9007199254740993')).toBe(9007199254740993n);
        expect(convertColumnValue({ type: 'bigint' }, '5')).toBe(5n);
        expect(convertColumnValue({ type: 'bigint' }, 5n)).toBe(5n);
        expect(convertColumnValue({ type: 'bigint', designType: String }, 9007199254740993n)).toBe('9007199254740993');
    });

    it('keeps the exact text of a decimal when the property is a string', () => {
        expect(convertColumnValue({ type: 'decimal(38,10)', designType: String }, '12345678901234567.0000000001'))
            .toBe('12345678901234567.0000000001');
    });

    it('leaves null, undefined, other types and unparseable values alone', () => {
        expect(convertColumnValue({ type: 'decimal' }, null)).toBeNull();
        expect(convertColumnValue({ type: 'decimal' }, undefined)).toBeUndefined();
        expect(convertColumnValue({ type: 'text' }, '12')).toBe('12');
        expect(convertColumnValue({ type: 'timestamp' }, 'x')).toBe('x');
        expect(convertColumnValue({ type: 'decimal', designType: Number }, 'abc')).toBe('abc');
    });
});

@Entity('conv_rows')
class ConvRow {
    @PrimaryKey()
    id!: number;

    @Column()
    price!: number;

    @Column()
    active!: boolean;

    @Column({ type: 'bigint' })
    big!: bigint;

    @Column({ type: 'bigint' })
    count!: number;
}

describe('row mapping applies the column conversion', () => {
    for (const dialect of ['postgresql', 'mariadb', 'mssql'] as const) {
        it(`${dialect}: driver strings, 0/1 and bigints reach the entity as declared`, async () => {
            const provider = new SqlCaptureProvider(dialect);
            const db = new DbContext(provider);
            provider.nextResult({
                rows: [{ id: 1, price: '19.99', active: 1, big: '9007199254740993', count: 12n }],
                rowCount: 1,
            });

            const [row] = await db.set(ConvRow).toList();

            expect(row.price).toBe(19.99);
            expect(row.active).toBe(true);
            expect(row.big).toBe(9007199254740993n);
            expect(row.count).toBe(12);
        });
    }
});
