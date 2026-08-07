# rnxORM

A lightweight TypeScript ORM for **PostgreSQL**, **SQL Server**, and **MariaDB**, inspired by Entity Framework Core.

[![npm version](https://img.shields.io/npm/v/rnxorm.svg)](https://www.npmjs.com/package/rnxorm)
[![GitHub](https://img.shields.io/badge/github-BaryoDev%2FrnxORM-blue)](https://github.com/BaryoDev/rnxORM)
[![Build Status](https://img.shields.io/badge/build-passing-brightgreen.svg)](https://github.com/BaryoDev/rnxORM/actions)
[![Tests](https://img.shields.io/badge/tests-passing-brightgreen.svg)](https://github.com/BaryoDev/rnxORM/actions)
[![Ko-fi](https://img.shields.io/badge/Support%20me%20on-Ko--fi-ff5f5f?logo=ko-fi&logoColor=white)](https://ko-fi.com/T6T01CQT4R)

## Installation

**For PostgreSQL:**
```bash
npm install rnxorm pg reflect-metadata
npm install -D typescript @types/node @types/pg
```

**For SQL Server:**
```bash
npm install rnxorm mssql reflect-metadata
npm install -D typescript @types/node @types/mssql
```

**For MariaDB/MySQL:**
```bash
npm install rnxorm mariadb reflect-metadata
npm install -D typescript @types/node
```

## Configuration

Ensure you have `experimentalDecorators` and `emitDecoratorMetadata` enabled in your `tsconfig.json`.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

## Usage

### 1. Define your Entity

```typescript
import { Entity, Column, PrimaryKey } from "rnxorm";

@Entity("users")
export class User {
  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  age!: number;
}
```

### 2. Connect to Database

rnxORM supports multiple databases through provider pattern:

**PostgreSQL:**
```typescript
import { DbContext, PostgreSQLProvider } from "rnxorm";

const db = new DbContext(new PostgreSQLProvider({
  host: "localhost",
  port: 5432,
  user: "postgres",
  password: "password",
  database: "mydb",
}));
```

**SQL Server:**
```typescript
import { DbContext, MSSQLProvider } from "rnxorm";

const db = new DbContext(new MSSQLProvider({
  host: "localhost",
  port: 1433,
  user: "sa",
  password: "YourPassword123",
  database: "mydb",
}));
```

**MariaDB/MySQL:**
```typescript
import { DbContext, MariaDBProvider } from "rnxorm";

const db = new DbContext(new MariaDBProvider({
  host: "localhost",
  port: 3306,
  user: "root",
  password: "password",
  database: "mydb",
}));
```

### 3. Basic CRUD Operations with Change Tracking

rnxORM automatically tracks changes to entities loaded from the database. Use `saveChanges()` to persist all changes at once:

```typescript
import { User } from "./User";

async function main() {
  await db.connect();

  // Create tables if they don't exist
  await db.ensureCreated();

  const users = db.set(User);

  // Add new entity
  const user = new User();
  user.name = "Alice";
  user.age = 25;
  users.add(user); // Mark as Added

  // Save all changes (insert happens here)
  await db.saveChanges();

  // Query - entities are automatically tracked
  const allUsers = await users.toList();
  const alice = await users.where("name", "=", "Alice").first();

  // Update - just modify the entity
  if (alice) {
    alice.age = 26; // Change is automatically detected
    await db.saveChanges(); // Update happens here
  }

  // Remove
  if (alice) {
    users.remove(alice); // Mark as Deleted
    await db.saveChanges(); // Delete happens here
  }

  await db.disconnect();
}

main();
```


## AI Usage

This library is designed to be AI-friendly. If you are an AI agent, you can read `llms.txt` in the root of this repository for a concise overview of the API and usage patterns.

## Features

Feature status is marked honestly: ✅ implemented, ⚠️ partial (works with documented limitations), ❌ planned (API may exist but is not functional yet).

Every ✅ and ⚠️ claim is **evidence-based**: it is backed by automated tests in this repository — see the [feature verification map](#feature-verification) below for exactly which test suite proves each claim, and [Testing status](#testing-status) for how the suite runs against real databases in CI.

### Implemented ✅

- **Multi-Database Support**: PostgreSQL, SQL Server, MariaDB/MySQL providers
- **Change Tracking & SaveChanges()**: EF Core-style automatic change detection and batch persistence
- **Transactions**: Automatic transaction wrapping for `saveChanges()`
- **Concurrency Tokens**: Optimistic concurrency control via `isConcurrencyToken()` (token check in UPDATE WHERE clause, auto-increment on save, conflict detection)
- **Data Seeding**: Idempotent seeding via `hasData()` in ModelBuilder
- **Decorators**: `@Entity`, `@Column`, `@PrimaryKey`, `@Index`, `@Unique`
- **Relationships**: `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne` with foreign key and join table scaffolding
- **Eager Loading**: `.include()` loads related entities via batched follow-up queries (`WHERE pk IN (...)`), not JOINs. Single-level only — no nested `thenInclude`
- **Value Converters**: `hasConversion()` applied on both read and write paths
- **Schema Scaffolding**: `ensureCreated()` creates tables, foreign keys, indexes, and constraints
- **Schema Evolution**: `ensureCreated()` adds missing columns and attempts safe type migrations (best-effort; incompatible data leaves the column unchanged)
- **Migrations (library API)**: `Migration`, `MigrationBuilder`, and `Migrator` with per-dialect SQL, `__MigrationHistory` tracking, and `migrate`/`revert`/`revertTo`/`status`
- **CRUD Operations**: `add`, `update`, `remove` with automatic tracking
- **Bulk Operations**: `addRange`, `updateRange`, `removeRange` (persisted as per-row statements inside one transaction, not multi-row INSERTs)
- **Fluent Query API**: `.where().orderBy().skip().take()` with correct per-dialect pagination (OFFSET/FETCH on SQL Server)
- **Aggregations**: `sum`, `average`, `min`, `max`, `count` generated as real SQL aggregates
- **Fluent API / ModelBuilder**: Configure entities programmatically via `onModelCreating()`
- **Repository Pattern**: `DbSet<T>` with integrated change tracking
- **Query Optimization**: `.asNoTracking()` skips change tracking for read-only queries
- **Primary Key Lookup**: `.find(id)`
- **Global Query Filters (structured form)**: `hasQueryFilter({ property, operator, value })` conditions are **translated to SQL WHERE clauses** on every query path (`toList`, `find`, `where()` chains, aggregates, projections), so filtered rows never leave the database. Bypass per-query with `ignoreQueryFilters()`. See [Global Query Filters](#global-query-filters)
- **Migration CLI**: `npx rnxorm migration:create|run|revert|status` — run/revert/status load a `rnxorm.config.js` exporting a `createMigrator()` factory. See [Migrations](#migrations)

### Partial ⚠️

- **LINQ-Style Projections (`select`, `groupBy`)**: Lambda selectors are parsed with regex-based string matching, not a real expression parser. Simple shapes like `u => ({ name: u.name })` and `g.count()` / `g.sum(u => u.prop)` translate to SQL; anything more complex silently falls back to fetching all rows and projecting in memory. See [LINQ-Style Query API](#linq-style-query-api)
- **Global Query Filters (predicate form)**: the legacy `hasQueryFilter(u => ...)` predicate form runs **in memory after rows are fetched** — it is never translated to SQL. Prefer the structured-condition form, which is. See [Global Query Filters](#global-query-filters)
- **Raw SQL Queries**: `fromSqlRaw()`/`executeSqlRaw()` work, but parameter placeholders are **not** translated between dialects — write `$1` for PostgreSQL, `@p0` for SQL Server, `?` for MariaDB. Global query filters on raw SQL results are evaluated in memory
- **Keyless Entity Types**: `hasNoKey()` works for querying views; read-only behavior is not enforced (no error if you try to track one)
- **Shadow Properties**: Columns are created and included in INSERTs, but defaults are sent as literal parameter values — SQL expressions like `CURRENT_TIMESTAMP` are **not** emitted as DDL `DEFAULT` clauses and will not evaluate. Use constant defaults only

### Planned ❌ (API exists but is not functional — do not rely on these)

- **Explicit Loading**: `entry().reference()`/`collection()` throw "not implemented"
- **Owned Entity Types**: `ownsOne()`/`ownsMany()` store configuration but nothing consumes it — no column flattening, no owned tables are created
- **Default Values**: `hasDefaultValue()` on regular columns stores metadata but is never emitted to DDL or used in inserts
- **Computed Columns**: `hasComputedColumnSql()` stores metadata but no `GENERATED ALWAYS AS` DDL is emitted
- **Lazy Loading**: Not implemented

### Feature verification

Each implemented feature maps to the automated tests that prove it. Unit suites assert **exact generated SQL per dialect** via a capturing provider; the integration suite executes against **real PostgreSQL, MariaDB, and SQL Server** in CI.

| Feature | Proven by |
|---------|-----------|
| Multi-database support (3 providers) | `test/integration/ActualApi.test.ts` against real containers in CI (`.github/workflows/integration.yml`) |
| Change tracking & state transitions | `test/unit/ChangeTracker.test.ts` (49 tests, 100% coverage), `test/unit/EntityEntry.test.ts` |
| `saveChanges()` transaction wrapping & rollback on error | `test/unit/TrackingTransactionsAndSchema.test.ts` |
| `asNoTracking()` (untracked, changes not persisted) | `test/unit/TrackingTransactionsAndSchema.test.ts` |
| Concurrency tokens (end-to-end conflict detection) | `test/unit/ConcurrencyToken.test.ts`, `test/unit/SqlGeneration.test.ts` |
| Per-dialect SQL: pagination, placeholders, generated-key retrieval, IDENTITY_INSERT | `test/unit/SqlGeneration.test.ts` (exact SQL strings), verified on real engines by the integration run |
| Global query filters translated to SQL | `test/unit/QueryFilterSql.test.ts` (18 tests: all query paths, all 3 dialects, dynamic values, `ignoreQueryFilters()`) |
| Eager loading (`include()`) for all four relation types | `test/unit/EagerLoading.test.ts` (batched IN queries, stitching, edge cases) |
| Relationship configuration (decorators & ModelBuilder) | `test/unit/RelationshipBuilder.test.ts`, `test/unit/EagerLoading.test.ts` |
| Value converters (insert / read / update round-trip) | `test/unit/ValueConversionAndKeyless.test.ts` |
| Keyless entities (query, `ensureCreated()` skip, no persistence) | `test/unit/ValueConversionAndKeyless.test.ts` |
| Shadow properties included in INSERTs | `test/unit/TrackingTransactionsAndSchema.test.ts` |
| Schema evolution (add missing columns, attempt type migration) | `test/unit/TrackingTransactionsAndSchema.test.ts` |
| Schema scaffolding (`ensureCreated()` on real databases) | `test/integration/ActualApi.test.ts` (creates schema on all 3 engines in CI) |
| Migrations DDL (per-dialect create/alter/index/FK) | `test/unit/MigrationBuilder.test.ts` (~40 tests) |
| Migrator (history table, migrate/revert/revertTo/status, transactions) | `test/unit/Migrator.test.ts` (~34 tests) |
| Migration CLI (scaffolding, config loading, run/revert/status dispatch) | `test/unit/MigrationCli.test.ts` |
| ModelBuilder fluent API (keys, indexes, constraints, seeding, filters) | `test/unit/ModelBuilder.test.ts` |
| CRUD, bulk operations, SQL-injection safety, unicode | `test/integration/ActualApi.test.ts` per provider |
| Documented comparison operators (`=`, `!=`, `<>`, `>`, `<`, `>=`, `<=`, `LIKE`) | `test/integration/ActualApi.test.ts` per provider |
| Aggregations as real SQL aggregates | `test/unit/SqlGeneration.test.ts`, `test/unit/QueryFilterSql.test.ts` |
| Raw SQL (`fromSqlRaw`/`executeSqlRaw`) | `test/unit/SqlGeneration.test.ts`, `test/unit/TrackingTransactionsAndSchema.test.ts` |
| Data seeding (idempotent `hasData()`) | `test/unit/ModelBuilder.test.ts` |
| Decorator metadata registration | `test/unit/MetadataStorage.test.ts` |
| Type mapping table, placeholder syntax, dialect identifiers | `test/unit/ProviderTypeMapping.test.ts` (also pins the capture provider's parity with real providers) |

If a claim in this README is not represented in this map or the linked suites, treat it as unverified and [open an issue](https://github.com/BaryoDev/rnxORM/issues).

### Testing status

The test suite (286 tests, all passing) runs against an **in-memory mock provider** by default — it validates the ORM's tracking, metadata, eager loading, and per-dialect SQL-generation logic without infrastructure. The same suite also runs against **real PostgreSQL 16, MariaDB 11, and SQL Server 2022** containers on every pull request and push to `main` (`.github/workflows/integration.yml`), and locally via `docker compose -f docker-compose.test.yml up -d --wait && npm run test:integration`.

## Type Mapping

rnxORM automatically maps TypeScript types to database-specific types. You can override this using the `@Column({ type: '...' })` option. This table is pinned by `test/unit/ProviderTypeMapping.test.ts`:

| TypeScript Type | PostgreSQL | SQL Server | MariaDB/MySQL |
|----------------|------------|------------|---------------|
| `string`       | `TEXT`     | `NVARCHAR(MAX)` | `TEXT`   |
| `number`       | `INTEGER`  | `INT`      | `INT`         |
| `boolean`      | `BOOLEAN`  | `BIT`      | `TINYINT(1)`  |
| `Date`         | `TIMESTAMP`| `DATETIME2`| `DATETIME`    |

### Overriding Types

To use a specific database type, pass the `type` option to the `@Column` decorator:

```typescript
@Column({ type: "varchar(100)" })
email!: string;

@Column({ type: "decimal(10, 2)" })
price!: number;
```

## Query Operators

The `.where(column, operator, value)` method passes the operator **verbatim** into the generated SQL, so any comparison operator your database supports works. Values are always bound as parameters (never interpolated). Common operators verified against all three engines by the integration suite: `=`, `!=`/`<>`, `>`, `<`, `>=`, `<=`, `LIKE`.

```typescript
// Examples
users.where("age", ">=", 21);
users.where("name", "LIKE", "%doe%");
users.where("name", "ILIKE", "%doe%"); // ILIKE is PostgreSQL-only
```

> **Note**: because column and operator strings are placed into the SQL as-is, they must come from your code, never from user input. Only the `value` argument is parameterized.

## Change Tracking & SaveChanges()

rnxORM implements EF Core-style change tracking, automatically detecting modifications to entities and persisting all changes with a single `saveChanges()` call.

### How It Works

1. **Entities loaded from the database are automatically tracked**
2. **Modifications to tracked entities are detected**
3. **Call `saveChanges()` to persist all changes in a single transaction**

### Entity States

Each tracked entity has one of these states:

- **Added**: New entity, will be inserted
- **Unchanged**: Loaded from database, no changes
- **Modified**: Loaded from database, has changes
- **Deleted**: Marked for deletion
- **Detached**: Not being tracked

### Basic Usage

```typescript
// Load an entity (automatically tracked)
const user = await users.find(1);

// Modify it (change is detected automatically)
user.name = "Updated Name";
user.age = 30;

// Save all changes
await db.saveChanges(); // Generates UPDATE statement
```

### Adding Entities

```typescript
const newUser = new User();
newUser.name = "Alice";
newUser.email = "alice@example.com";

users.add(newUser); // Mark as Added
await db.saveChanges(); // INSERT happens here

// Auto-increment ID is set after save
console.log(newUser.id); // e.g., 42
```

### Updating Entities

```typescript
// Method 1: Load and modify
const user = await users.find(1);
user.age = 31;
await db.saveChanges();

// Method 2: Manually mark as modified
const user = new User();
user.id = 1;
user.name = "Alice";
user.age = 31;

users.update(user); // Mark as Modified
await db.saveChanges();
```

### Deleting Entities

```typescript
const user = await users.find(1);
users.remove(user); // Mark as Deleted
await db.saveChanges(); // DELETE happens here
```

### Multiple Changes in One Transaction

```typescript
// Add new user
const newUser = new User();
newUser.name = "Bob";
users.add(newUser);

// Update existing user
const alice = await users.where("name", "=", "Alice").first();
if (alice) {
    alice.age = 26;
}

// Delete another user
const charlie = await users.find(3);
if (charlie) {
    users.remove(charlie);
}

// All changes happen in a single transaction
const changesCount = await db.saveChanges();
console.log(`Saved ${changesCount} changes`);
```

### Manual Change Detection

```typescript
// Auto-detection is enabled by default
db.changeTracker.autoDetectChangesEnabled = true;

// Disable auto-detection for performance
db.changeTracker.autoDetectChangesEnabled = false;

const user = await users.find(1);
user.age = 30;

// Manually detect changes
db.changeTracker.detectChanges();

await db.saveChanges();
```

### Attach & Entry

```typescript
// Attach an entity without loading from database
const user = new User();
user.id = 1;
user.name = "Alice";

db.attach(user, EntityState.Unchanged);

// Get entry for an entity
const entry = db.entry(user);
console.log(entry.state); // EntityState.Unchanged

// Manually change state
entry.state = EntityState.Modified;
await db.saveChanges();
```

### Change Tracker Statistics

```typescript
const stats = db.changeTracker.getStatistics();
console.log(`Total tracked: ${stats.total}`);
console.log(`Added: ${stats.added}`);
console.log(`Modified: ${stats.modified}`);
console.log(`Deleted: ${stats.deleted}`);
console.log(`Unchanged: ${stats.unchanged}`);
```

### No-Tracking Queries

For read-only scenarios, use `asNoTracking()` to skip change tracking:

```typescript
// Entities are not tracked (better performance)
const users = await db.set(User)
    .asNoTracking()
    .toList();

// Modifications won't be saved
users[0].age = 100;
await db.saveChanges(); // Nothing happens
```

## Relationships

rnxORM supports all major relationship types with automatic foreign key generation and eager loading.

> **How eager loading works**: `.include()` issues batched follow-up queries (`SELECT ... WHERE fk IN (...)`) and stitches the related entities together in memory — it does not generate SQL JOINs. Only one level of include is supported (no nested `thenInclude`).

### One-to-Many / Many-to-One

```typescript
import { Entity, Column, PrimaryKey, OneToMany, ManyToOne } from "rnxorm";

@Entity("users")
export class User {
  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @OneToMany(() => Post, post => post.author)
  posts!: Post[];
}

@Entity("posts")
export class Post {
  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;

  @ManyToOne(() => User, user => user.posts)
  author!: User;
}

// Query with eager loading
const users = await db.set(User)
  .include(u => u.posts)
  .toList();

users[0].posts.forEach(post => console.log(post.title));
```

### Many-to-Many

```typescript
import { Entity, PrimaryKey, Column, ManyToMany } from "rnxorm";

@Entity("students")
export class Student {
  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @ManyToMany(() => Course, course => course.students, {
    joinTable: "student_courses",
    joinColumn: "studentId",
    inverseJoinColumn: "courseId"
  })
  courses!: Course[];
}

@Entity("courses")
export class Course {
  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @ManyToMany(() => Student, student => student.courses)
  students!: Student[];
}

// Query with eager loading
const students = await db.set(Student)
  .include(s => s.courses)
  .toList();
```

### One-to-One

```typescript
import { Entity, PrimaryKey, Column, OneToOne } from "rnxorm";

@Entity("users")
export class User {
  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @OneToOne(() => Profile, profile => profile.user)
  profile!: Profile;
}

@Entity("profiles")
export class Profile {
  @PrimaryKey()
  id!: number;

  @Column()
  bio!: string;

  @OneToOne(() => User, user => user.profile)
  user!: User;
}
```

### Cascade Options

Control what happens when parent entities are deleted:

```typescript
@ManyToOne(() => User, user => user.posts, {
  onDelete: "CASCADE",  // Options: CASCADE, SET_NULL, RESTRICT, NO_ACTION
  onUpdate: "CASCADE"
})
author!: User;
```

## LINQ-Style Query API

rnxORM provides a LINQ-style API for querying data.

> **How lambda selectors are translated**: rnxORM does not have an expression-tree parser. Selectors like `u => u.age` or `u => ({ name: u.name })` are matched against the lambda's source text with regexes. Simple property accesses and object literals translate to SQL (`SELECT col AS alias`, `GROUP BY`, SQL aggregates); anything the parser doesn't recognize (computed values, template strings, method calls) makes the query **fall back to fetching all rows and evaluating the selector in memory**. Results stay correct, but check performance on large tables.

### Aggregations

```typescript
// Sum
const totalAge = await users.sum(u => u.age);

// Average
const avgAge = await users.average(u => u.age);

// Min/Max
const youngest = await users.min(u => u.age);
const oldest = await users.max(u => u.age);

// Count
const userCount = await users.count();

// With conditions
const adultCount = await users.where("age", ">=", 18).count();
```

### Projections (Select)

```typescript
// Simple projection
const names = await users
  .select(u => ({ name: u.name, email: u.email }))
  .toList();

// With transformations
const summary = await users
  .select(u => ({
    fullInfo: `${u.name} (${u.age})`,
    isAdult: u.age >= 18
  }))
  .toList();
```

### Group By

```typescript
// Group users by age
const grouped = await users
  .groupBy(u => u.age)
  .select(g => ({
    age: g.key,
    count: g.count(),
    avgSalary: g.average(u => u.salary),
    totalSalary: g.sum(u => u.salary)
  }))
  .toList();

// With HAVING clause
const popularAges = await users
  .groupBy(u => u.age)
  .having('COUNT(*)', '>', 5)
  .select(g => ({ age: g.key, count: g.count() }))
  .toList();
```

### Distinct

```typescript
// Get unique ages
const uniqueAges = await users
  .select(u => u.age)
  .distinct()
  .toList();
```

### Advanced Queries

```typescript
// Single - throws if 0 or >1 results
const user = await users.where("email", "=", "alice@example.com").single();

// SingleOrDefault - returns null if not found, throws if >1
const maybeUser = await users.where("age", "=", 25).singleOrDefault();

// FirstOrThrow - throws if no results
const firstUser = await users.orderBy("name").firstOrThrow();

// All - checks if all entities match predicate
const allAdults = await users.all(u => u.age >= 18);
```

## Fluent API / ModelBuilder

Configure entities programmatically by overriding `onModelCreating()` in your DbContext:

```typescript
import { DbContext, ModelBuilder, PostgreSQLProvider } from "rnxorm";

export class AppDbContext extends DbContext {
  constructor() {
    super(new PostgreSQLProvider({ /* config */ }));
  }

  protected onModelCreating(modelBuilder: ModelBuilder): void {
    // Configure User entity
    modelBuilder.entity(User)
      .toTable('users')
      .hasKey(u => u.id)
      .hasIndex(u => u.email, { unique: true })
      .property(u => u.email)
        .isRequired()
        .hasMaxLength(255)
        .hasColumnType('varchar(255)');

    // Configure relationships
    modelBuilder.entity(Post)
      .hasOne(p => p.author, User)
        .withMany(u => u.posts)
        .hasForeignKey('authorId')
        .onDelete('CASCADE');

    // Configure many-to-many
    modelBuilder.entity(Student)
      .hasManyToMany(s => s.courses, Course, {
        joinTable: 'student_courses',
        leftKey: 'studentId',
        rightKey: 'courseId'
      });

    // Configure indexes and constraints
    modelBuilder.entity(User)
      .hasCompositeIndex([u => u.firstName, u => u.lastName])
      .hasUnique(u => u.username);
  }
}
```

### Available Fluent API Methods

**Entity Configuration:**
- `.toTable(name)` - Set table name
- `.hasKey(selector)` - Set primary key
- `.hasIndex(selector, options?)` - Add index
- `.hasCompositeIndex(selectors, options?)` - Add composite index
- `.hasUnique(selector, options?)` - Add unique constraint

**Property Configuration:**
- `.property(selector)` - Configure a property
  - `.isRequired()` - Mark as NOT NULL
  - `.isOptional()` - Mark as nullable
  - `.hasMaxLength(length)` - Set max length for strings
  - `.hasColumnName(name)` - Set column name
  - `.hasColumnType(type)` - Set database type

**Relationship Configuration:**
- `.hasOne(selector, type)` - Configure one-to-one or many-to-one
  - `.withOne(selector)` - Inverse for one-to-one
  - `.withMany(selector)` - Inverse for one-to-many
  - `.hasForeignKey(column)` - Set foreign key column
  - `.onDelete(action)` - Set ON DELETE behavior
  - `.onUpdate(action)` - Set ON UPDATE behavior
- `.hasMany(selector, type)` - Configure one-to-many
- `.hasManyToMany(selector, type, options)` - Configure many-to-many
  - `.usingJoinTable(table, leftKey, rightKey)` - Configure join table

## Indexes and Constraints

### Using Decorators

```typescript
import { Entity, Column, PrimaryKey, Index, Unique } from "rnxorm";

@Entity("users")
@Index(["email"], { unique: true })
@Index(["lastName", "firstName"])
@Unique(["username"])
export class User {
  @PrimaryKey()
  id!: number;

  @Column()
  @Unique()
  email!: string;

  @Column()
  username!: string;

  @Column()
  firstName!: string;

  @Column()
  lastName!: string;
}
```

### Using Fluent API

```typescript
modelBuilder.entity(User)
  .hasIndex(u => u.email, { unique: true, name: 'idx_user_email' })
  .hasCompositeIndex([u => u.lastName, u => u.firstName], { name: 'idx_user_name' })
  .hasUnique(u => u.username, { name: 'uq_user_username' });
```

## Data Seeding

rnxORM supports seeding initial data into your database using the Fluent API. Seed data is inserted during `ensureCreated()` and is idempotent (won't duplicate existing records).

### Defining Seed Data

Use `hasData()` in your `onModelCreating()` method:

```typescript
import { DbContext, ModelBuilder, PostgreSQLProvider } from "rnxorm";

export class AppDbContext extends DbContext {
    constructor() {
        super(new PostgreSQLProvider({ /* config */ }));
    }

    protected onModelCreating(modelBuilder: ModelBuilder): void {
        // Seed users
        modelBuilder.entity(User)
            .hasData([
                { id: 1, name: 'Admin', email: 'admin@example.com', role: 'admin' },
                { id: 2, name: 'User', email: 'user@example.com', role: 'user' },
                { id: 3, name: 'Guest', email: 'guest@example.com', role: 'guest' }
            ]);

        // Seed categories
        modelBuilder.entity(Category)
            .hasData([
                { id: 1, name: 'Electronics', slug: 'electronics' },
                { id: 2, name: 'Books', slug: 'books' },
                { id: 3, name: 'Clothing', slug: 'clothing' }
            ]);
    }
}
```

### Seeding Behavior

- **Idempotent**: Seed data is only inserted if it doesn't already exist (checked by primary key)
- **Automatic**: Runs during `ensureCreated()` after schema creation
- **Partial Entities**: Only properties included in seed data are inserted
- **Silent**: Seeding runs without producing console output, keeping logs clean

```typescript
const db = new AppDbContext();
await db.connect();
await db.ensureCreated(); // Seeds data automatically
```

### Best Practices

1. **Always specify primary keys** in seed data for idempotency
2. **Use for reference data**: Categories, roles, default users, configuration
3. **Keep seed data small**: Large datasets should use migrations or separate scripts
4. **Version control**: Seed data is code, commit it with your model changes

## Default Values & Computed Columns *(Planned)*

> **Note**: These APIs currently only **store configuration metadata — they have no runtime effect yet**. `hasDefaultValue()` is not emitted as a `DEFAULT` clause in `CREATE TABLE` and is not used during inserts; `hasComputedColumnSql()` does not generate `GENERATED ALWAYS AS` columns. Full support is planned. If you need defaults or computed columns today, define them in a migration with raw SQL (`builder.sql(...)`) or via `MigrationBuilder.createTable`, which does support `defaultValue`.

### Default Values

Set default values for columns using the Fluent API:

```typescript
protected onModelCreating(modelBuilder: ModelBuilder): void {
    modelBuilder.entity(User)
        .property(u => u.createdAt)
            .hasDefaultValue('CURRENT_TIMESTAMP')
        .property(u => u.isActive)
            .hasDefaultValue(true)
        .property(u => u.status)
            .hasDefaultValue('pending');
}
```

**Supported Default Values:**
- **Constants**: `true`, `false`, `0`, `'pending'`
- **SQL Expressions**: `'CURRENT_TIMESTAMP'`, `'NOW()'`, `'UUID()'`
- **Numbers and Strings**: Any valid SQL literal

### Computed Columns

Define computed columns that are calculated by the database:

```typescript
protected onModelCreating(modelBuilder: ModelBuilder): void {
    modelBuilder.entity(User)
        // Computed full name from first and last name
        .property(u => u.fullName)
            .hasComputedColumnSql("CONCAT(first_name, ' ', last_name)")

        // Computed age from birthdate
        .property(u => u.age)
            .hasComputedColumnSql("EXTRACT(YEAR FROM AGE(CURRENT_DATE, birth_date))");

    modelBuilder.entity(Order)
        // Computed total from quantity and price
        .property(o => o.total)
            .hasComputedColumnSql("quantity * unit_price");
}
```

**Important Notes:**
- Computed columns are **read-only**
- Values are **calculated by the database** (not in TypeScript)
- SQL expressions are **database-specific** (PostgreSQL examples above)
- Computed columns are **not included in INSERT/UPDATE** statements

### Combining Features

```typescript
protected onModelCreating(modelBuilder: ModelBuilder): void {
    modelBuilder.entity(Product)
        .toTable('products')
        .property(p => p.createdAt)
            .hasColumnType('timestamp')
            .hasDefaultValue('CURRENT_TIMESTAMP')
            .isRequired()
        .property(p => p.updatedAt)
            .hasColumnType('timestamp')
            .hasDefaultValue('CURRENT_TIMESTAMP')
        .property(p => p.isActive)
            .hasDefaultValue(true)
        .property(p => p.displayName)
            .hasComputedColumnSql("UPPER(name)")
        .hasData([
            { id: 1, name: 'Laptop', price: 999.99 },
            { id: 2, name: 'Mouse', price: 29.99 }
        ]);
}
```

## Global Query Filters

Global query filters automatically apply to all queries for an entity, making them perfect for implementing soft deletes, multi-tenancy, or other row-level filtering requirements.

### Defining Query Filters

Use `hasQueryFilter()` in your `onModelCreating()` method. The **structured
form** is preferred — its conditions are translated to parameterized SQL
`WHERE` clauses, so filtered rows never leave the database:

```typescript
protected onModelCreating(modelBuilder: ModelBuilder): void {
    // Soft delete filter — becomes "WHERE isDeleted = $1" in SQL
    modelBuilder.entity(User)
        .hasQueryFilter({ property: 'isDeleted', operator: '=', value: false });

    // Multi-tenant filter — pass a function to resolve the value at query time
    modelBuilder.entity(Document)
        .hasQueryFilter({ property: 'tenantId', operator: '=', value: () => this.currentTenantId });

    // Combine multiple conditions (joined with AND)
    modelBuilder.entity(Post)
        .hasQueryFilter([
            { property: 'isPublished', operator: '=', value: true },
            { property: 'isDeleted', operator: '=', value: false },
        ]);
}
```

`property` is the entity property name (mapped to its column, with value
converters applied), and `operator` is any SQL comparison operator supported
by your database (`=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`, ...).

The **predicate form** is still supported for arbitrary JavaScript logic, but
runs **in memory after rows are fetched** — the SQL is not modified, so
filtered-out rows still cross the wire:

```typescript
modelBuilder.entity(User).hasQueryFilter(u => !u.isDeleted);
```

### Automatic Filtering

Query filters are **automatically applied** to all queries:

```typescript
// SELECT * FROM users WHERE isDeleted = $1
const users = await db.set(User).toList();

// SELECT * FROM users WHERE role = $1 AND isDeleted = $2
const admins = await db.set(User).where('role', '=', 'admin').toList();

// SELECT * FROM users WHERE id = $1 AND isDeleted = $2
const user = await db.set(User).find(1);
// Returns null if user.id = 1 but user.isDeleted = true

// Aggregates and projections are filtered too
const activeCount = await db.set(User).count();
```

> **Scope**: structured filters apply to `toList()`, `find()`, `where()`
> chains, aggregates (`count`/`sum`/`average`/`min`/`max`), and `select()`
> projections. `groupBy()` queries and raw SQL are not rewritten — raw SQL
> results are filtered in memory instead.

### Bypassing Query Filters

Use `ignoreQueryFilters()` to bypass global filters when needed:

```typescript
// Get ALL users, including deleted ones
const allUsers = await db.set(User)
    .ignoreQueryFilters()
    .toList();

// Useful for admin interfaces or data recovery
const deletedUsers = await db.set(User)
    .ignoreQueryFilters()
    .where('isDeleted', '=', true)
    .toList();

// To bypass filters for a primary-key lookup, use a where() chain
const user = await db.set(User)
    .ignoreQueryFilters()
    .where('id', '=', 1)
    .first(); // Returns the user even if soft-deleted
```

### Use Cases

**Soft Deletes:**
```typescript
@Entity("users")
export class User {
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column() isDeleted!: boolean;
    @Column() deletedAt?: Date;
}

modelBuilder.entity(User)
    .hasQueryFilter({ property: 'isDeleted', operator: '=', value: false });

// In your code:
const user = await users.find(1);
user.isDeleted = true;
user.deletedAt = new Date();
await db.saveChanges(); // User is "soft deleted"

// Regular queries won't return deleted users
const activeUsers = await users.toList(); // Excludes soft-deleted users
```

**Multi-Tenancy:**
```typescript
export class AppDbContext extends DbContext {
    constructor(provider: IDatabaseProvider, private tenantId: string) {
        super(provider);
    }

    protected onModelCreating(modelBuilder: ModelBuilder): void {
        modelBuilder.entity(Order)
            .hasQueryFilter({ property: 'tenantId', operator: '=', value: () => this.tenantId });

        modelBuilder.entity(Customer)
            .hasQueryFilter({ property: 'tenantId', operator: '=', value: () => this.tenantId });
    }
}

// Each tenant only sees their own data
const db = new AppDbContext(provider, 'tenant-123');
const orders = await db.set(Order).toList(); // Only returns tenant-123's orders
```

## Value Converters

Value converters allow you to transform values between their entity representation (TypeScript) and database representation (SQL), enabling complex type mappings and data transformations.

### Defining Value Converters

Use `hasConversion()` in your `onModelCreating()` method:

```typescript
protected onModelCreating(modelBuilder: ModelBuilder): void {
    // Convert JSON object to string for storage
    modelBuilder.entity(User)
        .property(u => u.preferences)
        .hasConversion(
            // To database: serialize object to JSON string
            (value: any) => JSON.stringify(value),
            // From database: parse JSON string to object
            (value: string) => JSON.parse(value)
        );

    // Convert boolean to integer (0/1)
    modelBuilder.entity(Product)
        .property(p => p.isActive)
        .hasConversion(
            (value: boolean) => value ? 1 : 0,
            (value: number) => value === 1
        );

    // Encrypt sensitive data
    modelBuilder.entity(User)
        .property(u => u.ssn)
        .hasConversion(
            (value: string) => encrypt(value),
            (value: string) => decrypt(value)
        );

    // Convert enums to strings
    modelBuilder.entity(Order)
        .property(o => o.status)
        .hasConversion(
            (value: OrderStatus) => OrderStatus[value],
            (value: string) => OrderStatus[value as keyof typeof OrderStatus]
        );
}
```

### Automatic Conversion

Conversions are **automatically applied** when reading from or writing to the database:

```typescript
// When saving
const user = new User();
user.preferences = { theme: 'dark', notifications: true };
users.add(user);
await db.saveChanges();
// Database stores: '{"theme":"dark","notifications":true}'

// When querying
const loadedUser = await users.find(1);
console.log(loadedUser.preferences); // { theme: 'dark', notifications: true }
// Automatically converted from JSON string to object
```

### Common Conversion Patterns

**JSON Serialization:**
```typescript
modelBuilder.entity(Product)
    .property(p => p.metadata)
    .hasColumnType('text')
    .hasConversion(
        (value: any) => JSON.stringify(value),
        (value: string) => JSON.parse(value || '{}')
    );
```

**Date Formatting:**
```typescript
modelBuilder.entity(Event)
    .property(e => e.scheduledDate)
    .hasConversion(
        (value: Date) => value.toISOString(),
        (value: string) => new Date(value)
    );
```

**Array Storage:**
```typescript
modelBuilder.entity(User)
    .property(u => u.tags)
    .hasConversion(
        (value: string[]) => value.join(','),
        (value: string) => value ? value.split(',') : []
    );
```

**Custom Objects:**
```typescript
class Address {
    constructor(public street: string, public city: string, public zip: string) {}
}

modelBuilder.entity(User)
    .property(u => u.address)
    .hasConversion(
        (value: Address) => `${value.street}|${value.city}|${value.zip}`,
        (value: string) => {
            const [street, city, zip] = value.split('|');
            return new Address(street, city, zip);
        }
    );
```

## Shadow Properties

Shadow properties are database columns that don't have corresponding properties on your entity class. They're useful for database-managed metadata like timestamps, audit fields, or computed values that you don't want to expose in your entity model.

### Defining Shadow Properties

Use `shadowProperty()` in your `onModelCreating()` method:

```typescript
protected onModelCreating(modelBuilder: ModelBuilder): void {
    modelBuilder.entity(User)
        // Timestamp shadow properties
        .shadowProperty('created_at', 'timestamp', {
            defaultValue: 'CURRENT_TIMESTAMP'
        })
        .shadowProperty('updated_at', 'timestamp', {
            defaultValue: 'CURRENT_TIMESTAMP'
        })
        // Audit shadow properties
        .shadowProperty('created_by_id', 'integer', {
            nullable: true
        })
        .shadowProperty('row_version', 'integer', {
            defaultValue: 1
        });

    modelBuilder.entity(Product)
        // Custom column name
        .shadowProperty('internal_id', 'varchar(50)', {
            columnName: 'internal_product_id',
            nullable: false
        });
}
```

### Shadow Property Behavior

**Not Mapped to Entity:**
```typescript
@Entity("users")
export class User {
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column() email!: string;
    // Note: NO created_at or updated_at properties!
}

// But the database has these columns:
// CREATE TABLE users (
//     id INTEGER PRIMARY KEY,
//     name TEXT,
//     email TEXT,
//     created_at TIMESTAMP,
//     updated_at TIMESTAMP
// );
```

**Current Behavior:**
- Shadow properties are **included in CREATE TABLE** statements as plain columns
- Their `defaultValue` is sent as a **literal parameter value in INSERT statements** — it is *not* emitted as a DDL `DEFAULT` clause
- They're **excluded from entity mapping** (not set on TypeScript objects)

> **Limitation**: Because defaults are bound as parameter values, SQL expressions like `'CURRENT_TIMESTAMP'` or `'NOW()'` are inserted as literal strings and will fail or store the wrong value on real databases. Use **constant defaults only** (numbers, strings, booleans) with shadow properties for now. DDL `DEFAULT` clause support is planned.

### Use Cases

**Audit Timestamps:**
```typescript
modelBuilder.entity(Order)
    .shadowProperty('created_at', 'timestamp', {
        defaultValue: 'CURRENT_TIMESTAMP'
    })
    .shadowProperty('updated_at', 'timestamp', {
        defaultValue: 'CURRENT_TIMESTAMP'
    });
```

**Database-Level Metadata:**
```typescript
modelBuilder.entity(Document)
    .shadowProperty('db_created_at', 'timestamp', {
        defaultValue: 'NOW()'
    })
    .shadowProperty('db_last_modified', 'timestamp', {
        defaultValue: 'NOW()'
    })
    .shadowProperty('db_version', 'integer', {
        defaultValue: 1
    });
```

**Soft Delete with Timestamp:**
```typescript
modelBuilder.entity(User)
    .shadowProperty('deleted_at', 'timestamp', {
        nullable: true
    })
    .hasQueryFilter(u => !u.isDeleted);
```

### When to Use Shadow Properties

✅ **Use shadow properties when:**
- Database needs columns that your application doesn't use
- Implementing database-level audit trails
- Working with legacy databases with extra columns
- Database-managed timestamps or versioning
- Columns are purely for database constraints or triggers

❌ **Don't use shadow properties when:**
- Your application needs to read or modify the values
- The data is part of your business logic
- You need to query or filter by these values from TypeScript

## Bulk Operations

For better performance when working with multiple entities, rnxORM provides bulk operation methods that track multiple entities at once.

### AddRange - Bulk Insert

Add multiple entities in a single operation:

```typescript
const newUsers = [
    { name: 'Alice', email: 'alice@example.com', age: 25 },
    { name: 'Bob', email: 'bob@example.com', age: 30 },
    { name: 'Charlie', email: 'charlie@example.com', age: 35 }
].map(data => {
    const user = new User();
    Object.assign(user, data);
    return user;
});

// Add all users at once
users.addRange(newUsers);
await db.saveChanges(); // INSERT all users in a single transaction

console.log(`Inserted ${newUsers.length} users`);
```

### UpdateRange - Bulk Update

Update multiple entities in a single operation:

```typescript
// Load users
const usersToUpdate = await users.where('age', '<', 18).toList();

// Modify them
usersToUpdate.forEach(user => {
    user.status = 'minor';
});

// Update all at once
users.updateRange(usersToUpdate);
await db.saveChanges(); // UPDATE all users in a single transaction
```

### RemoveRange - Bulk Delete

Delete multiple entities in a single operation:

```typescript
// Load users to delete
const inactiveUsers = await users.where('lastLogin', '<', oldDate).toList();

// Delete all at once
users.removeRange(inactiveUsers);
await db.saveChanges(); // DELETE all users in a single transaction

console.log(`Deleted ${inactiveUsers.length} inactive users`);
```

### Benefits of Bulk Operations

- **Better Performance**: Reduce overhead of tracking entities individually
- **Atomic Operations**: All changes in a single transaction
- **Cleaner Code**: More readable than loops with individual operations
- **Memory Efficient**: Batch processing for large datasets

## Raw SQL Queries

When you need to execute complex SQL that can't be expressed through the fluent API, rnxORM provides raw SQL query support with full entity mapping.

### FromSqlRaw - Query Entities

Execute raw SQL and map results to entity types.

> **Placeholder syntax is provider-specific** — rnxORM does not translate placeholders in raw SQL. Use `$1, $2, ...` for PostgreSQL (as in the examples below), `@p0, @p1, ...` for SQL Server, and `?` for MariaDB/MySQL.

```typescript
// Simple raw query
const adults = await db.set(User)
    .fromSqlRaw('SELECT * FROM users WHERE age >= 18')
    .toList();

// Parameterized query (safe from SQL injection)
const activeUsers = await db.set(User)
    .fromSqlRaw(
        'SELECT * FROM users WHERE status = $1 AND created_at > $2',
        ['active', '2024-01-01']
    )
    .toList();

// Complex join query
const userOrders = await db.set(User)
    .fromSqlRaw(`
        SELECT u.*
        FROM users u
        INNER JOIN orders o ON u.id = o.user_id
        WHERE o.total > $1
        GROUP BY u.id
        HAVING COUNT(o.id) > $2
    `, [1000, 5])
    .toList();

// Get first result
const topUser = await db.set(User)
    .fromSqlRaw('SELECT * FROM users ORDER BY points DESC LIMIT 1')
    .first();
```

### ExecuteSqlRaw - Non-Query Operations

Execute UPDATE, DELETE, or other SQL statements and get the affected row count:

```typescript
// Bulk update with raw SQL
const updated = await db.executeSqlRaw(
    'UPDATE users SET status = $1 WHERE last_login < $2',
    ['inactive', '2020-01-01']
);
console.log(`Updated ${updated} users`);

// Bulk delete
const deleted = await db.executeSqlRaw(
    'DELETE FROM logs WHERE created_at < $1',
    ['2023-01-01']
);
console.log(`Deleted ${deleted} log entries`);

// Call stored procedure
await db.executeSqlRaw('CALL refresh_materialized_views()');

// Execute database maintenance
await db.executeSqlRaw('VACUUM ANALYZE users');
```

### Query Filters with Raw SQL

Global query filters are automatically applied to raw SQL results:

```typescript
// If User has a soft delete filter
modelBuilder.entity(User)
    .hasQueryFilter(u => !u.isDeleted);

// This query automatically excludes deleted users
const users = await db.set(User)
    .fromSqlRaw('SELECT * FROM users WHERE age > $1', [18])
    .toList(); // Deleted users are filtered out

// Bypass filters if needed
const allUsers = await db.set(User)
    .fromSqlRaw('SELECT * FROM users')
    .toListNoTracking(); // No filters, no tracking
```

### When to Use Raw SQL

✅ **Use raw SQL when:**
- Executing complex joins not supported by fluent API
- Calling database-specific functions (window functions, CTEs, etc.)
- Performance-critical queries requiring fine-tuned SQL
- Working with database views or stored procedures
- Bulk operations that are more efficient in SQL

⚠️ **Important Notes:**
- Always use parameterized queries to prevent SQL injection
- Column names in raw SQL should match database column names (not property names)
- Results are still subject to global query filters (unless using `toListNoTracking()`)
- Value converters are applied to results

## Keyless Entity Types

Keyless entity types are entities without a primary key, perfect for mapping to database views, query results, or read-only data.

### Defining Keyless Entities

Use `hasNoKey()` to mark an entity as keyless:

```typescript
// Entity for database view
@Entity("vw_user_summary")
export class UserSummary {
    @Column() userName!: string;
    @Column() orderCount!: number;
    @Column() totalSpent!: number;
    @Column() lastOrderDate!: Date;
}

// Configure as keyless
export class AppDbContext extends DbContext {
    protected onModelCreating(modelBuilder: ModelBuilder): void {
        modelBuilder.entity(UserSummary)
            .hasNoKey()
            .toTable('vw_user_summary'); // Maps to database view
    }
}
```

### Querying Keyless Entities

Keyless entities work just like regular entities:

```typescript
// Query the view
const summaries = await db.set(UserSummary).toList();

// Filter results
const bigSpenders = await db.set(UserSummary)
    .where('totalSpent', '>', 10000)
    .orderByDescending('totalSpent')
    .toList();

// Raw SQL with keyless entities
const topSummaries = await db.set(UserSummary)
    .fromSqlRaw(`
        SELECT * FROM vw_user_summary
        WHERE order_count > $1
        ORDER BY total_spent DESC
        LIMIT 10
    `, [5])
    .toList();
```

### Use Cases for Keyless Entities

**Database Views:**
```typescript
@Entity("vw_product_inventory")
export class ProductInventory {
    @Column() productName!: string;
    @Column() categoryName!: string;
    @Column() stockLevel!: number;
    @Column() reorderPoint!: number;
    @Column() needsReorder!: boolean;
}

modelBuilder.entity(ProductInventory)
    .hasNoKey()
    .toTable('vw_product_inventory');
```

**Stored Procedure Results:**
```typescript
@Entity("sp_sales_report")
export class SalesReport {
    @Column() month!: string;
    @Column() revenue!: number;
    @Column() expenses!: number;
    @Column() profit!: number;
}

modelBuilder.entity(SalesReport)
    .hasNoKey();

// Query stored procedure
const report = await db.set(SalesReport)
    .fromSqlRaw('SELECT * FROM sp_get_monthly_sales($1, $2)', [2024, 1])
    .toList();
```

**Ad-hoc Query Results:**
```typescript
@Entity("order_statistics")
export class OrderStatistics {
    @Column() customerId!: number;
    @Column() totalOrders!: number;
    @Column() avgOrderValue!: number;
    @Column() firstOrder!: Date;
    @Column() lastOrder!: Date;
}

modelBuilder.entity(OrderStatistics)
    .hasNoKey();

const stats = await db.set(OrderStatistics)
    .fromSqlRaw(`
        SELECT
            customer_id,
            COUNT(*) as total_orders,
            AVG(total) as avg_order_value,
            MIN(created_at) as first_order,
            MAX(created_at) as last_order
        FROM orders
        GROUP BY customer_id
    `)
    .toList();
```

### Important Notes

- **Read-Only**: Keyless entities cannot be inserted, updated, or deleted
- **No Identity**: Cannot use `.find()` (no primary key to search by)
- **Change Tracking**: Keyless entities are not tracked by default
- **Views**: Perfect for mapping to database views that aggregate data
- **Performance**: No overhead from primary key constraints or identity checks

## Owned Entity Types *(Planned)*

> **Note**: `ownsOne()` and `ownsMany()` currently only **store configuration metadata — they have no runtime effect yet**. No flattened columns are added to the owner's table, no separate table is created for owned collections, and owned objects are not persisted or hydrated. The documentation below describes the planned design. Until it ships, model value objects as regular columns (e.g. with a JSON value converter via `hasConversion()`).

Owned entity types are entities that don't have their own identity and are always accessed through their owner entity. They're perfect for value objects like addresses, money, or other complex types that belong to a parent entity.

### OwnsOne - Single Owned Entity

Use `ownsOne()` to configure a single owned entity that is stored inline in the owner's table:

```typescript
// Owned entity type (value object)
export class Address {
    street!: string;
    city!: string;
    state!: string;
    zipCode!: string;
}

@Entity("orders")
export class Order {
    @PrimaryKey() id!: number;
    @Column() customerName!: string;

    // This will be stored inline in the orders table
    shippingAddress!: Address;
    billingAddress!: Address;
}

// Configure owned entities
export class AppDbContext extends DbContext {
    protected onModelCreating(modelBuilder: ModelBuilder): void {
        modelBuilder.entity(Order)
            .ownsOne(o => o.shippingAddress, Address, { columnPrefix: 'Shipping' })
            .ownsOne(o => o.billingAddress, Address, { columnPrefix: 'Billing' });
    }
}

// Database schema result:
// CREATE TABLE orders (
//     id INTEGER PRIMARY KEY,
//     customer_name TEXT,
//     ShippingStreet TEXT,
//     ShippingCity TEXT,
//     ShippingState TEXT,
//     ShippingZipCode TEXT,
//     BillingStreet TEXT,
//     BillingCity TEXT,
//     BillingState TEXT,
//     BillingZipCode TEXT
// );
```

### OwnsMany - Owned Entity Collection

Use `ownsMany()` for collections of owned entities stored in a separate table:

```typescript
export class OrderItem {
    productName!: string;
    quantity!: number;
    price!: number;
}

@Entity("orders")
export class Order {
    @PrimaryKey() id!: number;
    @Column() customerName!: string;

    // Owned collection stored in separate table
    items!: OrderItem[];
}

protected onModelCreating(modelBuilder: ModelBuilder): void {
    modelBuilder.entity(Order)
        .ownsMany(o => o.items, OrderItem);
}
```

### Working with Owned Entities

```typescript
// Create order with owned entities
const order = new Order();
order.customerName = 'John Doe';
order.shippingAddress = {
    street: '123 Main St',
    city: 'Springfield',
    state: 'IL',
    zipCode: '62701'
};
order.billingAddress = {
    street: '456 Oak Ave',
    city: 'Chicago',
    state: 'IL',
    zipCode: '60601'
};

orders.add(order);
await db.saveChanges();

// Query returns fully populated owned entities
const loadedOrder = await orders.find(1);
console.log(loadedOrder.shippingAddress.city); // 'Springfield'
```

### When to Use Owned Entities

✅ **Use owned entities for:**
- Value objects without identity (Address, Money, DateRange, etc.)
- Complex types that always belong to a parent
- Data that should never be shared between entities
- Avoiding extra tables for simple related data

❌ **Don't use owned entities for:**
- Entities that have their own identity
- Data that might be shared across multiple parents
- Entities that need independent queries

## Explicit Loading *(Planned)*

> **Note**: Explicit loading is planned for a future release. The API surface is defined but currently throws a "not implemented" error. Use eager loading (`.include()`) for now.

Explicit loading will allow you to load related entities on-demand after the initial query, giving you fine-grained control over when related data is fetched.

### Loading Reference Navigation Properties

Load a single related entity using `reference()`:

```typescript
// Load order without related entities
const order = await orders.find(1);

// Later, explicitly load the customer
const orderEntry = db.entry(order);
await orderEntry.reference(o => o.customer).load();

// Now customer is loaded
console.log(order.customer.name);
```

### Loading Collection Navigation Properties

Load a collection of related entities using `collection()`:

```typescript
// Load user without orders
const user = await users.find(1);

// Later, explicitly load the orders collection
const userEntry = db.entry(user);
await userEntry.collection(u => u.orders).load();

// Now orders are loaded
console.log(`User has ${user.orders.length} orders`);
```

### Check if Loaded

Check whether a navigation property is already loaded:

```typescript
const userEntry = db.entry(user);
const ordersLoader = userEntry.collection(u => u.orders);

if (!ordersLoader.isLoaded()) {
    await ordersLoader.load();
}
```

### Explicit Loading vs Eager Loading

**Eager Loading (Include):**
```typescript
// Loads everything upfront
const users = await db.set(User)
    .include(u => u.orders)
    .include(u => u.profile)
    .toList();
```

**Explicit Loading:**
```typescript
// Load selectively based on business logic
const users = await db.set(User).toList();

for (const user of users) {
    if (user.isActive) {
        // Only load orders for active users
        await db.entry(user).collection(u => u.orders).load();
    }
}
```

### When to Use Explicit Loading

✅ **Use explicit loading when:**
- You need conditional loading based on business logic
- Loading related data for only some entities
- Optimizing queries by loading data on-demand
- Avoiding N+1 queries while maintaining control

🔄 **Compare with:**
- **Eager Loading**: Load everything upfront (use `.include()`)
- **Lazy Loading**: Automatic on-access loading (not yet implemented in rnxORM)

## Concurrency Tokens

Concurrency tokens enable optimistic concurrency control, preventing lost updates when multiple users modify the same entity simultaneously.

### Configuring Concurrency Tokens

Mark a property as a concurrency token using `isConcurrencyToken()`:

```typescript
@Entity("products")
export class Product {
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column() price!: number;
    @Column() quantity!: number;
    @Column() rowVersion!: number; // Concurrency token
}

protected onModelCreating(modelBuilder: ModelBuilder): void {
    modelBuilder.entity(Product)
        .property(p => p.rowVersion)
        .hasDefaultValue(1)
        .isConcurrencyToken();
}
```

### How It Works

When you update an entity with a concurrency token:

1. **Load entity**: rowVersion = 5
2. **Modify entity**: Change price, rowVersion still 5
3. **Save changes**:
   - UPDATE products SET price = $1, rowVersion = 6 WHERE id = $2 AND rowVersion = 5
   - If another user already updated (rowVersion ≠ 5), update fails
   - Token automatically incremented to 6 on success

### Handling Concurrency Conflicts

```typescript
try {
    const product = await products.find(1);
    product.price = 99.99;
    await db.saveChanges();
    // Success - product.rowVersion is now incremented
} catch (error) {
    if (error.message.includes('Concurrency violation')) {
        // Another user modified the entity
        console.log('Product was modified by another user');

        // Reload to get latest version
        const freshProduct = await products.find(1);
        // Retry or merge changes
    }
}
```

### Timestamp-Based Concurrency

Use database timestamps for automatic concurrency control:

```typescript
protected onModelCreating(modelBuilder: ModelBuilder): void {
    modelBuilder.entity(Order)
        .shadowProperty('last_modified', 'timestamp', {
            defaultValue: 'CURRENT_TIMESTAMP'
        })
        .property(o => o.lastModified)
        .hasColumnName('last_modified')
        .isConcurrencyToken();
}
```

### Best Practices

✅ **Use concurrency tokens when:**
- Multiple users can edit the same data
- Preventing lost updates is critical
- Implementing optimistic locking
- Building collaborative applications

**Common Token Types:**
- **Integer counter**: Simple, auto-incrementing (rowVersion = 1, 2, 3...)
- **Timestamp**: Database-managed modification time
- **GUID**: Unique identifier generated on each update

**Handling Conflicts:**
1. **Client Wins**: Overwrite with user's changes (dangerous)
2. **Store Wins**: Reload and discard user changes
3. **Merge**: Combine both versions (most complex, most flexible)

```typescript
// Example: Store Wins strategy
async function updateWithRetry(product: Product, changes: Partial<Product>) {
    let retries = 3;
    while (retries > 0) {
        try {
            Object.assign(product, changes);
            await db.saveChanges();
            return; // Success
        } catch (error) {
            if (error.message.includes('Concurrency violation')) {
                // Reload and retry
                const fresh = await products.find(product.id);
                Object.assign(product, fresh);
                retries--;
            } else {
                throw error;
            }
        }
    }
    throw new Error('Failed to update after multiple retries');
}
```

## Query Optimization

### AsNoTracking

For read-only queries, use `asNoTracking()` to improve performance. Entities returned from no-tracking queries are not registered in the change tracker, so modifying them has no effect on `saveChanges()`.

> **Note**: No-tracking entities are ordinary mutable objects — they are *not* frozen. Modifications simply won't be persisted.

```typescript
// Read-only query - entities are not tracked
const products = await productSet.asNoTracking().toList();

// Modifying them is allowed but changes are NOT saved
products[0].price = 999; // no error, but saveChanges() ignores this

// Can be combined with where clauses
const expensiveProducts = await productSet
  .asNoTracking()
  .where("price", ">", 100)
  .toList();

// Or chain in different order
const affordableProducts = await productSet
  .where("price", "<=", 50)
  .asNoTracking()
  .toList();
```

**When to use AsNoTracking:**
- Displaying read-only lists
- Generating reports
- Bulk data export
- Any query where you won't modify the results

### Find by Primary Key

Quickly retrieve a single entity by its primary key value:

```typescript
// Find by ID
const user = await users.find(42);
if (user) {
  console.log(user.name);
} else {
  console.log("User not found");
}

// find() returns null if not found
const notFound = await users.find(99999); // null
```

## Schema Evolution

rnxORM supports basic schema evolution to keep your database in sync with your TypeScript entities.

### Adding Columns

If you add a new property to your entity, `ensureCreated()` will detect the missing column in the database and automatically add it using `ALTER TABLE ... ADD COLUMN`.

```typescript
// Old Entity
@Entity("users")
class User {
  @PrimaryKey() id!: number;
  @Column() name!: string;
}

// New Entity (after restart)
@Entity("users")
class User {
  @PrimaryKey() id!: number;
  @Column() name!: string;
  @Column() email!: string; // This column will be added automatically
}
```

### Type Migration

If you change the type of a property (e.g., from `string` to `number`), rnxORM attempts to migrate the column type safely.

1.  **Detection**: It checks if the database column type matches the TypeScript type.
2.  **Auto-Fix**: It attempts to migrate the column using `ALTER COLUMN ... TYPE ... USING ...`.
3.  **Safety**: If the existing data is incompatible with the new type (e.g., converting "abc" to integer), the migration **fails gracefully** and the column is left unchanged to prevent data loss.

## Migrations

rnxORM provides a powerful migration system for versioning and managing database schema changes over time, similar to Entity Framework Core migrations.

### Why Use Migrations?

While `ensureCreated()` is great for development, migrations provide:
- **Version Control**: Track schema changes in your codebase
- **Collaboration**: Share database changes with your team
- **Production Safety**: Apply changes incrementally with rollback capability
- **History**: Maintain a complete audit trail of schema evolution

### Creating a Migration

Use the CLI to generate a new migration file:

```bash
npx rnxorm migration:create add-users-table
```

To apply migrations you can use the CLI with a config file (see
[Running Migrations from the CLI](#running-migrations-from-the-cli)) or the
`Migrator` API in a script (see [Running Migrations](#running-migrations)).

This creates a timestamped migration file in the `migrations/` directory:

```typescript
import { Migration, MigrationBuilder } from "rnxorm";

export class AddUsersTable extends Migration {
    constructor() {
        super("20240115120000", "add-users-table");
    }

    async up(builder: MigrationBuilder): Promise<void> {
        builder.createTable('users', [
            { name: 'id', type: 'integer', isPrimaryKey: true, isAutoIncrement: true },
            { name: 'email', type: 'varchar(255)', nullable: false },
            { name: 'name', type: 'varchar(100)', nullable: false },
            { name: 'created_at', type: 'timestamp', defaultValue: 'CURRENT_TIMESTAMP' }
        ]);
    }

    async down(builder: MigrationBuilder): Promise<void> {
        builder.dropTable('users');
    }
}
```

### Migration Builder API

The `MigrationBuilder` provides a fluent API for schema operations:

**Table Operations:**
```typescript
// Create table
builder.createTable('products', [
    { name: 'id', type: 'integer', isPrimaryKey: true, isAutoIncrement: true },
    { name: 'name', type: 'varchar(255)', nullable: false },
    { name: 'price', type: 'decimal(10,2)', nullable: false }
]);

// Drop table
builder.dropTable('products');

// Rename table
builder.renameTable('products', 'items');
```

**Column Operations:**
```typescript
// Add column
builder.addColumn('users', 'phone', 'varchar(20)', { nullable: true });

// Drop column
builder.dropColumn('users', 'phone');

// Alter column
builder.alterColumn('users', 'email', 'varchar(320)', { nullable: false });

// Rename column
builder.renameColumn('users', 'name', 'full_name');
```

**Index Operations:**
```typescript
// Create index
builder.createIndex('users', 'idx_users_email', ['email'], true); // unique

// Create composite index
builder.createIndex('orders', 'idx_orders_user_date', ['user_id', 'order_date']);

// Drop index
builder.dropIndex('users', 'idx_users_email');
```

**Foreign Key Operations:**
```typescript
// Add foreign key
builder.addForeignKey(
    'posts',              // table
    'fk_posts_user',      // constraint name
    'author_id',          // column
    'users',              // referenced table
    'id',                 // referenced column
    'CASCADE'             // on delete action
);

// Drop foreign key
builder.dropForeignKey('posts', 'fk_posts_user');
```

**Raw SQL:**
```typescript
// Execute custom SQL
builder.sql('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
builder.sql('UPDATE users SET status = $1 WHERE created_at < $2', ['inactive', new Date()]);
```

### Running Migrations from the CLI

`migration:run`, `migration:revert`, and `migration:status` load a config
module — `rnxorm.config.js` in the working directory by default, or any path
passed via `--config` — that exports a `createMigrator()` factory:

```javascript
// rnxorm.config.js
const { DbContext, PostgreSQLProvider, Migrator } = require('rnxorm');
const migrations = require('./dist/migrations');

module.exports = {
    async createMigrator() {
        const context = new DbContext(new PostgreSQLProvider({
            host: 'localhost',
            port: 5432,
            user: 'postgres',
            password: process.env.DB_PASSWORD,
            database: 'mydb',
        }));
        await context.connect();

        const migrator = new Migrator(context);
        migrator.addMigrations(Object.values(migrations).map(M => new M()));
        return migrator;
    },
};
```

Then:

```bash
npx rnxorm migration:run                              # apply all pending migrations
npx rnxorm migration:revert                           # revert the last applied migration
npx rnxorm migration:status                           # show applied and pending migrations
npx rnxorm migration:run --config ./config/orm.js     # use a custom config path
```

A TypeScript config (`rnxorm.config.ts`) also works when `ts-node` is
installed in the project. The CLI disconnects the context when the command
finishes and exits non-zero on failure.

### Running Migrations

Alternatively, create a migration runner script (e.g., `migrate.ts`):

```typescript
import { DbContext, PostgreSQLProvider, Migrator } from "rnxorm";
import { AddUsersTable } from "./migrations/20240115120000_add-users-table";
import { CreatePostsTable } from "./migrations/20240115130000_create-posts-table";

async function runMigrations() {
    const db = new DbContext(new PostgreSQLProvider({
        host: "localhost",
        port: 5432,
        user: "postgres",
        password: "password",
        database: "mydb",
    }));

    await db.connect();

    const migrator = new Migrator(db);
    migrator.addMigrations([
        new AddUsersTable(),
        new CreatePostsTable()
    ]);

    // Apply all pending migrations
    await migrator.migrate();

    // Or check status
    // await migrator.status();

    // Or revert last migration
    // await migrator.revert();

    await db.disconnect();
}

runMigrations().catch(console.error);
```

Run it:
```bash
npx ts-node migrate.ts
```

### Migration Commands

**Check Migration Status:**
```typescript
await migrator.status();
```

Output:
```
=== Migration Status ===

Applied Migrations:
  ✓ 20240115120000_add-users-table (applied: 2024-01-15T12:00:00.000Z)
  ✓ 20240115130000_create-posts-table (applied: 2024-01-15T13:00:00.000Z)

Pending Migrations:
  ○ 20240115140000_add-comments-table
```

**Apply Pending Migrations:**
```typescript
const count = await migrator.migrate();
console.log(`Applied ${count} migrations`);
```

**Revert Last Migration:**
```typescript
const reverted = await migrator.revert();
if (reverted) {
    console.log('Migration reverted successfully');
}
```

**Revert to Specific Migration:**
```typescript
// Revert all migrations back to and including this one
await migrator.revertTo('20240115120000');
```

### Migration History

rnxORM automatically creates a `__MigrationHistory` table to track applied migrations:

| migration_id      | migration_name          | applied_at            |
|------------------|-------------------------|-----------------------|
| 20240115120000   | add-users-table        | 2024-01-15 12:00:00  |
| 20240115130000   | create-posts-table     | 2024-01-15 13:00:00  |

### Best Practices

1. **Always include down() logic**: Ensure every migration can be reverted
2. **Test migrations**: Test both up() and down() before deploying
3. **Small migrations**: Keep migrations focused on single changes
4. **Never modify applied migrations**: Create new migrations for changes
5. **Backup before migrating**: Always backup production databases first
6. **Use transactions**: Migrations are automatically wrapped in transactions

### Migration vs ensureCreated()

| Feature | ensureCreated() | Migrations |
|---------|----------------|------------|
| **Use Case** | Development/prototyping | Production |
| **Version Control** | No | Yes |
| **Rollback** | No | Yes |
| **Team Collaboration** | Limited | Full |
| **Audit Trail** | No | Yes |
| **Custom Logic** | No | Yes (via SQL) |

**Recommendation**: Use `ensureCreated()` during early development, switch to migrations before production.

## FAQ

### What is handled automatically?
-   **Creating Tables**: If a table doesn't exist, it is created.
-   **Adding Columns**: If a column is missing, it is added.
-   **Changing Types**: If a type changes (and data is compatible), it is updated.

### What is NOT handled?
-   **Renaming Columns**: If you rename a property, rnxORM sees it as a "missing" column (the new name) and adds it. The old column remains in the database. It does **not** rename the existing column.
-   **Deleting Columns**: If you remove a property from your class, the column remains in the database. rnxORM does **not** delete columns to prevent accidental data loss.
-   **Data Migrations**: Complex data transformations during schema changes must be handled manually.

## Custom Database Providers

You can create a custom database provider by implementing the `IDatabaseProvider` interface. Every provider must implement `getDialect()` which returns a string identifier used internally for dialect-specific SQL generation (e.g., pagination, migrations).

```typescript
import { IDatabaseProvider } from "rnxorm";

class SQLiteProvider implements IDatabaseProvider {
    getDialect(): string {
        return 'sqlite'; // Used for dialect-specific SQL branches
    }
    // ... implement remaining interface methods
}
```

Built-in dialect identifiers: `'postgresql'`, `'mssql'`, `'mariadb'`.

### Testing with MetadataStorage.reset()

When writing tests, use `MetadataStorage.reset()` to clear all registered entity metadata between test cases, ensuring test isolation:

```typescript
import { MetadataStorage } from "rnxorm";

beforeEach(() => {
    MetadataStorage.reset();
});
```

## Repository

- **GitHub**: [https://github.com/BaryoDev/rnxORM](https://github.com/BaryoDev/rnxORM)
- **npm**: [https://www.npmjs.com/package/rnxorm](https://www.npmjs.com/package/rnxorm)
- **Issues**: [https://github.com/BaryoDev/rnxORM/issues](https://github.com/BaryoDev/rnxORM/issues)

## License

MPL-2.0
