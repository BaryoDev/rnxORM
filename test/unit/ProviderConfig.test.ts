import "reflect-metadata";
import { DatabaseConfig } from '../../src/providers/IDatabaseProvider';
import { MSSQLProvider } from '../../src/providers/MSSQLProvider';
import { PostgreSQLProvider } from '../../src/providers/PostgreSQLProvider';
import { MariaDBProvider } from '../../src/providers/MariaDBProvider';

/**
 * DatabaseConfig had no TLS field and no driver-options passthrough, and all
 * three providers copied fields one by one, so a caller could not enable TLS
 * at all. MSSQL actively disabled it and trusted any certificate presented
 * (issue #43).
 */

const base: DatabaseConfig = {
    host: 'db.example.com',
    port: 1433,
    user: 'sa',
    password: 'secret',
    database: 'app',
};

/**
 * Providers build a real driver pool in their constructor, which holds a timer
 * and keeps the jest worker alive. Every provider made here is registered and
 * torn down afterwards.
 */
const created: any[] = [];

function track<T>(provider: T): T {
    created.push(provider);
    return provider;
}

afterAll(async () => {
    for (const provider of created) {
        try {
            await provider.pool?.end?.();
        } catch {
            // The pool never connected; nothing to close.
        }
    }
});

/** The driver config a provider built, without connecting to anything. */
function driverConfig(provider: any): any {
    return provider.config ?? provider.poolConfig;
}

describe('MSSQL TLS defaults (#43)', () => {
    it('encrypts by default and does not trust any certificate', () => {
        const provider = track(new MSSQLProvider({ ...base }));
        const config = driverConfig(provider);

        expect(config.options.encrypt).toBe(true);
        expect(config.options.trustServerCertificate).toBe(false);
    });

    it('allows local development to opt out', () => {
        const provider = track(new MSSQLProvider({ ...base, ssl: false, trustServerCertificate: true }));
        const config = driverConfig(provider);

        expect(config.options.encrypt).toBe(false);
        expect(config.options.trustServerCertificate).toBe(true);
    });

    it('forwards driverOptions', () => {
        const provider = track(new MSSQLProvider({
            ...base,
            driverOptions: { requestTimeout: 45000 },
        }));
        const config = driverConfig(provider);

        expect(config.requestTimeout).toBe(45000);
    });
});

describe('PostgreSQL TLS (#43)', () => {
    it('does not set ssl when the config says nothing', () => {
        const provider = track(new PostgreSQLProvider({ ...base, port: 5432 }));
        expect(driverConfig(provider).ssl).toBeUndefined();
    });

    it('forwards ssl: true', () => {
        const provider = track(new PostgreSQLProvider({ ...base, port: 5432, ssl: true }));
        expect(driverConfig(provider).ssl).toBe(true);
    });

    it('forwards an ssl options object', () => {
        const ssl = { rejectUnauthorized: true, ca: 'PEM' };
        const provider = track(new PostgreSQLProvider({ ...base, port: 5432, ssl }));
        expect(driverConfig(provider).ssl).toEqual(ssl);
    });

    it('forwards driverOptions', () => {
        const provider = track(new PostgreSQLProvider({
            ...base,
            port: 5432,
            driverOptions: { statement_timeout: 5000 },
        }));
        expect(driverConfig(provider).statement_timeout).toBe(5000);
    });
});

describe('MariaDB TLS (#43)', () => {
    it('does not set ssl when the config says nothing', () => {
        const provider = track(new MariaDBProvider({ ...base, port: 3306 }));
        expect(driverConfig(provider).ssl).toBeUndefined();
    });

    it('forwards ssl: true', () => {
        const provider = track(new MariaDBProvider({ ...base, port: 3306, ssl: true }));
        expect(driverConfig(provider).ssl).toBe(true);
    });

    it('forwards driverOptions', () => {
        const provider = track(new MariaDBProvider({
            ...base,
            port: 3306,
            driverOptions: { connectTimeout: 9000 },
        }));
        expect(driverConfig(provider).connectTimeout).toBe(9000);
    });
});
