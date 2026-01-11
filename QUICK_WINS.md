# Quick Wins: 30-Day Action Plan

> **Goal:** Ship production-ready v2.1.0 with critical improvements
> **Timeline:** 30 days
> **Effort:** ~80-120 hours

---

## Week 1: Production Hardening

### ✅ Day 1-2: PR Feedback (COMPLETED)
- [x] Enhanced concurrency error messages
- [x] Package.json migration note
- [ ] **TODO:** License decision (ISC vs MPL-2.0)
- [ ] **TODO:** Sign CLA

### 🔧 Day 3-4: Connection Resilience

**File:** `src/core/DbContext.ts`

```typescript
// Add retry logic with exponential backoff
private async connectWithRetry(maxRetries = 3): Promise<void> {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            await this.provider.connect();
            this.logger.info('Database connected successfully');
            return;
        } catch (error) {
            attempt++;
            if (attempt >= maxRetries) {
                this.logger.error('Failed to connect after max retries', error);
                throw error;
            }

            const delay = Math.pow(2, attempt) * 1000;
            this.logger.warn(`Connection failed (attempt ${attempt}/${maxRetries}). Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

// Graceful shutdown with timeout
public async gracefulShutdown(timeout = 30000): Promise<void> {
    this.logger.info('Starting graceful shutdown...');

    const shutdownPromise = (async () => {
        await this.saveChanges();  // Save pending changes
        await this.disconnect();
    })();

    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Shutdown timeout exceeded')), timeout)
    );

    try {
        await Promise.race([shutdownPromise, timeoutPromise]);
        this.logger.info('Shutdown completed successfully');
    } catch (error) {
        this.logger.error('Shutdown failed', error);
        throw error;
    }
}
```

**Testing:**
```typescript
// test/unit/ConnectionResilience.test.ts
describe('Connection Resilience', () => {
    it('should retry on connection failure', async () => {
        let attempts = 0;
        const mockProvider = {
            connect: () => {
                attempts++;
                if (attempts < 3) throw new Error('Connection failed');
            }
        };

        await expect(db.connect()).resolves.not.toThrow();
        expect(attempts).toBe(3);
    });
});
```

### 🔧 Day 5-7: Structured Logging

**Install Dependencies:**
```bash
npm install pino pino-pretty
```

**Implementation:**

```typescript
// src/utils/logger.ts
import pino from 'pino';

export interface Logger {
    info(message: string, meta?: object): void;
    warn(message: string, meta?: object): void;
    error(message: string, error?: Error, meta?: object): void;
    debug(message: string, meta?: object): void;
}

export function createLogger(options?: any): Logger {
    const logger = pino({
        level: process.env.LOG_LEVEL || 'info',
        transport: process.env.NODE_ENV === 'development' ? {
            target: 'pino-pretty',
            options: { colorize: true }
        } : undefined,
        ...options
    });

    return {
        info: (msg, meta) => logger.info(meta, msg),
        warn: (msg, meta) => logger.warn(meta, msg),
        error: (msg, error, meta) => logger.error({ err: error, ...meta }, msg),
        debug: (msg, meta) => logger.debug(meta, msg)
    };
}

// src/core/DbContext.ts
export class DbContext {
    protected logger: Logger;

    constructor(provider: IDatabaseProvider, options?: DbContextOptions) {
        this.logger = options?.logger || createLogger();
        // ...
    }

    async saveChanges(): Promise<void> {
        const stats = this.changeTracker.getStatistics();
        this.logger.debug('Saving changes', { stats });

        try {
            // ... save logic
            this.logger.info('Changes saved successfully', {
                inserted: stats.added,
                updated: stats.modified,
                deleted: stats.deleted
            });
        } catch (error) {
            this.logger.error('Failed to save changes', error as Error, { stats });
            throw error;
        }
    }
}
```

**Usage:**
```typescript
const db = new AppDbContext(provider, {
    logger: createLogger({ level: 'debug' })
});
```

---

## Week 2: SQLite Support

### 🚀 Day 8-10: SQLite Provider

**Install:**
```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

**Implementation:**

