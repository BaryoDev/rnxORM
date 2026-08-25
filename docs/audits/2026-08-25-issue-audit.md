# Open-issue audit — 2026-08-25

Every open issue, audited against the code on `main` (55ebb67) and dispositioned.
"This PR" = the `fix/issue-audit-hardening` branch this document ships on.

## Fixed in this PR

| Issue | What was missing | What landed |
|-------|------------------|-------------|
| #3 / #21 | `extractPropertyName` regex-parsed `Function.prototype.toString()`; `u => u.address.city` silently returned `address`, comments could change the resolved column | `src/core/expressions/PropertyCapture.ts` — recording-Proxy capture (ported from the reviewed phase-1 branch). Nested access, computed values, and coercions now classify as `opaque` and fail loudly or fall back explicitly. `extractPropertyName` and `src/core/utils.ts` are deleted. |
| #16 | include/sum/average/min/max still on the regex | All routed through `resolvePropertyName`/`resolveColumn` (28 call sites across DbSet, ModelBuilder, decorators — `grep extractPropertyName src/` returns nothing) |
| #17 | select()/groupBy() projections on two more regexes | Rebuilt on `capture()`/`captureAggregates()`: unmapped projected property throws, opaque selectors fall back to in-memory projection, `g.key` aliases the group column, `g.average` works; renamed-column tests prove the mapped column (not the property name) reaches SQL |
| #13 / #24 | `where()`/`orderBy()`/`having()` interpolated column and operator unvalidated — injectable via the sortable-table pattern; shipped in 2.1.0 | `src/core/Identifiers.ts`: columns validated against entity metadata (property or column spelling, renamed columns resolved), operators against a closed set, `having()` restricted to aggregate-over-mapped-column shapes, grouped `orderBy()` to mapped columns or plain-identifier aliases. End-to-end tests prove payloads throw before SQL assembly. Plus `SECURITY.md` (also requested by #13). |
| #22 (remainder) | `compileQueryFilter` interpolated the filter **operator** unvalidated — the same injection class in a second location (flagged in the issue's own comment) | Filter operators now pass through the same closed set |
| #23 (remainder) | `groupBy()` was the last read path ignoring structured query filters; `having()` placeholder baking made a naive fix corrupt parameter order | Both `groupBy()` factories inject the compiled filter eagerly (before `having()` can bake indices); `ignoreQueryFilters()` respected; proof tests include the having+filter ordering case. Coverage tests now prove filters on every read path: `count`, `skip/take` per dialect, `all()`, aggregates, `select()`, `find()`, `groupBy()`. |
| #19 | `all()` unverified against filters; limitations undocumented | `all()` filter coverage proven by test; the legacy-lambda limitation (in-memory only, `count()` counts unfiltered rows) is pinned by test and documented in the README |
| #15 | No characterization tests for row→entity mapping (the safety net for the future #20 split) | `test/unit/EntityMapper.test.ts` pins both mapping paths: renamed columns, converters, shadow-property exclusion, tracked vs no-tracking registration |
| #5 | ChangeTracker keyed by object identity; `find(1)` twice produced two tracked instances → conflicting UPDATEs | Identity map (type + primary key) in ChangeTracker; re-materialization returns the existing tracked instance, local modifications survive re-query, deletion/clear evict |
| #26 (partial) | No compile-time help on `where`/`orderBy` | Additive `keyof T` overloads for editor autocomplete. Full compile-time *enforcement* requires removing the string overloads — a breaking change deferred to 3.0 (see "Not in this PR"). |
| #11 (remainder) | No issue/PR templates (CONTRIBUTING itself landed in #27) | `.github/ISSUE_TEMPLATE/` (bug, feature, security contact link) + `PULL_REQUEST_TEMPLATE.md` with the evidence checklist |
| #6 (remainder) | No publish gate: 6 npm versions shipped without a real-DB run | `.github/workflows/release.yml`: publish requires the full suite green against real PostgreSQL, MariaDB, and SQL Server; dry-run is the default mode so the gate can be exercised before it matters. (Real-DB integration on every PR/push already landed on `main`.) |

Also fixed while auditing: Jest was collecting the abandoned phase-1 worktree
under `.claude/` into the main run (double-counted suites, 6 phantom failures),
and the migration-CLI test failed on macOS only (`/var` vs `/private/var`
tmpdir symlink).

## Deliberately NOT in this PR (open, with reasons)

| Issue | Why not here |
|-------|--------------|
| #20 | The DbSet split is a pure-movement refactor of a 1,600-line file. Mixing it into a behavior-changing PR would make both unreviewable. #15's characterization tests (this PR) are its prerequisite and are now in place. |
| #4 | The query model is the architecture follow-up to #20; the issues themselves order it after the split. |
| #7 / #10 | Both explicitly depend on #4 (SQLite as proof of the dialect boundary; packages need a real provider boundary first). |
| #8 / #12 | Decision records (MySQL deferred, MariaDB maintenance-only), not code. PR #14 carries the positioning docs. |
| #26 (full) | Compile-time enforcement means dropping the string overloads — breaking, 3.0 material. The runtime validation in this PR closes the security half now. |
| #25 | The release itself. This PR is its prerequisite; the release gate it requires now exists (`release.yml`). Run integration, merge, then release 2.2.0 through the gate. |

## Suggested issue actions after merge

- Close: #3, #5, #13, #15, #16, #17, #19, #21, #22, #23, #24, and #11, #6
  (their remainders land here).
- Comment on #26: runtime half + typed overloads shipped; retitle to track the
  3.0 breaking change.
- Keep open: #4, #7, #8, #10, #12, #20, #25 (sequenced as above).
