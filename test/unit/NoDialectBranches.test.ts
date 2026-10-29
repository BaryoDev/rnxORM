import * as fs from 'fs';
import * as path from 'path';

/**
 * Dialect branching belongs in src/providers. Outside it, the arms below are
 * the ones that exist today. A count may only go down; a new file with an arm
 * fails. Lower the number here when an arm is removed.
 */
const ALLOWED: Record<string, number> = {
    'core/DbContext.ts': 4,
    'core/query/GroupedQueryBuilder.ts': 1,
    'core/query/QueryBuilder.ts': 1,
    'core/query/SelectQueryBuilder.ts': 1,
    'migrations/DdlIdentifiers.ts': 3,
    'migrations/MigrationBuilder.ts': 15,
    'migrations/Migrator.ts': 3,
};

const SRC = path.resolve(__dirname, '../../src');
const ARM = /(dialect|getDialect\(\)) === '|case '(mssql|postgresql|mariadb)'/;

function listFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (path.relative(SRC, full) === 'providers') continue;
            out.push(...listFiles(full));
        } else if (entry.name.endsWith('.ts')) {
            out.push(full);
        }
    }
    return out;
}

function countArms(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const file of listFiles(SRC)) {
        const n = fs.readFileSync(file, 'utf8').split('\n').filter((l) => ARM.test(l)).length;
        if (n > 0) counts[path.relative(SRC, file).split(path.sep).join('/')] = n;
    }
    return counts;
}

describe('dialect branches outside src/providers', () => {
    const found = countArms();

    it('no new file has a dialect branch', () => {
        const extra = Object.keys(found).filter((f) => !(f in ALLOWED));
        expect(extra).toEqual([]);
    });

    it.each(Object.entries(ALLOWED))('%s has at most %i arms', (file, max) => {
        expect(found[file] ?? 0).toBeLessThanOrEqual(max);
    });
});