```typescript
// src/providers/SQLiteProvider.ts
import Database from 'better-sqlite3';
import { IDatabaseProvider, QueryResult, PoolConfig } from '../types/IDatabaseProvider';

export interface SQLiteConfig {
    database: string;  // ':memory:' for in-memory
    readonly?: boolean;
    fileMustExist?: boolean;
    timeout?: number;
    verbose?: boolean;
}

export class SQLiteProvider implements IDatabaseProvider {
    private db: Database.Database | null = null;
    private config: SQLiteConfig;
    type: 'postgres' | 'mssql' | 'mariadb' | 'sqlite' = 'sqlite';

    constructor(config: SQLiteConfig) {
        this.config = config;
    }

    async connect(): Promise<void> {
        this.db = new Database(this.config.database, {
            readonly: this.config.readonly,
            fileMustExist: this.config.fileMustExist,
            timeout: this.config.timeout,
            verbose: this.config.verbose ? console.log : undefined
        });

        // Enable foreign keys
        this.db.pragma('foreign_keys = ON');
    }

    async disconnect(): Promise<void> {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }

    async query(sql: string, params: any[] = []): Promise<QueryResult> {
        if (!this.db) throw new Error('Not connected to database');

        const isSelect = sql.trim().toUpperCase().startsWith('SELECT');
        const stmt = this.db.prepare(sql);

        if (isSelect) {
            const rows = stmt.all(...params);
            return { rows, rowCount: rows.length };
        } else {
            const result = stmt.run(...params);
            return {
                rows: [],
                rowCount: result.changes,
                insertId: result.lastInsertRowid
            };
        }
    }

    getInsertSQL(tableName: string, data: any): { sql: string; values: any[] } {
        const columns = Object.keys(data);
        const placeholders = columns.map((_, i) => `?`);
        const values = Object.values(data);

        const sql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`;
        return { sql, values };
    }

    getUpdateSQL(tableName: string, data: any, where: any): { sql: string; values: any[] } {
        const setClauses = Object.keys(data).map(key => `${key} = ?`);
        const whereClause = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
        const values = [...Object.values(data), ...Object.values(where)];

        const sql = `UPDATE ${tableName} SET ${setClauses.join(', ')} WHERE ${whereClause}`;
        return { sql, values };
    }

    getSelectSQL(tableName: string, where?: any, options?: any): { sql: string; values: any[] } {
        let sql = `SELECT * FROM ${tableName}`;
        const values: any[] = [];

        if (where) {
            const conditions = Object.keys(where).map(key => {
                values.push(where[key]);
                return `${key} = ?`;
            });
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        if (options?.orderBy) {
            sql += ` ORDER BY ${options.orderBy}`;
        }

        if (options?.limit) {
            sql += ` LIMIT ${options.limit}`;
        }

        if (options?.offset) {
            sql += ` OFFSET ${options.offset}`;
        }

        return { sql, values };
    }

    getDeleteSQL(tableName: string, where: any): { sql: string; values: any[] } {
        const whereClause = Object.keys(where).map(key => `${key} = ?`).join(' AND ');
        const values = Object.values(where);

        const sql = `DELETE FROM ${tableName} WHERE ${whereClause}`;
        return { sql, values };
    }

    // SQLite type mapping
    getColumnType(type: string): string {
        const typeMap: Record<string, string> = {
            'text': 'TEXT',
            'varchar': 'TEXT',
            'char': 'TEXT',
            'integer': 'INTEGER',
            'int': 'INTEGER',
            'bigint': 'INTEGER',
            'smallint': 'INTEGER',
            'boolean': 'INTEGER',  // SQLite uses 0/1
            'real': 'REAL',
            'float': 'REAL',
            'double': 'REAL',
            'decimal': 'REAL',
            'blob': 'BLOB',
            'date': 'TEXT',  // ISO8601 strings
            'datetime': 'TEXT',
            'timestamp': 'TEXT'
        };

        return typeMap[type.toLowerCase()] || 'TEXT';
    }

    async createTable(tableName: string, columns: any[]): Promise<void> {
        const columnDefs = columns.map(col => {
            let def = `${col.columnName} ${this.getColumnType(col.type)}`;

            if (col.isPrimaryKey) def += ' PRIMARY KEY';
            if (col.isAutoIncrement) def += ' AUTOINCREMENT';
            if (!col.isNullable && !col.isPrimaryKey) def += ' NOT NULL';
            if (col.defaultValue !== undefined) def += ` DEFAULT ${col.defaultValue}`;

            return def;
        });

        const sql = `CREATE TABLE IF NOT EXISTS ${tableName} (${columnDefs.join(', ')})`;
        await this.query(sql);
    }

    // ... implement other IDatabaseProvider methods
}
```

### 📝 Day 11-12: Tests & Documentation

```typescript
// test/integration/SQLite.test.ts
import { SQLiteProvider } from '../../src/providers/SQLiteProvider';
import { DbContext } from '../../src/core/DbContext';

