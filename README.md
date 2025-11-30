# rnxORM

A lightweight TypeScript ORM for PostgreSQL, inspired by Entity Framework Core.

[![npm version](https://img.shields.io/npm/v/rnxorm.svg)](https://www.npmjs.com/package/rnxorm)
[![GitHub](https://img.shields.io/badge/github-BaryoDev%2FrnxORM-blue)](https://github.com/BaryoDev/rnxORM)
[![CI](https://github.com/BaryoDev/rnxORM/actions/workflows/ci.yml/badge.svg)](https://github.com/BaryoDev/rnxORM/actions/workflows/ci.yml)
[![Ko-fi](https://img.shields.io/badge/Support%20me%20on-Ko--fi-ff5f5f?logo=ko-fi&logoColor=white)](https://ko-fi.com/T6T01CQT4R)

## Installation

```bash
npm install rnxorm pg reflect-metadata
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

### 2. Connect and Query

```typescript
import { DbContext } from "rnxorm";
import { User } from "./User";

async function main() {
  const db = new DbContext({
    host: "localhost",
    port: 5432,
    user: "postgres",
    password: "password",
    database: "mydb",
  });

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

- **Decorators**: `@Entity`, `@Column`, `@PrimaryKey`
- **Schema Scaffolding**: Automatically create tables with `ensureCreated()`
- **CRUD Operations**: `add`, `update`, `remove`, `toList`
- **Fluent Query API**: `.where().toList()`
- **Repository Pattern**: `DbSet<T>`
- **Query Optimization**: `.asNoTracking()` for read-only queries
- **Primary Key Lookup**: `.find(id)` for quick entity retrieval

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
-   **Complex Constraints**: Foreign keys, unique constraints (other than PK), and indexes are not currently supported via decorators.

## Repository

- **GitHub**: [https://github.com/BaryoDev/rnxORM](https://github.com/BaryoDev/rnxORM)
- **npm**: [https://www.npmjs.com/package/rnxorm](https://www.npmjs.com/package/rnxorm)
- **Issues**: [https://github.com/BaryoDev/rnxORM/issues](https://github.com/BaryoDev/rnxORM/issues)

## License

ISC
