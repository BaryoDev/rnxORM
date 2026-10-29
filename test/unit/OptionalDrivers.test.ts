import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadDriver } from '../../src/providers/loadDriver';

describe('loadDriver', () => {
    it('names the package to install when the module is missing', () => {
        expect(() => loadDriver('PostgreSQLProvider', 'rnxorm-no-such-driver')).toThrow(
            'PostgreSQLProvider needs the "rnxorm-no-such-driver" package. Install it with: npm install rnxorm-no-such-driver'
        );
    });

    it('returns the module when it is installed', () => {
        const pg = loadDriver<typeof import('pg')>('PostgreSQLProvider', 'pg');
        expect(typeof pg.Pool).toBe('function');
    });

    describe('other failures', () => {
        let dir: string;

        beforeEach(() => {
            dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rnxorm-driver-'));
        });

        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it('rethrows an error thrown inside the module unchanged', () => {
            const file = path.join(dir, 'broken.js');
            fs.writeFileSync(file, 'throw new TypeError("driver exploded");');
            expect(() => loadDriver('PostgreSQLProvider', file)).toThrow(
                new TypeError('driver exploded')
            );
        });

        it('rethrows when the module itself needs a different missing module', () => {
            const file = path.join(dir, 'needs-other.js');
            fs.writeFileSync(file, 'require("rnxorm-other-missing");');
            let caught: any;
            try {
                loadDriver('PostgreSQLProvider', file);
            } catch (error) {
                caught = error;
            }
            expect(caught.code).toBe('MODULE_NOT_FOUND');
            expect(caught.message).toContain('rnxorm-other-missing');
            expect(caught.message).not.toContain('Install it with');
        });
    });
});

describe('importing the package', () => {
    it('does not load any database driver', () => {
        // A driver mocked to throw on load fails the import if the index
        // pulls it in.
        for (const name of ['pg', 'mssql', 'mariadb']) {
            jest.isolateModules(() => {
                jest.doMock(name, () => {
                    throw new Error(`${name} was loaded`);
                });
                // eslint-disable-next-line @typescript-eslint/no-require-imports
                expect(() => require('../../src/index')).not.toThrow();
                jest.dontMock(name);
            });
        }
    });
});
