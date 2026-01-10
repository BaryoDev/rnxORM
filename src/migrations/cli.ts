#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';

/**
 * CLI tool for managing rnxORM migrations
 */

const MIGRATIONS_DIR = path.join(process.cwd(), 'migrations');

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
function createMigration(name: string): void {
    if (!name) {
        console.error('Error: Migration name is required.');
        console.log('Usage: rnxorm migration:create <migration-name>');
        process.exit(1);
    }

    // Ensure migrations directory exists
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });
        console.log(`Created migrations directory: ${MIGRATIONS_DIR}`);
    }

    const migrationId = generateMigrationId();
    const className = toPascalCase(name);
    const fileName = `${migrationId}_${name}.ts`;
    const filePath = path.join(MIGRATIONS_DIR, fileName);

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
}

/**
 * Show help information
 */
function showHelp(): void {
    console.log(`
rnxORM Migration CLI

Usage:
  rnxorm migration:create <name>    Create a new migration file
  rnxorm migration:run              Apply all pending migrations
  rnxorm migration:revert           Revert the last migration
  rnxorm migration:status           Show migration status
  rnxorm migration:help             Show this help message

Examples:
  rnxorm migration:create add-users-table
  rnxorm migration:create create-posts-table
  rnxorm migration:run
  rnxorm migration:revert
  rnxorm migration:status

For programmatic usage, use the Migrator class directly in your code:

  import { Migrator } from 'rnxorm';

  const migrator = new Migrator(dbContext);
  migrator.addMigrations([
    new AddUsersTable(),
    new CreatePostsTable()
  ]);
  await migrator.migrate();
`);
}

/**
 * Main CLI entry point
 */
function main(): void {
    const args = process.argv.slice(2);
    const command = args[0];

    switch (command) {
        case 'migration:create':
            createMigration(args[1]);
            break;

        case 'migration:run':
            console.log('To run migrations, use the Migrator class in your code:');
            console.log('');
            console.log('  import { Migrator } from "rnxorm";');
            console.log('  import * as migrations from "./migrations";');
            console.log('');
            console.log('  const migrator = new Migrator(dbContext);');
            console.log('  migrator.addMigrations(Object.values(migrations).map(M => new M()));');
            console.log('  await migrator.migrate();');
            console.log('');
            break;

        case 'migration:revert':
            console.log('To revert migrations, use the Migrator class in your code:');
            console.log('');
            console.log('  import { Migrator } from "rnxorm";');
            console.log('  import * as migrations from "./migrations";');
            console.log('');
            console.log('  const migrator = new Migrator(dbContext);');
            console.log('  migrator.addMigrations(Object.values(migrations).map(M => new M()));');
            console.log('  await migrator.revert();');
            console.log('');
            break;

        case 'migration:status':
            console.log('To check migration status, use the Migrator class in your code:');
            console.log('');
            console.log('  import { Migrator } from "rnxorm";');
            console.log('  import * as migrations from "./migrations";');
            console.log('');
            console.log('  const migrator = new Migrator(dbContext);');
            console.log('  migrator.addMigrations(Object.values(migrations).map(M => new M()));');
            console.log('  await migrator.status();');
            console.log('');
            break;

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

main();
