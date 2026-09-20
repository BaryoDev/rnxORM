import "reflect-metadata";
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { PostgreSQLProvider } from '../../src/providers/PostgreSQLProvider';
import { MSSQLProvider } from '../../src/providers/MSSQLProvider';
import { MariaDBProvider } from '../../src/providers/MariaDBProvider';

const cfg = { host: 'localhost', port: 1, user: 'u', password: 'p', database: 'd' };
const postgres = new PostgreSQLProvider(cfg);
const mssql = new MSSQLProvider(cfg);
const mariadb = new MariaDBProvider(cfg);

afterAll(async () => {
    await Promise.allSettled([postgres.disconnect(), mssql.disconnect(), mariadb.disconnect()]);
});

@Entity('np_products')
class NpProduct {
    @PrimaryKey()
    id!: number;

    /** No explicit type: this is the case that used to truncate. */
    @Column()
    price!: number;

    /** An author who wants whole numbers still says so. */
    @Column({ type: 'integer' })
    quantity!: number;
}

describe('numeric column defaults (issue #51)', () => {
    const columns = () => MetadataStorage.get().getEntity(NpProduct)!.columns;

    it('infers decimal for a number rather than integer', () => {
        const price = columns().find(c => c.propertyName === 'price')!;
        expect(price.type).toBe('decimal');
    });

    it('leaves an explicit integer alone', () => {
        const quantity = columns().find(c => c.propertyName === 'quantity')!;
        expect(quantity.type).toBe('integer');
    });

    it('keeps the primary key an integer so auto-increment still applies', () => {
        const id = columns().find(c => c.propertyName === 'id')!;
        expect(id.type).toBe('integer');
    });
});

describe('decimal precision reaches the DDL (issue #60)', () => {
    // A bare DECIMAL means (10,0) on MariaDB and MySQL, which drops the
    // fractional part entirely. That is the truncation this guards.
    it.each([
        ['postgres', postgres],
        ['mssql', mssql],
        ['mariadb', mariadb],
    ])('%s maps bare decimal to an explicit scale', (_name, provider) => {
        const mapped = provider.mapType('decimal');
        expect(mapped).toMatch(/^DECIMAL\(\d+,\s*\d+\)$/);
    });

    it('agrees on precision across dialects, so one entity means one shape', () => {
        const shapes = [postgres, mssql, mariadb].map(p => p.mapType('decimal'));
        expect(new Set(shapes).size).toBe(1);
    });

    it('still passes a parameterized decimal through untouched', () => {
        expect(postgres.mapType('decimal(8,4)')).toBe('DECIMAL(8,4)');
        expect(mssql.mapType('decimal(8,4)')).toBe('DECIMAL(8,4)');
        expect(mariadb.mapType('decimal(8,4)')).toBe('DECIMAL(8,4)');
    });
});
