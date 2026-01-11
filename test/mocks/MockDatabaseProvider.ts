import { IDatabaseProvider, QueryResult, DatabaseConfig } from '../../src/providers/IDatabaseProvider';
import { ColumnMetadata, EntityMetadata } from '../../src/core/MetadataStorage';

/**
 * Mock in-memory database provider for testing without actual databases
 * Stores data in memory using Maps
 */
export class MockDatabaseProvider implements IDatabaseProvider {
    type: 'postgres' = 'postgres'; // Mock as postgres for compatibility
    private tables: Map<string, Map<any, any>> = new Map();
    private sequences: Map<string, number> = new Map();
    private connected: boolean = false;
    private inTransaction: boolean = false;
    private transactionData: Map<string, Map<any, any>> | null = null;

    constructor(config?: DatabaseConfig) {
        // Config not needed for mock
    }

    async connect(): Promise<void> {
        this.connected = true;
    }

    async disconnect(): Promise<void> {
        this.connected = false;
        this.tables.clear();
        this.sequences.clear();
    }

    async query(text: string, params?: any[]): Promise<QueryResult> {
        if (!this.connected) {
            throw new Error('Not connected to database');
        }

        // Parse SQL and execute in-memory operations
        const sql = text.trim().toUpperCase();

        // CREATE TABLE
        if (sql.startsWith('CREATE TABLE')) {
            const tableName = this.extractTableName(text, 'CREATE TABLE');
            if (!this.tables.has(tableName)) {
                this.tables.set(tableName, new Map());
            }
            return { rows: [], rowCount: 0 };
        }

        // DROP TABLE
        if (sql.startsWith('DROP TABLE')) {
            const tableName = this.extractTableName(text, 'DROP TABLE');
            this.tables.delete(tableName);
            return { rows: [], rowCount: 0 };
        }

        // INSERT
        if (sql.startsWith('INSERT INTO')) {
            return this.executeInsert(text, params);
        }

        // SELECT
        if (sql.startsWith('SELECT')) {
            return this.executeSelect(text, params);
        }

        // UPDATE
        if (sql.startsWith('UPDATE')) {
            return this.executeUpdate(text, params);
        }

        // DELETE
        if (sql.startsWith('DELETE')) {
            return this.executeDelete(text, params);
        }

        // Default - unknown query
        return { rows: [], rowCount: 0 };
    }

    async beginTransaction(): Promise<void> {
        this.inTransaction = true;
        // Create a copy of current data for rollback
        this.transactionData = new Map();
        for (const [tableName, tableData] of this.tables.entries()) {
            this.transactionData.set(tableName, new Map(tableData));
        }
    }

    async commitTransaction(): Promise<void> {
        this.inTransaction = false;
        this.transactionData = null;
    }

    async rollbackTransaction(): Promise<void> {
        if (this.transactionData) {
            this.tables = this.transactionData;
        }
        this.inTransaction = false;
        this.transactionData = null;
    }

    getParameterPlaceholder(index: number): string {
        return `$${index}`;
    }

    generateSelectSql(tableName: string, whereClause?: string): string {
        if (whereClause) {
            return `SELECT * FROM ${tableName} WHERE ${whereClause}`;
        }
        return `SELECT * FROM ${tableName}`;
    }

    mapType(tsType: string): string {
        return tsType.toUpperCase();
    }

    generateCreateTableSql(entity: EntityMetadata): string {
        const columns = entity.columns.map(c =>
            `${c.columnName} ${this.getColumnType(c)}`
        ).join(', ');
        return `CREATE TABLE ${entity.tableName} (${columns})`;
    }

    generateAddColumnSql(tableName: string, column: ColumnMetadata): string {
        return `ALTER TABLE ${tableName} ADD COLUMN ${column.columnName} ${this.getColumnType(column)}`;
    }

