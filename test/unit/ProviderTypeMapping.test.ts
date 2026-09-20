import { PostgreSQLProvider } from '../../src/providers/PostgreSQLProvider';
import { MSSQLProvider } from '../../src/providers/MSSQLProvider';
import { MariaDBProvider } from '../../src/providers/MariaDBProvider';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

// Providers are constructed lazily (no connection is opened until a query
// runs), so the pure SQL-dialect surface can be pinned without a database.
const config = { host: 'localhost', port: 1, user: 'u', password: 'p', database: 'd' };

const postgres = new PostgreSQLProvider(config);
const mssql = new MSSQLProvider(config);
const mariadb = new MariaDBProvider(config);

afterAll(async () => {
    await Promise.allSettled([postgres.disconnect(), mssql.disconnect(), mariadb.disconnect()]);
});

describe('type mapping (documented in README "Type Mapping")', () => {
    it.each([
        ['text', 'TEXT', 'NVARCHAR(MAX)', 'TEXT'],
        ['integer', 'INTEGER', 'INT', 'INT'],
        ['boolean', 'BOOLEAN', 'BIT', 'TINYINT(1)'],
        ['timestamp', 'TIMESTAMP', 'DATETIME2', 'DATETIME'],
        ['bigint', 'BIGINT', 'BIGINT', 'BIGINT'],
        ['date', 'DATE', 'DATE', 'DATE'],
    ])('maps %s per dialect', (tsType, pg, ms, maria) => {
        expect(postgres.mapType(tsType)).toBe(pg);
        expect(mssql.mapType(tsType)).toBe(ms);
        expect(mariadb.mapType(tsType)).toBe(maria);
    });

    // Exact, not toContain: 'NVARCHAR(50)' contains 'varchar(50)' once
    // lowercased, so a looser assertion passes whether or not SQL Server
    // applies its N prefix.
    it('passes explicit varchar(n) overrides through', () => {
        expect(postgres.mapType('varchar(50)')).toBe('VARCHAR(50)');
        expect(mariadb.mapType('varchar(50)')).toBe('VARCHAR(50)');
    });

    it('promotes varchar to NVARCHAR on SQL Server but leaves nvarchar alone', () => {
        expect(mssql.mapType('varchar(50)')).toBe('NVARCHAR(50)');
        expect(mssql.mapType('nvarchar(50)')).toBe('NVARCHAR(50)');
    });

    it('passes a parameterized decimal through where the dialect allows it', () => {
        expect(mssql.mapType('decimal(18,4)')).toBe('DECIMAL(18,4)');
        expect(mariadb.mapType('decimal(18,4)')).toBe('DECIMAL(18,4)');
        // PostgreSQL has no passthrough for decimal, so the table wins.
        expect(postgres.mapType('decimal')).toBe('DECIMAL');
    });

    it('uppercases a type it does not know', () => {
        expect(postgres.mapType('citext')).toBe('CITEXT');
        expect(mssql.mapType('citext')).toBe('CITEXT');
        expect(mariadb.mapType('citext')).toBe('CITEXT');
    });
});

describe('parameter placeholders and dialects', () => {
    it('generates provider-native placeholders', () => {
        expect(postgres.getParameterPlaceholder(1)).toBe('$1');
        expect(postgres.getParameterPlaceholder(3)).toBe('$3');
        expect(mssql.getParameterPlaceholder(1)).toBe('@p0');
        expect(mssql.getParameterPlaceholder(3)).toBe('@p2');
        expect(mariadb.getParameterPlaceholder(1)).toBe('?');
        expect(mariadb.getParameterPlaceholder(3)).toBe('?');
    });

    it('reports the dialect identifiers used for SQL generation', () => {
        expect(postgres.getDialect()).toBe('postgresql');
        expect(mssql.getDialect()).toBe('mssql');
        expect(mariadb.getDialect()).toBe('mariadb');
    });

    it('matches the SqlCaptureProvider used by the SQL-generation tests', () => {
        // The unit suites assert exact SQL through SqlCaptureProvider; this
        // pins its placeholder behavior to the real providers so those
        // assertions are valid evidence for real-database SQL.
        for (const index of [1, 2, 5]) {
            expect(new SqlCaptureProvider('postgresql').getParameterPlaceholder(index)).toBe(postgres.getParameterPlaceholder(index));
            expect(new SqlCaptureProvider('mssql').getParameterPlaceholder(index)).toBe(mssql.getParameterPlaceholder(index));
            expect(new SqlCaptureProvider('mariadb').getParameterPlaceholder(index)).toBe(mariadb.getParameterPlaceholder(index));
        }
    });
});
