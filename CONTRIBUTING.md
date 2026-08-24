# Contributing

Thanks for contributing to rnxORM.

## Setup

```bash
git clone https://github.com/BaryoDev/rnxORM.git
cd rnxORM
npm ci
npm test
```

`npm test` runs the unit suite against mocked providers. It needs no database, finishes in seconds,
and is the gate for most changes.

## Running against real databases

The integration suite runs against PostgreSQL, MariaDB and SQL Server. It needs Docker:

```bash
docker compose -f docker-compose.test.yml up -d
npm run test:integration
docker compose -f docker-compose.test.yml down -v
```

The compose file binds non-default ports (PostgreSQL 5433, MariaDB 3307, SQL Server 11433) so it
does not collide with a database already running locally. `test:integration` passes those ports
through for you.

Anything touching `src/providers/` or SQL generation needs this suite, not just `npm test`. A change
that passes against the mock and breaks on a real dialect is the failure this catches, and the mock
will not tell you.

## Before opening a pull request

```bash
npm run lint      # eslint src test
npm run build     # tsc -p tsconfig.build.json
npm run format    # prettier, if you have touched formatting
```

## Pull requests

- Keep changes focused and clearly described.
- Link related issues (for example `Fixes #123`).
- Include a short test plan: what you ran, and what it reported.
- A bug fix needs a test that fails before the fix. Revert your change and confirm the test goes
  red, then put it back. A test that passes either way proves nothing.
- Match existing code style.

## Contributor terms

rnxORM is [MPL-2.0](LICENSE). Your contribution ships under that licence and you keep your
copyright. There is nothing to sign.

## Conduct

Be respectful and constructive in reviews and discussions.
