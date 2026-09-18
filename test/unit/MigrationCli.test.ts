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
        // realpathSync: os.tmpdir() is a symlink on macOS (/var -> /private/var);
        // the CLI resolves paths, so the test must compare against the real path
        tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnxorm-cli-')));
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

describe('migration:create name validation (#44)', () => {
    let tempDir: string;
    let originalCwd: string;
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnxorm-cli-name-')));
        process.chdir(tempDir);
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        logSpy.mockRestore();
    });

    it('rejects a name that would escape the migrations directory', () => {
        expect(() => createMigration('../../../../tmp/pwned')).toThrow(/migration name/i);
        expect(fs.existsSync(path.join(tempDir, 'migrations'))).toBe(false);
    });

    it('rejects a path separator anywhere in the name', () => {
        expect(() => createMigration('sub/dir')).toThrow(/migration name/i);
    });

    it('rejects a name that would break out of the generated string literal', () => {
        expect(() => createMigration('a") + evil() + ("b')).toThrow(/migration name/i);
    });

    it('rejects a name with a quote', () => {
        expect(() => createMigration('add"table')).toThrow(/migration name/i);
    });

    it('accepts the ordinary shapes', () => {
        for (const name of ['add-users-table', 'add_users', 'AddUsers2', 'v2-init']) {
            const filePath = createMigration(name);
            expect(fs.existsSync(filePath)).toBe(true);
            expect(path.dirname(filePath)).toBe(path.join(tempDir, 'migrations'));
        }
    });

    it('keeps the generated file inside the migrations directory', () => {
        const filePath = createMigration('safe-name');
        const migrationsDir = path.join(tempDir, 'migrations');
        expect(path.resolve(filePath).startsWith(path.resolve(migrationsDir) + path.sep)).toBe(true);
    });
});

describe('migration names must produce a valid class name (#44 follow-up)', () => {
    let tempDir: string;
    let originalCwd: string;
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        originalCwd = process.cwd();
        tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rnxorm-cli-cls-')));
        process.chdir(tempDir);
        logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        process.chdir(originalCwd);
        fs.rmSync(tempDir, { recursive: true, force: true });
        logSpy.mockRestore();
    });

    it('rejects a name starting with a digit, which produced "class 1Init"', () => {
        expect(() => createMigration('1-init')).toThrow(/migration name/i);
    });

    it('rejects a name with no alphanumeric character, which produced an empty class name', () => {
        expect(() => createMigration('---')).toThrow(/migration name/i);
    });

    it('still accepts a name that merely contains digits', () => {
        const filePath = createMigration('v2-init');
        expect(fs.readFileSync(filePath, 'utf-8')).toContain('export class V2Init extends Migration');
    });
});
