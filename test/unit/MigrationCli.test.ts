import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createMigration, resolveConfigPath, resolveMigratorFactory, runMigrationCommand } from '../../src/migrations/cli';
import { Migrator } from '../../src/migrations/Migrator';

describe('migration CLI', () => {
    let tempDir: string;
    let originalCwd: string;
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnxorm-cli-'));
        process.chdir(tempDir);
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        logSpy.mockRestore();
    });

    describe('migration:create', () => {
        it('scaffolds a migration file with a PascalCase class and timestamp id', () => {
            const filePath = createMigration('add-users-table');

            expect(fs.existsSync(filePath)).toBe(true);
            expect(path.dirname(filePath)).toBe(path.join(tempDir, 'migrations'));
            expect(path.basename(filePath)).toMatch(/^\d{14}_add-users-table\.ts$/);

            const content = fs.readFileSync(filePath, 'utf-8');
            expect(content).toContain('export class AddUsersTable extends Migration');
            expect(content).toContain('async up(builder: MigrationBuilder)');
            expect(content).toContain('async down(builder: MigrationBuilder)');
        });

        it('throws when no name is given', () => {
            expect(() => createMigration('')).toThrow(/Migration name is required/);
        });
    });

    describe('config resolution', () => {
        it('throws with guidance when no config file exists', () => {
            expect(() => resolveConfigPath()).toThrow(/No config file found/);
        });

        it('finds rnxorm.config.js in the working directory', () => {
            const configPath = path.join(tempDir, 'rnxorm.config.js');
            fs.writeFileSync(configPath, 'module.exports = {};');

            expect(resolveConfigPath()).toBe(configPath);
        });

        it('resolves an explicit --config path and rejects missing ones', () => {
            const configPath = path.join(tempDir, 'custom.config.js');
            fs.writeFileSync(configPath, 'module.exports = {};');

            expect(resolveConfigPath('custom.config.js')).toBe(configPath);
            expect(() => resolveConfigPath('missing.config.js')).toThrow(/Config file not found/);
        });
    });

    describe('resolveMigratorFactory', () => {
        const fakeMigrator = { migrate: async () => 0 };

        it('accepts module.exports = { createMigrator }', async () => {
            const factory = resolveMigratorFactory({ createMigrator: () => fakeMigrator });
            await expect(factory()).resolves.toBe(fakeMigrator);
        });

        it('accepts a default export function', async () => {
            const factory = resolveMigratorFactory({ default: () => fakeMigrator });
            await expect(factory()).resolves.toBe(fakeMigrator);
        });

        it('accepts a default export object with createMigrator', async () => {
            const factory = resolveMigratorFactory({ default: { createMigrator: async () => fakeMigrator } });
            await expect(factory()).resolves.toBe(fakeMigrator);
        });

        it('rejects modules without a factory', () => {
            expect(() => resolveMigratorFactory({})).toThrow(/createMigrator/);
        });

        it('rejects factories that do not return a Migrator', async () => {
            const factory = resolveMigratorFactory({ createMigrator: () => ({}) });
            await expect(factory()).rejects.toThrow(/must return a Migrator/);
        });
    });

    describe('runMigrationCommand', () => {
        function fakeMigrator() {
            return {
                migrate: jest.fn().mockResolvedValue(1),
                revert: jest.fn().mockResolvedValue(true),
                status: jest.fn().mockResolvedValue(undefined),
            } as unknown as Migrator;
        }

        it('dispatches run to migrate()', async () => {
            const migrator = fakeMigrator();
            await runMigrationCommand('run', migrator);
            expect(migrator.migrate).toHaveBeenCalledTimes(1);
        });

        it('dispatches revert to revert()', async () => {
            const migrator = fakeMigrator();
            await runMigrationCommand('revert', migrator);
            expect(migrator.revert).toHaveBeenCalledTimes(1);
        });

        it('dispatches status to status()', async () => {
            const migrator = fakeMigrator();
            await runMigrationCommand('status', migrator);
            expect(migrator.status).toHaveBeenCalledTimes(1);
        });
    });
});
