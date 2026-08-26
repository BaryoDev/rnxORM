# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| 2.2.x   | Yes |
| 2.1.x   | Security fixes only |
| < 2.1   | No |

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(Security tab to "Report a vulnerability"). If that is unavailable, open an
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
  earlier these were interpolated unvalidated. Do not pass untrusted input to
  them on old versions.
  One documented exception: `orderBy()` on a **grouped** query also accepts a
  projection alias, which exists only in the SELECT list and cannot be checked
  against entity metadata. Such aliases are required to be plain identifiers
  (`^[A-Za-z_][A-Za-z0-9_]*$`), so injection-shaped strings. Anything with
  quotes, whitespace, semicolons, or comment markers. Are still rejected.
- **Row limits are validated at runtime** (2.2.0+): `skip()` and `take()` must
  receive a non-negative integer. They are the only query-API arguments that
  are interpolated rather than bound (no driver accepts a parameter for
  `LIMIT`/`OFFSET` everywhere), and TypeScript's `number` type erases at
  runtime, so an untyped `req.query.limit` reaching them used to be an
  injection vector. It now throws before SQL is assembled.
- **Raw SQL is yours.** `fromSqlRaw()` / `executeSqlRaw()` execute exactly what
  you pass; parameterize your own inputs.
- **Global query filters are a convenience, not an isolation boundary.** Do not
  rely on `hasQueryFilter()` alone for multi-tenant isolation; enforce tenancy
  in the database (row-level security, separate schemas) for hostile-tenant
  threat models.
- **Table names come from your entity metadata** (decorators/ModelBuilder), not
  from query-time input. Defining entities from untrusted input is out of scope.