    generateAlterColumnTypeSql(tableName: string, column: ColumnMetadata): string {
        return `ALTER TABLE ${tableName} ALTER COLUMN ${column.columnName} TYPE ${this.getColumnType(column)}`;
    }

    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] } {
        return {
            sql: `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1`,
            params: [tableName]
        };
    }

    normalizeType(dbType: string): string {
        return dbType.toLowerCase();
    }

    getAutoIncrementType(): string {
        return 'INTEGER AUTO_INCREMENT';
    }

    isTypeMismatch(entityType: string, dbType: string): boolean {
        return this.normalizeType(entityType) !== this.normalizeType(dbType);
    }

    generateAddForeignKeySql(
        tableName: string,
        columnName: string,
        referencedTable: string,
        referencedColumn: string,
        onDelete?: string,
        onUpdate?: string
    ): string {
        let sql = `ALTER TABLE ${tableName} ADD FOREIGN KEY (${columnName}) REFERENCES ${referencedTable}(${referencedColumn})`;
        if (onDelete) sql += ` ON DELETE ${onDelete}`;
        if (onUpdate) sql += ` ON UPDATE ${onUpdate}`;
        return sql;
    }

    generateCreateIndexSql(
        tableName: string,
        indexName: string,
        columns: string[],
        unique: boolean
    ): string {
        const uniqueClause = unique ? 'UNIQUE ' : '';
        return `CREATE ${uniqueClause}INDEX ${indexName} ON ${tableName} (${columns.join(', ')})`;
    }

    generateCreateUniqueConstraintSql(
        tableName: string,
        constraintName: string,
        columns: string[]
    ): string {
        return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} UNIQUE (${columns.join(', ')})`;
    }

    generateCreateJoinTableSql(
        joinTableName: string,
        column1: string,
        column2: string,
        referencedTable1: string,
        referencedTable2: string,
        onDelete?: string
    ): string {
        let sql = `CREATE TABLE ${joinTableName} (${column1} INTEGER, ${column2} INTEGER, PRIMARY KEY (${column1}, ${column2}))`;
        return sql;
    }

    generateInsertSql(tableName: string, columns: ColumnMetadata[]): string {
        const columnNames = columns.map(c => c.columnName).join(', ');
        const placeholders = columns.map((_, i) => this.getParameterPlaceholder(i + 1)).join(', ');
        return `INSERT INTO ${tableName} (${columnNames}) VALUES (${placeholders})`;
    }

    generateUpdateSql(tableName: string, columns: ColumnMetadata[], pkColumn: ColumnMetadata): string {
        const setClause = columns.map((c, i) => `${c.columnName} = ${this.getParameterPlaceholder(i + 1)}`).join(', ');
        return `UPDATE ${tableName} SET ${setClause} WHERE ${pkColumn.columnName} = ${this.getParameterPlaceholder(columns.length + 1)}`;
    }

    generateDeleteSql(tableName: string, pkColumn: ColumnMetadata): string {
        return `DELETE FROM ${tableName} WHERE ${pkColumn.columnName} = ${this.getParameterPlaceholder(1)}`;
    }

    getColumnType(column: ColumnMetadata): string {
        return column.type || 'TEXT';
    }

    async createTable(metadata: EntityMetadata): Promise<void> {
        if (!this.tables.has(metadata.tableName)) {
            this.tables.set(metadata.tableName, new Map());
        }
    }

    async dropTable(tableName: string): Promise<void> {
        this.tables.delete(tableName);
    }

    private extractTableName(sql: string, prefix: string): string {
        const regex = new RegExp(`${prefix}\\s+(?:IF\\s+(?:NOT\\s+)?EXISTS\\s+)?([\\w_]+)`, 'i');
        const match = sql.match(regex);
        return match ? match[1].toLowerCase() : '';
    }

    private executeInsert(sql: string, params?: any[]): QueryResult {
        const tableName = this.extractTableName(sql, 'INSERT INTO');
        const table = this.tables.get(tableName);

        if (!table) {
            throw new Error(`Table ${tableName} does not exist`);
        }

        // Extract column names from INSERT statement
        const columnsMatch = sql.match(/\(([^)]+)\)\s+VALUES/i);
        if (!columnsMatch || !params) {
            return { rows: [], rowCount: 0 };
        }

        const columns = columnsMatch[1].split(',').map(c => c.trim().toLowerCase());

        // Create row object
        const row: any = {};
        let primaryKeyValue: any = null;

        columns.forEach((col, idx) => {
            row[col] = params[idx];
            // Assume first column is primary key
            if (idx === 0) {
                primaryKeyValue = params[idx];
            }
        });

        // Check for duplicate primary key
        if (table.has(primaryKeyValue)) {
            throw new Error(`Duplicate key value violates unique constraint`);
        }

        table.set(primaryKeyValue, row);

        return { rows: [], rowCount: 1, insertId: primaryKeyValue };
    }

    private executeSelect(sql: string, params?: any[]): QueryResult {
        // Extract table name from SELECT
        const fromMatch = sql.match(/FROM\s+(\w+)/i);
        if (!fromMatch) {
            return { rows: [], rowCount: 0 };
        }

        const tableName = fromMatch[1].toLowerCase();
        const table = this.tables.get(tableName);

        if (!table) {
            return { rows: [], rowCount: 0 };
        }

        let rows = Array.from(table.values());

        // Handle WHERE clause
        if (sql.includes('WHERE')) {
            rows = this.applyWhereClause(rows, sql, params);
        }

        // Handle ORDER BY
        if (sql.includes('ORDER BY')) {
            rows = this.applyOrderBy(rows, sql);
        }

        // Handle LIMIT/OFFSET (PostgreSQL style)
        const limitMatch = sql.match(/LIMIT\s+(\d+)/i);
        const offsetMatch = sql.match(/OFFSET\s+(\d+)/i);

        if (offsetMatch) {
            const offset = parseInt(offsetMatch[1]);
            rows = rows.slice(offset);
        }

        if (limitMatch) {
            const limit = parseInt(limitMatch[1]);
            rows = rows.slice(0, limit);
        }

        // Handle COUNT(*)
        if (sql.includes('COUNT(*)')) {
            return { rows: [{ count: rows.length }], rowCount: 1 };
        }

        return { rows, rowCount: rows.length };
    }

    private executeUpdate(sql: string, params?: any[]): QueryResult {
        const tableMatch = sql.match(/UPDATE\s+(\w+)/i);
        if (!tableMatch || !params) {
            return { rows: [], rowCount: 0 };
        }

        const tableName = tableMatch[1].toLowerCase();
        const table = this.tables.get(tableName);

        if (!table) {
            throw new Error(`Table ${tableName} does not exist`);
        }

        // Extract SET columns
        const setMatch = sql.match(/SET\s+(.+?)\s+WHERE/i);
        if (!setMatch) {
            return { rows: [], rowCount: 0 };
        }

        const setClauses = setMatch[1].split(',');
        const columns = setClauses.map(clause => {
            const match = clause.trim().match(/(\w+)\s*=/);
            return match ? match[1].toLowerCase() : '';
        });

        // Find matching rows
        let matchedRows = Array.from(table.entries());
        if (sql.includes('WHERE')) {
            const rows = Array.from(table.values());
            const filteredRows = this.applyWhereClause(rows, sql, params);
            matchedRows = matchedRows.filter(([key, row]) =>
                filteredRows.some(fr => fr === row)
            );
        }

        // Update rows
        let rowCount = 0;
        for (const [key, row] of matchedRows) {
            columns.forEach((col, idx) => {
                if (col && params[idx] !== undefined) {
                    row[col] = params[idx];
                }
            });
            rowCount++;
        }

        return { rows: [], rowCount };
    }

    private executeDelete(sql: string, params?: any[]): QueryResult {
        const fromMatch = sql.match(/DELETE\s+FROM\s+(\w+)/i);
        if (!fromMatch) {
            return { rows: [], rowCount: 0 };
        }

        const tableName = fromMatch[1].toLowerCase();
        const table = this.tables.get(tableName);

        if (!table) {
            return { rows: [], rowCount: 0 };
        }

        if (!sql.includes('WHERE')) {
            // Delete all rows
            const count = table.size;
            table.clear();
            return { rows: [], rowCount: count };
        }

        // Find and delete matching rows
        const rows = Array.from(table.entries());
        const values = Array.from(table.values());
        const filteredRows = this.applyWhereClause(values, sql, params);

        let rowCount = 0;
        for (const [key, row] of rows) {
            if (filteredRows.some(fr => fr === row)) {
                table.delete(key);
                rowCount++;
            }
        }

        return { rows: [], rowCount };
    }

    private applyWhereClause(rows: any[], sql: string, params?: any[]): any[] {
        // Simple WHERE clause parsing
        const whereMatch = sql.match(/WHERE\s+(.+?)(?:ORDER BY|LIMIT|OFFSET|$)/i);
        if (!whereMatch) {
            return rows;
        }

        const whereClause = whereMatch[1].trim();

        // Handle simple conditions like "column = $1"
        const simpleMatch = whereClause.match(/(\w+)\s*(=|!=|<>|>|<|>=|<=)\s*\$(\d+)/);
        if (simpleMatch && params) {
            const column = simpleMatch[1].toLowerCase();
            const operator = simpleMatch[2];
            const paramIndex = parseInt(simpleMatch[3]) - 1;
            const value = params[paramIndex];

            return rows.filter(row => {
                const rowValue = row[column];
                switch (operator) {
                    case '=': return rowValue === value;
                    case '!=':
                    case '<>': return rowValue !== value;
                    case '>': return rowValue > value;
                    case '<': return rowValue < value;
                    case '>=': return rowValue >= value;
                    case '<=': return rowValue <= value;
                    default: return true;
                }
            });
        }

        return rows;
    }

    private applyOrderBy(rows: any[], sql: string): any[] {
        const orderMatch = sql.match(/ORDER BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
        if (!orderMatch) {
            return rows;
        }

        const column = orderMatch[1].toLowerCase();
        const direction = orderMatch[2]?.toUpperCase() === 'DESC' ? -1 : 1;

        return rows.sort((a, b) => {
            const aVal = a[column];
            const bVal = b[column];

            if (aVal === bVal) return 0;
            if (aVal === null || aVal === undefined) return 1;
            if (bVal === null || bVal === undefined) return -1;

            return (aVal < bVal ? -1 : 1) * direction;
        });
    }
}
