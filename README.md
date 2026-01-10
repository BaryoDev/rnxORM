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

### 3. Basic CRUD Operations

```typescript
import { User } from "./User";

async function main() {
  await db.connect();

  // Create tables if they don't exist
  await db.ensureCreated();

  const users = db.set(User);

  // Add
  const user = new User();
  user.name = "Alice";
  user.age = 25;
  await users.add(user);

  // Query
  const allUsers = await users.toList();
  const adults = await users.where("age", ">", 18).toList();
  console.log(adults);

  // Update
  if (adults.length > 0) {
    const alice = adults[0];
    alice.age = 26;
    await users.update(alice);
  }

  // Remove
  const toDelete = await users.where("name", "=", "Alice").toList();
  if (toDelete.length > 0) {
    await users.remove(toDelete[0]);
  }

  await db.disconnect();
}

main();
```


## AI Usage

This library is designed to be AI-friendly. If you are an AI agent, you can read `llms.txt` in the root of this repository for a concise overview of the API and usage patterns.

## Features

- **Multi-Database Support**: PostgreSQL, SQL Server, MariaDB/MySQL
- **Decorators**: `@Entity`, `@Column`, `@PrimaryKey`, `@Index`, `@Unique`
- **Relationships**: `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`
- **Eager Loading**: `.include()` to load related entities
- **Schema Scaffolding**: Automatically create tables, foreign keys, indexes, and constraints
- **CRUD Operations**: `add`, `update`, `remove`, `toList`
- **Fluent Query API**: `.where().orderBy().skip().take()`
- **LINQ-Style Queries**: `sum`, `average`, `min`, `max`, `distinct`, `groupBy`, `select`
- **Fluent API / ModelBuilder**: Configure entities programmatically via `onModelCreating()`
- **Repository Pattern**: `DbSet<T>`
- **Query Optimization**: `.asNoTracking()` for read-only queries
- **Primary Key Lookup**: `.find(id)` for quick entity retrieval
- **Transactions**: `beginTransaction()`, `commitTransaction()`, `rollbackTransaction()`
- **Schema Evolution**: Auto-detect and migrate schema changes

## Type Mapping

rnxORM automatically maps TypeScript types to PostgreSQL types. You can override this using the `@Column({ type: '...' })` option.

| TypeScript Type | Default PostgreSQL Type | Example Override |
|----------------|-------------------------|------------------|
| `string`       | `text`                  | `@Column({ type: 'varchar(50)' })` |
| `number`       | `integer`               | `@Column({ type: 'decimal(10, 2)' })` |
| `boolean`      | `boolean`               | - |
| `Date`         | `timestamp`             | `@Column({ type: 'date' })` |

### Overriding Types

To use a specific database type, pass the `type` option to the `@Column` decorator:

```typescript
@Column({ type: "varchar(100)" })
email!: string;

@Column({ type: "decimal(10, 2)" })
price!: number;
```

## Query Operators

The `.where(column, operator, value)` method supports standard SQL operators:

- `=`: Equal to
- `!=` or `<>`: Not equal to
- `>`: Greater than
- `<`: Less than
- `>=`: Greater than or equal to
- `<=`: Less than or equal to
- `LIKE`: Pattern matching (case-sensitive)
- `ILIKE`: Pattern matching (case-insensitive)

```typescript
// Examples
users.where("age", ">=", 21);
users.where("name", "ILIKE", "%doe%");
```

## Relationships

rnxORM supports all major relationship types with automatic foreign key generation and eager loading.

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

rnxORM provides a comprehensive LINQ-style API for querying data.

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

## Query Optimization

### AsNoTracking

For read-only queries, use `asNoTracking()` to improve performance. Entities returned from no-tracking queries are frozen (immutable), which prevents accidental modifications and signals to the runtime that these objects won't be updated.

```typescript
// Read-only query - entities are frozen for better performance
const products = await productSet.asNoTracking().toList();

// Attempting to modify will throw an error
products[0].price = 999; // ❌ Error: Cannot assign to read only property

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
2.  **Warning**: It logs a warning if a mismatch is found.
3.  **Auto-Fix**: It attempts to migrate the column using `ALTER COLUMN ... TYPE ... USING ...`.
4.  **Safety**: If the existing data is incompatible with the new type (e.g., converting "abc" to integer), the migration **fails gracefully**. An error is logged, and the column is left unchanged to prevent data loss.

## FAQ

### What is handled automatically?
-   **Creating Tables**: If a table doesn't exist, it is created.
-   **Adding Columns**: If a column is missing, it is added.
-   **Changing Types**: If a type changes (and data is compatible), it is updated.

### What is NOT handled?
-   **Renaming Columns**: If you rename a property, rnxORM sees it as a "missing" column (the new name) and adds it. The old column remains in the database. It does **not** rename the existing column.
-   **Deleting Columns**: If you remove a property from your class, the column remains in the database. rnxORM does **not** delete columns to prevent accidental data loss.
-   **Data Migrations**: Complex data transformations during schema changes must be handled manually.

## Repository

- **GitHub**: [https://github.com/BaryoDev/rnxORM](https://github.com/BaryoDev/rnxORM)
- **npm**: [https://www.npmjs.com/package/rnxorm](https://www.npmjs.com/package/rnxorm)
- **Issues**: [https://github.com/BaryoDev/rnxORM/issues](https://github.com/BaryoDev/rnxORM/issues)

## License

MPL-2.0