describe('SQLite Integration', () => {
    let db: TestDbContext;

    beforeEach(async () => {
        const provider = new SQLiteProvider({ database: ':memory:' });
        db = new TestDbContext(provider);
        await db.ensureCreated();
    });

    it('should create in-memory database', async () => {
        const users = db.set(User);
        const user = new User();
        user.name = 'Test User';
        users.add(user);
        await db.saveChanges();

        const all = await users.toList();
        expect(all).toHaveLength(1);
    });

    it('should support foreign keys', async () => {
        const user = new User();
        user.name = 'John';
        db.set(User).add(user);
        await db.saveChanges();

        const post = new Post();
        post.title = 'Hello';
        post.userId = user.id;
        db.set(Post).add(post);
        await db.saveChanges();

        await expect(
            db.query('DELETE FROM users WHERE id = ?', [user.id])
        ).rejects.toThrow();  // FK constraint violation
    });
});
```

**Update README:**
```markdown
### Supported Databases

- ✅ PostgreSQL
- ✅ SQL Server (MSSQL)
- ✅ MariaDB/MySQL
- ✅ **SQLite** (NEW in v2.1.0)

### SQLite Usage

```typescript
import { SQLiteProvider } from 'rnxorm';

// In-memory database (for testing)
const provider = new SQLiteProvider({ database: ':memory:' });

// File-based database
const provider = new SQLiteProvider({
    database: './myapp.db',
    timeout: 5000
});

const db = new AppDbContext(provider);
```

---

## Week 3: Type-Safe Queries

### 🎯 Day 13-17: Type-Safe Where API

**Implementation:**

```typescript
// src/core/DbSet.ts
export type ComparisonOperator = '=' | '!=' | '<>' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'ILIKE' | 'IN';

export class DbSet<T> {
    // New: Type-safe where
    whereTyped<K extends keyof T>(
        property: K,
        operator: ComparisonOperator,
        value: T[K] | T[K][]
    ): QueryBuilder<T> {
        const propertyName = String(property);
        return this.where(propertyName, operator, value);
    }

    // New: Type-safe orderBy
    orderByTyped<K extends keyof T>(property: K, direction: 'ASC' | 'DESC' = 'ASC'): QueryBuilder<T> {
        const propertyName = String(property);
        return direction === 'ASC'
            ? this.orderBy(propertyName)
            : this.orderByDescending(propertyName);
    }
}
```

**Usage:**

```typescript
// Before (stringly-typed)
const users = await db.set(User)
    .where('age', '>', 18)  // No autocomplete, typos possible
    .orderBy('name')
    .toList();

// After (type-safe)
const users = await db.set(User)
    .whereTyped('age', '>', 18)  // ✅ Autocomplete + type checking
    .orderByTyped('name')
    .toList();
```

### 📝 Day 18-19: Tests & Migration Guide

```typescript
// test/unit/TypeSafeQueries.test.ts
describe('Type-Safe Queries', () => {
    it('should provide autocomplete for entity properties', () => {
        // This test verifies TypeScript compilation
        const query = db.set(User)
            .whereTyped('name', '=', 'John')  // ✅ Compiles
            .whereTyped('age', '>', 18);      // ✅ Compiles

        // @ts-expect-error - Invalid property
        db.set(User).whereTyped('invalidProp', '=', 'test');  // ❌ Compile error
    });

    it('should type-check values', () => {
        // @ts-expect-error - Wrong type
        db.set(User).whereTyped('age', '>', 'not a number');  // ❌ Compile error
    });
});
```

**Migration Guide:**

```markdown
## Upgrading to v2.1.0

### Type-Safe Query API

We've added type-safe query methods that provide autocomplete and compile-time type checking.

**Before:**
```typescript
db.set(User).where('name', '=', 'John')
```

**After (recommended):**
```typescript
db.set(User).whereTyped('name', '=', 'John')  // Autocomplete & type-safe!
```

**Note:** The old `where()` method still works for backward compatibility.
```

