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

- **Multi-Database Support**: PostgreSQL, SQL Server, MariaDB/MySQL
- **Change Tracking & SaveChanges()**: EF Core-style automatic change detection and batch persistence
- **Data Seeding**: Seed initial data via `hasData()` in ModelBuilder
- **Decorators**: `@Entity`, `@Column`, `@PrimaryKey`, `@Index`, `@Unique`
- **Relationships**: `@ManyToOne`, `@OneToMany`, `@ManyToMany`, `@OneToOne`
- **Eager Loading**: `.include()` to load related entities
- **Schema Scaffolding**: Automatically create tables, foreign keys, indexes, and constraints
- **Migrations**: Version-controlled database schema changes with rollback support
- **CRUD Operations**: `add`, `update`, `remove` with automatic tracking
- **Fluent Query API**: `.where().orderBy().skip().take()`
- **LINQ-Style Queries**: `sum`, `average`, `min`, `max`, `distinct`, `groupBy`, `select`
- **Fluent API / ModelBuilder**: Configure entities programmatically via `onModelCreating()`
- **Repository Pattern**: `DbSet<T>` with integrated change tracking
- **Default Values**: Set column defaults via `hasDefaultValue()`
- **Computed Columns**: Database-calculated columns via `hasComputedColumnSql()`
- **Query Optimization**: `.asNoTracking()` for read-only queries
- **Primary Key Lookup**: `.find(id)` for quick entity retrieval
- **Transactions**: Automatic transaction wrapping for `saveChanges()`
- **Schema Evolution**: Auto-detect and migrate schema changes
- **CLI Tools**: Generate migration files with `rnxorm` command

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
- **Logged**: Each seeded record is logged to console

```typescript
const db = new AppDbContext();
await db.connect();
await db.ensureCreated(); // Seeds data automatically

// Output:
// Creating tables...
// ...
// Seeding data...
//   Seeded users: {"id":1,"name":"Admin","email":"admin@example.com","role":"admin"}
//   Seeded users: {"id":2,"name":"User","email":"user@example.com","role":"user"}
//   Seeded categories: {"id":1,"name":"Electronics","slug":"electronics"}
// Database schema is up to date!
```

### Best Practices

1. **Always specify primary keys** in seed data for idempotency
2. **Use for reference data**: Categories, roles, default users, configuration
3. **Keep seed data small**: Large datasets should use migrations or separate scripts
4. **Version control**: Seed data is code, commit it with your model changes

## Default Values & Computed Columns

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

### Running Migrations

Create a migration runner script (e.g., `migrate.ts`):

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

## Repository

- **GitHub**: [https://github.com/BaryoDev/rnxORM](https://github.com/BaryoDev/rnxORM)
- **npm**: [https://www.npmjs.com/package/rnxorm](https://www.npmjs.com/package/rnxorm)
- **Issues**: [https://github.com/BaryoDev/rnxORM/issues](https://github.com/BaryoDev/rnxORM/issues)

## License

MPL-2.0
