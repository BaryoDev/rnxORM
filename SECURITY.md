# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.2.x   | Yes |
| 2.1.x   | Security fixes only |
| < 2.1   | No |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(Security tab → "Report a vulnerability"). If that is unavailable, open an
issue that says only "security report, requesting contact" without details,
and a maintainer will follow up privately.

You can expect an acknowledgement within a week. Please allow maintainers a
reasonable window to ship a fix before public disclosure.

## What is and is not protected

Honest scope, so you can threat-model correctly:

- **Query values are always parameterized.** Every value passed through
  `where()`, query filters, `saveChanges()`, and seeding is bound as a driver
  parameter, never interpolated.
- **Column names and operators are validated at runtime** (2.2.0+): `where()`,
  `orderBy()`, and `having()` reject identifiers that are not mapped columns of
  the entity and operators outside the supported set, so untrusted input like
  `orderBy(req.query.sort)` fails loudly instead of reaching SQL. On 2.1.x and
  earlier these were interpolated unvalidated — do not pass untrusted input to
  them on old versions.
- **Raw SQL is yours.** `fromSqlRaw()` / `executeSqlRaw()` execute exactly what
  you pass; parameterize your own inputs.
- **Global query filters are a convenience, not an isolation boundary.** Do not
  rely on `hasQueryFilter()` alone for multi-tenant isolation; enforce tenancy
  in the database (row-level security, separate schemas) for hostile-tenant
  threat models.
- **Table names come from your entity metadata** (decorators/ModelBuilder), not
  from query-time input. Defining entities from untrusted input is out of scope.
