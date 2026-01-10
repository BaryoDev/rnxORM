import "reflect-metadata";
import { PostgreSQLProvider } from '../src/providers/PostgreSQLProvider';
import { MSSQLProvider } from '../src/providers/MSSQLProvider';
import { MariaDBProvider } from '../src/providers/MariaDBProvider';
import { IDatabaseProvider } from '../src/providers/IDatabaseProvider';

/**
 * Test database configurations for PostgreSQL, SQL Server, and MariaDB
 */
const testDatabaseConfigs = {
    postgres: {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432'),
        user: process.env.POSTGRES_USER || 'postgres',
        password: process.env.POSTGRES_PASSWORD || 'postgres',
        database: process.env.POSTGRES_DB || 'rnxorm_test'
    },
    mssql: {
        host: process.env.MSSQL_HOST || 'localhost',
        port: parseInt(process.env.MSSQL_PORT || '1433'),
        user: process.env.MSSQL_USER || 'sa',
        password: process.env.MSSQL_PASSWORD || 'YourStrong@Passw0rd',
        database: process.env.MSSQL_DB || 'rnxorm_test'
    },
    mariadb: {
        host: process.env.MARIADB_HOST || 'localhost',
        port: parseInt(process.env.MARIADB_PORT || '3306'),
        user: process.env.MARIADB_USER || 'root',
        password: process.env.MARIADB_PASSWORD || 'password',
        database: process.env.MARIADB_DB || 'rnxorm_test'
    }
};

/**
 * Create a database provider for testing
 */
export function createTestProvider(provider: 'postgres' | 'mssql' | 'mariadb'): IDatabaseProvider {
    const config = testDatabaseConfigs[provider];

    switch (provider) {
        case 'postgres':
            return new PostgreSQLProvider(config);
        case 'mssql':
            return new MSSQLProvider(config);
        case 'mariadb':
            return new MariaDBProvider(config);
        default:
            throw new Error(`Unknown provider: ${provider}`);
    }
}

/**
 * Helper to get available database providers for testing
 * Defaults to postgres if no environment variable is set
 */
export function getTestProviders(): Array<keyof typeof testDatabaseConfigs> {
    const providersEnv = process.env.TEST_PROVIDERS || 'postgres';
    return providersEnv.split(',') as Array<keyof typeof testDatabaseConfigs>;
}

/**
 * Sleep utility for timing tests
 */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Generate a unique test table name
 */
export function uniqueTableName(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}
