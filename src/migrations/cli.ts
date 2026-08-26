#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import { Migrator } from './Migrator';

/**
 * CLI tool for managing rnxORM migrations.
 *
 * migration:create scaffolds a migration file. migration:run/revert/status
 * load a config module (rnxorm.config.js by default, or --config <path>)
 * that exports a createMigrator() factory, and delegate to the Migrator.
 */

const DEFAULT_CONFIG_FILES = ['rnxorm.config.js', 'rnxorm.config.cjs', 'rnxorm.config.ts'];

function migrationsDir(): string {
    return path.join(process.cwd(), 'migrations');
}

/**
 * Generate a timestamp-based migration ID
 */
function generateMigrationId(): string {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const seconds = String(now.getSeconds()).padStart(2, '0');

    return `${year}${month}${day}${hours}${minutes}${seconds}`;
}

/**
 * Convert migration name to PascalCase
 */
function toPascalCase(name: string): string {
    return name
        .split(/[-_\s]+/)
        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
        .join('');
}

/**
 * Create a new migration file
 */
export function createMigration(name: string): string {
    if (!name) {
        throw new Error('Migration name is required. Usage: rnxorm migration:create <migration-name>');
    }

    const dir = migrationsDir();
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created migrations directory: ${dir}`);
    }

    const migrationId = generateMigrationId();
    const className = toPascalCase(name);
    const fileName = `${migrationId}_${name}.ts`;
    const filePath = path.join(dir, fileName);

    const template = `import { Migration, MigrationBuilder } from "rnxorm";

/**
 * Migration: ${name}
 * Created: ${new Date().toISOString()}
 */
export class ${className} extends Migration {
    constructor() {
        super("${migrationId}", "${name}");
    }

    async up(builder: MigrationBuilder): Promise<void> {
        // TODO: Define upgrade logic here
        // Example:
        // builder.createTable('example', [
        //     { name: 'id', type: 'integer', isPrimaryKey: true, isAutoIncrement: true },
        //     { name: 'name', type: 'varchar(100)', nullable: false }
        // ]);
    }

    async down(builder: MigrationBuilder): Promise<void> {
        // TODO: Define downgrade logic here
        // Example:
        // builder.dropTable('example');
    }
}
`;

    fs.writeFileSync(filePath, template, 'utf-8');
    console.log(`✓ Created migration: ${fileName}`);
    console.log(`  Location: ${filePath}`);
    console.log('');
    console.log('Next steps:');
    console.log('  1. Edit the migration file and define up() and down() logic');
    console.log('  2. Run: rnxorm migration:run');

    return filePath;
}

/**
 * Resolve the config module path from --config or the default candidates.
 */
export function resolveConfigPath(configArg?: string): string {
    if (configArg) {
        const resolved = path.resolve(process.cwd(), configArg);
        if (!fs.existsSync(resolved)) {
            throw new Error(`Config file not found: ${resolved}`);
        }
        return resolved;
    }

    for (const candidate of DEFAULT_CONFIG_FILES) {
        const resolved = path.resolve(process.cwd(), candidate);
        if (fs.existsSync(resolved)) {
            return resolved;
        }
    }

    throw new Error(
        `No config file found. Create one of [${DEFAULT_CONFIG_FILES.join(', ')}] ` +
        `in the project root or pass --config <path>.\n\n` +
        `Example rnxorm.config.js:\n\n` +
        `  const { DbContext, PostgreSQLProvider, Migrator } = require('rnxorm');\n` +
        `  const migrations = require('./dist/migrations');\n\n` +
        `  module.exports = {\n` +
        `      async createMigrator() {\n` +
        `          const context = new DbContext(new PostgreSQLProvider({\n` +
        `              host: 'localhost', port: 5432, user: 'postgres',\n` +
        `              password: 'postgres', database: 'mydb',\n` +
        `          }));\n` +
        `          await context.connect();\n` +
        `          const migrator = new Migrator(context);\n` +
        `          migrator.addMigrations(Object.values(migrations).map(M => new M()));\n` +
        `          return migrator;\n` +
        `      },\n` +
        `  };\n`
    );
}

/**
 * Extract the createMigrator() factory from a loaded config module.
 * Accepts { createMigrator }, a default export function, or a default
 * export object containing createMigrator.
 */
export function resolveMigratorFactory(configModule: any): () => Promise<Migrator> {
    const candidate =
        configModule?.createMigrator ??
        configModule?.default?.createMigrator ??
        (typeof configModule?.default === 'function' ? configModule.default : undefined);

    if (typeof candidate !== 'function') {
        throw new Error(
            'Config module must export a createMigrator() function ' +
            '(module.exports = { createMigrator } or export default).'
        );
    }

    return async () => {
        const migrator = await candidate();
        if (!migrator || typeof migrator.migrate !== 'function') {
            throw new Error('createMigrator() must return a Migrator instance.');
        }
        return migrator;
    };
}

/**
 * Load the config module and build a Migrator from it.
 * For .ts configs, ts-node is registered when available.
 */
async function loadMigrator(configArg?: string): Promise<Migrator> {
    const configPath = resolveConfigPath(configArg);

    if (configPath.endsWith('.ts')) {
        try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('ts-node/register/transpile-only');
        } catch {
            throw new Error(
                `Config file ${configPath} is TypeScript, but ts-node is not installed. ` +
                `Install ts-node or use a compiled .js config.`
            );
        }
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const configModule = require(configPath);
    const factory = resolveMigratorFactory(configModule);
    return factory();
}

/**
 * Execute migration:run/revert/status against a Migrator.
 */
export async function runMigrationCommand(command: 'run' | 'revert' | 'status', migrator: Migrator): Promise<void> {
    switch (command) {
        case 'run':
            await migrator.migrate();
            break;
        case 'revert':
            await migrator.revert();
            break;
        case 'status':
            await migrator.status();
            break;
    }
}

/**
 * Show help information
 */
function showHelp(): void {
    console.log(`
rnxORM Migration CLI

Usage:
  rnxorm migration:create <name>              Create a new migration file
  rnxorm migration:run [--config <path>]      Apply all pending migrations
  rnxorm migration:revert [--config <path>]   Revert the last migration
  rnxorm migration:status [--config <path>]   Show migration status
  rnxorm migration:help                       Show this help message

migration:run/revert/status load a config module (default: rnxorm.config.js
in the current directory) that exports a createMigrator() factory:

  const { DbContext, PostgreSQLProvider, Migrator } = require('rnxorm');
  const migrations = require('./dist/migrations');

  module.exports = {
      async createMigrator() {
          const context = new DbContext(new PostgreSQLProvider({
              host: 'localhost', port: 5432, user: 'postgres',
              password: 'postgres', database: 'mydb',
          }));
          await context.connect();
          const migrator = new Migrator(context);
          migrator.addMigrations(Object.values(migrations).map(M => new M()));
          return migrator;
      },
  };

Examples:
  rnxorm migration:create add-users-table
  rnxorm migration:run
  rnxorm migration:status --config ./config/rnxorm.config.js
`);
}

/**
 * Extract the value of --config from CLI args, if present.
 */
function parseConfigArg(args: string[]): string | undefined {
    const index = args.indexOf('--config');
    if (index !== -1 && args[index + 1]) {
        return args[index + 1];
    }
    return undefined;
}

/**
 * Main CLI entry point
 */
async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'migration:create':
            try {
                createMigration(args[1]);
            } catch (error: any) {
                console.error(`Error: ${error.message}`);
                process.exit(1);
            }
            break;

        case 'migration:run':
        case 'migration:revert':
        case 'migration:status': {
            let migrator: Migrator | undefined;
            try {
                migrator = await loadMigrator(parseConfigArg(args));
                const subcommand = command.replace('migration:', '') as 'run' | 'revert' | 'status';
                await runMigrationCommand(subcommand, migrator);
            } catch (error: any) {
                console.error(`Error: ${error.message}`);
                process.exitCode = 1;
            } finally {
                await migrator?.getContext().disconnect().catch(() => undefined);
            }
            break;
        }

        case 'migration:help':
        case 'help':
        case '--help':
        case '-h':
            showHelp();
            break;

        default:
            console.error(`Unknown command: ${command || '(none)'}`);
            console.log('Run "rnxorm migration:help" for usage information.');
            process.exit(1);
    }
}

if (require.main === module) {
    main();
}
