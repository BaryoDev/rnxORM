import * as mariadb from "mariadb";
import { DatabaseConfig, IDatabaseProvider, QueryResult, PoolStats } from "./IDatabaseProvider";
import { ColumnMetadata, EntityMetadata } from "../core/MetadataStorage";

/**
 * MariaDB database provider implementation
 */
export class MariaDBProvider implements IDatabaseProvider {
    type: 'mariadb' = 'mariadb';
    private pool: mariadb.Pool;
    private connection: mariadb.PoolConnection | null = null;
    private inTransaction: boolean = false;

    constructor(config: DatabaseConfig) {
        this.pool = mariadb.createPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            connectionLimit: config.max || 10,
            idleTimeout: config.idleTimeoutMillis || 30000,
        });
    }

    /**
     * Get connection pool statistics
     */
    getPoolStats(): PoolStats | null {
        return {
            total: this.pool.totalConnections(),
            idle: this.pool.idleConnections(),
            active: this.pool.activeConnections(),
            waiting: 0 // MariaDB pool doesn't expose waiting count
        };
    }

    async connect(): Promise<void> {
        this.connection = await this.pool.getConnection();
    }

    async disconnect(): Promise<void> {
        if (this.connection) {
            await this.connection.release();
            this.connection = null;
        }
        await this.pool.end();
    }

    async query(text: string, params?: any[]): Promise<QueryResult> {
        const conn = this.connection || await this.pool.getConnection();

        try {
            const result = await conn.query(text, params);

            // MariaDB returns different formats depending on query type
            const rows = Array.isArray(result) ? result : [result];
            const rowCount = result.affectedRows !== undefined ? result.affectedRows : rows.length;

            return {
                rows: rows,
                rowCount: rowCount,
            };
        } finally {
            if (!this.connection) {
                await conn.release();
            }
        }
    }

    async beginTransaction(): Promise<void> {
        if (!this.connection) await this.connect();
        await this.connection?.beginTransaction();
        this.inTransaction = true;
    }

    async commitTransaction(): Promise<void> {
        if (this.connection && this.inTransaction) {
            await this.connection.commit();
            this.inTransaction = false;
        }
    }

    async rollbackTransaction(): Promise<void> {
        if (this.connection && this.inTransaction) {
            await this.connection.rollback();
            this.inTransaction = false;
        }
    }

    mapType(tsType: string): string {
        // Map TypeScript types to MariaDB types
        const typeMap: Record<string, string> = {
            text: 'TEXT',
            integer: 'INT',
            boolean: 'TINYINT(1)',
            timestamp: 'DATETIME',
            date: 'DATE',
            time: 'TIME',
            decimal: 'DECIMAL(10,2)',
            float: 'FLOAT',
            double: 'DOUBLE',
            bigint: 'BIGINT',
            json: 'JSON',
        };

        const lowerType = tsType.toLowerCase();

        // Check if it's a custom type (e.g., varchar(50))
        if (lowerType.startsWith('varchar') || lowerType.startsWith('decimal')) {
            return tsType.toUpperCase();
        }

        return typeMap[lowerType] || tsType.toUpperCase();
    }

    generateCreateTableSql(entity: EntityMetadata): string {
        const columns = entity.columns.map((col) => {
            let colDef = `${col.columnName} ${this.mapType(col.type)}`;

            if (col.isPrimaryKey) {
                // If it's an integer PK, make it AUTO_INCREMENT
                if (col.type === "integer") {
                    colDef = `${col.columnName} INT AUTO_INCREMENT PRIMARY KEY`;
                } else {
                    colDef += " PRIMARY KEY";
                }
            } else if (!col.isNullable) {
                colDef += " NOT NULL";
            }

            return colDef;
        });

        return `CREATE TABLE IF NOT EXISTS ${entity.tableName} (${columns.join(", ")});`;
    }

    generateAddColumnSql(tableName: string, column: ColumnMetadata): string {
        const colDef = this.mapType(column.type);
        return `ALTER TABLE ${tableName} ADD COLUMN ${column.columnName} ${colDef}`;
    }

    generateAlterColumnTypeSql(tableName: string, column: ColumnMetadata): string {
        // MariaDB uses MODIFY COLUMN instead of ALTER COLUMN
        return `ALTER TABLE ${tableName} MODIFY COLUMN ${column.columnName} ${this.mapType(column.type)}`;
    }

    generateInsertSql(tableName: string, columns: ColumnMetadata[]): string {
        const colNames = columns.map(c => c.columnName).join(", ");
        const values = columns.map(() => "?").join(", ");
        return `INSERT INTO ${tableName} (${colNames}) VALUES (${values})`;
    }

    generateUpdateSql(tableName: string, columns: ColumnMetadata[], pkColumn: ColumnMetadata): string {
        const setClause = columns.map(c => `${c.columnName} = ?`).join(", ");
        return `UPDATE ${tableName} SET ${setClause} WHERE ${pkColumn.columnName} = ?`;
    }

    generateDeleteSql(tableName: string, pkColumn: ColumnMetadata): string {
        return `DELETE FROM ${tableName} WHERE ${pkColumn.columnName} = ?`;
    }

    generateSelectSql(tableName: string, whereClause?: string): string {
        const where = whereClause ? ` ${whereClause}` : "";
        return `SELECT * FROM ${tableName}${where}`;
    }

    getParameterPlaceholder(index: number): string {
        return "?";
    }

    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] } {
        return {
            sql: `
                SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = ? AND TABLE_SCHEMA = DATABASE();
            `,
            params: [tableName],
        };
    }

    normalizeType(dbType: string): string {
        const normalized = dbType.toLowerCase();

        // Map MariaDB types to normalized types
        const typeMap: Record<string, string> = {
            'int': 'integer',
            'tinyint': 'boolean',
            'datetime': 'timestamp',
            'varchar': 'varchar',
        };

        return typeMap[normalized] || normalized;
    }

    getAutoIncrementType(): string {
        return 'AUTO_INCREMENT';
    }

    isTypeMismatch(entityType: string, dbType: string): boolean {
        const normalizedEntity = this.normalizeType(entityType.toLowerCase());
        const normalizedDb = this.normalizeType(dbType.toLowerCase());

        // Simple comparison
        if (normalizedEntity === 'integer' && normalizedDb !== 'integer') return true;
        if (normalizedEntity === 'text' && normalizedDb !== 'text') return true;
        if (normalizedEntity === 'boolean' && normalizedDb !== 'boolean') return true;
        if (normalizedEntity.startsWith('varchar') && !normalizedDb.includes('varchar')) return true;
        if (normalizedEntity === 'timestamp' && !normalizedDb.includes('timestamp') && !normalizedDb.includes('datetime')) return true;

        return false;
    }

    generateAddForeignKeySql(
        tableName: string,
        columnName: string,
        referencedTable: string,
        referencedColumn: string,
        onDelete?: string,
        onUpdate?: string
    ): string {
        const constraintName = `fk_${tableName}_${columnName}`;
        let sql = `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} FOREIGN KEY (${columnName}) REFERENCES ${referencedTable}(${referencedColumn})`;

        if (onDelete) {
            sql += ` ON DELETE ${onDelete}`;
        }
        if (onUpdate) {
            sql += ` ON UPDATE ${onUpdate}`;
        }

        return sql;
    }

    generateCreateIndexSql(
        tableName: string,
        indexName: string,
        columns: string[],
        unique: boolean
    ): string {
        const uniqueKeyword = unique ? 'UNIQUE ' : '';
        const columnList = columns.join(', ');
        return `CREATE ${uniqueKeyword}INDEX ${indexName} ON ${tableName} (${columnList})`;
    }

    generateCreateUniqueConstraintSql(
        tableName: string,
        constraintName: string,
        columns: string[]
    ): string {
        const columnList = columns.join(', ');
        return `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} UNIQUE (${columnList})`;
    }

    generateCreateJoinTableSql(
        joinTableName: string,
        column1: string,
        column2: string,
        referencedTable1: string,
        referencedTable2: string,
        onDelete?: string
    ): string {
        const cascadeClause = onDelete ? ` ON DELETE ${onDelete}` : ' ON DELETE CASCADE';

        return `CREATE TABLE IF NOT EXISTS ${joinTableName} (
            ${column1} INT NOT NULL,
            ${column2} INT NOT NULL,
            PRIMARY KEY (${column1}, ${column2}),
            FOREIGN KEY (${column1}) REFERENCES ${referencedTable1}(id)${cascadeClause},
            FOREIGN KEY (${column2}) REFERENCES ${referencedTable2}(id)${cascadeClause}
        )`;
    }
}
