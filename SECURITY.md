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
- **Projection aliases are validated at runtime** (2.2.1+): the keys of an
  object-literal projection in `select()` and `groupBy().select()` reach SQL as
  aliases, and a computed key (`{ [req.query.label]: u.name }`) puts caller
  input in that position. They go through the same plain-identifier rule as
  grouped `orderBy()` aliases. On 2.2.0 and earlier these keys were emitted
  unvalidated; a projection alias built from request data was an injection
  point on any driver that accepts stacked statements.
- **Row limits are validated at runtime** (2.2.0+): `skip()` and `take()` must
  receive a non-negative integer. They are the only query-API arguments that
  are interpolated rather than bound (no driver accepts a parameter for
  `LIMIT`/`OFFSET` everywhere), and TypeScript's `number` type erases at
  runtime, so an untyped `req.query.limit` reaching them used to be an
  injection vector. It now throws before SQL is assembled.
- **Connections can use TLS** (2.2.1+): `DatabaseConfig` takes `ssl`
  (`true` or a driver options object) and a `driverOptions` passthrough, and
  all three providers forward them. SQL Server now defaults to
  `encrypt: true, trustServerCertificate: false`. On 2.2.0 and earlier there
  was no way to turn TLS on at all, and the SQL Server provider hardcoded
  `encrypt: false` with `trustServerCertificate: true`, so its traffic was
  cleartext and it accepted any certificate presented. Anyone on the network
  path could read every query and result set.
- **Migration DDL identifiers are validated and quoted** (2.2.1+):
  `MigrationBuilder` used to concatenate every argument it was given straight
  into DDL, including string defaults that land inside quotes. Table, column,
  index, and constraint names must now be plain identifiers (optionally
  `schema.name`) and are quoted for the dialect; string defaults have their
  embedded quotes doubled; column types must match a type grammar; and
  `ON DELETE` must be one of the four referential actions. On 2.2.0 and
  earlier, an app that built migration operations from request data (the
  "custom fields per tenant" shape) had an injection point: a default value of
  `x'; DROP TABLE users; --` closed the literal and ran.
  `migration:create` also validates the migration name, which used to be
  interpolated into both the output path (so `../../../../tmp/pwned` wrote
  outside the migrations directory) and the generated source.
- **Raw SQL is yours.** `fromSqlRaw()` / `executeSqlRaw()` execute exactly what
  you pass; parameterize your own inputs.
- **Global query filters are a convenience, not an isolation boundary.** Do not
  rely on `hasQueryFilter()` alone for multi-tenant isolation; enforce tenancy
  in the database (row-level security, separate schemas) for hostile-tenant
  threat models.
- **Table names come from your entity metadata** (decorators/ModelBuilder), not
  from query-time input. Defining entities from untrusted input is out of scope.