---

## Week 4: Documentation & Release

### 📚 Day 20-23: Documentation Updates

1. **Update README.md**
   - Add SQLite section
   - Add type-safe query examples
   - Update feature comparison table

2. **Create Migration Guides**
   - From v2.0.0 → v2.1.0
   - From Entity Framework Core → rnxORM
   - From TypeORM → rnxORM

3. **Add Examples**
   - SQLite usage examples
   - Type-safe query examples
   - Production deployment guide

4. **Update CHANGELOG.md**
   ```markdown
   ## [2.1.0] - 2026-02-XX

   ### Added
   - ✨ SQLite database support
   - ✨ Type-safe query API (`.whereTyped()`, `.orderByTyped()`)
   - 🔧 Connection retry logic with exponential backoff
   - 🔧 Graceful shutdown handler
   - 📝 Structured logging with Pino
   - 📖 Migration guide from Entity Framework Core

   ### Improved
   - Enhanced concurrency violation error messages
   - Better production error handling
   - Improved documentation with more examples

   ### Fixed
   - Fixed PR review feedback items
   ```

### 🚀 Day 24-26: Testing & QA

**Run Full Test Suite:**
```bash
npm test                          # All tests
npm run test:coverage             # Coverage report
npm run test:integration          # Integration tests
npm run lint                      # Linting
npm run build                     # Production build
```

**Manual Testing Checklist:**
- [ ] SQLite in-memory database
- [ ] SQLite file-based database
- [ ] Type-safe queries with autocomplete
- [ ] Connection retry on failure
- [ ] Graceful shutdown
- [ ] Structured logging output
- [ ] All existing features still work

### 🎉 Day 27-30: Release v2.1.0

**Pre-release Checklist:**
- [ ] All tests passing
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] Version bumped to 2.1.0
- [ ] Git tag created
- [ ] npm publish

**Release Commands:**
```bash
# Update version
npm version minor  # 2.0.0 → 2.1.0

# Build
npm run build

# Publish
npm publish

# Create GitHub release
gh release create v2.1.0 --notes "See CHANGELOG.md for details"
```

**Post-Release:**
- [ ] Announce on GitHub Discussions
- [ ] Post on Twitter/X
- [ ] Update comparison documents
- [ ] Create demo video
- [ ] Write blog post

---

## Expected Outcomes

After 30 days, rnxORM v2.1.0 will have:

### ✅ **Production Readiness**
- Connection resilience (retry + timeout)
- Graceful shutdown
- Structured logging
- Better error messages

### ✅ **Feature Parity Improvements**
- SQLite support (matches all competitors)
- Type-safe queries (closer to Prisma/Drizzle/MikroORM)
- 4 database support (was 3)

### ✅ **Developer Experience**
- Better TypeScript autocomplete
- Clearer documentation
- Migration guides
- Production deployment guide

### 📊 **Metrics**
- Test coverage: 95%+ (maintain)
- Lint errors: 0 (maintain)
- Build time: < 10s
- Package size: ~150KB (no increase)

---

## Next Steps (After v2.1.0)

Once v2.1.0 is released, focus on:

1. **Community Building**
   - Enable GitHub Discussions
   - Create Discord server
   - Write 5 blog posts
   - Record tutorial videos

2. **VS Code Extension** (Biggest DX win)
   - Start development
   - Target release: v2.2.0 (3 months)

3. **MongoDB Support** (Database parity)
   - Research & design
   - Target release: v2.2.0 (3 months)

4. **Performance Optimization**
   - Query caching
   - N+1 detection
   - Target: 1.4x vs Drizzle (from 1.7x)

---

## Summary

This 30-day plan delivers **critical production features** while **maintaining stability**.

**Key Wins:**
- 🎯 SQLite unlocks dev/test scenarios
- 🎯 Type safety moves us closer to Prisma/MikroORM
- 🎯 Production hardening removes deployment blockers
- 🎯 Sets foundation for rapid v2.2+ development

**Total Effort:** ~80-120 hours (2-3 weeks full-time OR 4-6 weeks part-time)

**Risk:** Low (additive changes, no breaking changes)

**Impact:** High (removes 3 major adoption blockers)

Let's ship it! 🚀
