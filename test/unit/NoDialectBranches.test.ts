import * as fs from 'fs';
import * as path from 'path';

/** Dialect branching belongs in src/providers. Outside it there are none. */
const SRC = path.resolve(__dirname, '../../src');
const ARM = /(dialect|getDialect\(\))\s*[!=]==\s*['"]|case\s+['"](mssql|postgresql|mariadb)['"]/;

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

function findArms(): string[] {
    const found: string[] = [];
    for (const file of listFiles(SRC)) {
        const n = fs.readFileSync(file, 'utf8').split('\n').filter((l) => ARM.test(l)).length;
        if (n > 0) found.push(`${path.relative(SRC, file).split(path.sep).join('/')}: ${n}`);
    }
    return found;
}

describe('dialect branches outside src/providers', () => {
    it('there are none', () => {
        expect(findArms()).toEqual([]);
    });
});

describe('arm pattern', () => {
    it.each([
        `dialect === "mssql"`,
        `dialect  ===  'x'`,
        `getDialect() !== 'postgresql'`,
        `case "mariadb":`,
        `case  'mssql':`,
    ])('matches %s', (line) => {
        expect(ARM.test(line)).toBe(true);
    });

    it('ignores an unrelated line', () => {
        expect(ARM.test(`const mode = 'mssql';`)).toBe(false);
    });
});
