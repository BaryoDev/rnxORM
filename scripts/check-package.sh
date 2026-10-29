#!/usr/bin/env bash
# Packs the project, installs the tarball with no database drivers, and
# checks that require, import and the missing-driver message all work.
# Run from the repo root after `npm run build`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$root"
npm pack --pack-destination "$work" --silent >/dev/null
tarball="$(ls "$work"/rnxorm-*.tgz)"

app="$work/app"
mkdir "$app"
cd "$app"
printf '{"name":"check-app","version":"1.0.0","private":true}\n' > package.json
# Peer dependencies are optional, so a plain install adds no driver.
npm install --no-audit --no-fund --silent "$tarball" >/dev/null

for driver in pg mssql mariadb; do
    if [ -d "node_modules/$driver" ]; then
        echo "FAIL: $driver was installed" >&2
        exit 1
    fi
done

cat > check.cjs <<'EOF'
const rnx = require('rnxorm');
if (typeof rnx.DbContext !== 'function') throw new Error('require: DbContext missing');

for (const [cls, pkg] of [['PostgreSQLProvider', 'pg'], ['MSSQLProvider', 'mssql'], ['MariaDBProvider', 'mariadb']]) {
    let message = '';
    try {
        new rnx[cls]({ host: 'localhost', port: 1, user: 'u', password: 'p', database: 'd' });
    } catch (error) {
        message = error.message;
    }
    const expected = cls + ' needs the "' + pkg + '" package. Install it with: npm install ' + pkg;
    if (message !== expected) throw new Error('unexpected message for ' + cls + ': ' + message);
}
console.log('require ok');
EOF

cat > check.mjs <<'EOF'
import * as esm from 'rnxorm';
import { createRequire } from 'node:module';
const cjs = createRequire(import.meta.url)('rnxorm');

const names = Object.keys(cjs).filter((n) => n !== 'default' && n !== '__esModule');
for (const name of names) {
    if (esm[name] !== cjs[name]) throw new Error('import and require differ for ' + name);
}
if (esm.DbContext !== cjs.DbContext) throw new Error('DbContext identity differs');
if (esm.default !== cjs) throw new Error('default export is not the CommonJS module');

const dynamic = await import('rnxorm');
if (dynamic.DbContext !== cjs.DbContext) throw new Error('import() DbContext identity differs');
console.log('import ok, ' + names.length + ' exports match');
EOF

node check.cjs
node check.mjs
echo "package check passed"
