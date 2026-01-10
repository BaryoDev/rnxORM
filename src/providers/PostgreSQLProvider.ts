import { Pool, PoolClient } from "pg";
import { DatabaseConfig, IDatabaseProvider, QueryResult } from "./IDatabaseProvider";
import { ColumnMetadata, EntityMetadata } from "../core/MetadataStorage";

/**
 * PostgreSQL database provider implementation
 */
export class PostgreSQLProvider implements IDatabaseProvider {
    private pool: Pool;
    private client: PoolClient | null = null;

    constructor(config: DatabaseConfig) {
        this.pool = new Pool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            max: config.max,
            min: config.min,
            idleTimeoutMillis: config.idleTimeoutMillis,
        });
    }

    async connect(): Promise<void> {
        this.client = await this.pool.connect();
    }

    async disconnect(): Promise<void> {
        if (this.client) {
            this.client.release();
            this.client = null;
        }
        await this.pool.end();
    }

    async query(text: string, params?: any[]): Promise<QueryResult> {
        const result = this.client
            ? await this.client.query(text, params)
            : await this.pool.query(text, params);

        return {
            rows: result.rows,
            rowCount: result.rowCount || 0,
        };
    }

    async beginTransaction(): Promise<void> {
        if (!this.client) await this.connect();
        await this.client?.query('BEGIN');
    }

    async commitTransaction(): Promise<void> {
        await this.client?.query('COMMIT');
    }

    async rollbackTransaction(): Promise<void> {
        await this.client?.query('ROLLBACK');
    }

    mapType(tsType: string): string {
        // Map TypeScript types to PostgreSQL types
        const typeMap: Record<string, string> = {
            text: 'TEXT',
            integer: 'INTEGER',
            boolean: 'BOOLEAN',
            timestamp: 'TIMESTAMP',
            date: 'DATE',
            time: 'TIME',
            decimal: 'DECIMAL',
            float: 'REAL',
            double: 'DOUBLE PRECISION',
            bigint: 'BIGINT',
            json: 'JSONB',
        };

        // Check if it's a custom type (e.g., varchar(50))
        const lowerType = tsType.toLowerCase();
        if (lowerType.startsWith('varchar')) {
            return tsType.toUpperCase();
        }

        return typeMap[lowerType] || tsType.toUpperCase();
    }

    generateCreateTableSql(entity: EntityMetadata): string {
        const columns = entity.columns.map((col) => {
            let colDef = `${col.columnName} ${this.mapType(col.type)}`;

            if (col.isPrimaryKey) {
                // If it's an integer PK, make it SERIAL for auto-increment
                if (col.type === "integer") {
                    colDef = `${col.columnName} SERIAL PRIMARY KEY`;
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
        return `ALTER TABLE ${tableName} ALTER COLUMN ${column.columnName} TYPE ${this.mapType(column.type)} USING ${column.columnName}::${this.mapType(column.type)}`;
    }

    generateInsertSql(tableName: string, columns: ColumnMetadata[]): string {
        const colNames = columns.map(c => c.columnName).join(", ");
        const values = columns.map((_, i) => `$${i + 1}`).join(", ");
        return `INSERT INTO ${tableName} (${colNames}) VALUES (${values})`;
    }

    generateUpdateSql(tableName: string, columns: ColumnMetadata[], pkColumn: ColumnMetadata): string {
        const setClause = columns.map((c, i) => `${c.columnName} = $${i + 1}`).join(", ");
        return `UPDATE ${tableName} SET ${setClause} WHERE ${pkColumn.columnName} = $${columns.length + 1}`;
    }

    generateDeleteSql(tableName: string, pkColumn: ColumnMetadata): string {
        return `DELETE FROM ${tableName} WHERE ${pkColumn.columnName} = $1`;
    }

    generateSelectSql(tableName: string, whereClause?: string): string {
        const where = whereClause ? ` ${whereClause}` : "";
        return `SELECT * FROM ${tableName}${where}`;
    }

    getParameterPlaceholder(index: number): string {
        return `$${index}`;
    }

    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] } {
        return {
            sql: `
                SELECT column_name, data_type
                FROM information_schema.columns
                WHERE table_name = $1;
            `,
            params: [tableName],
        };
    }

    normalizeType(dbType: string): string {
        const normalized = dbType.toLowerCase();

        // Map PostgreSQL types to normalized types
        const typeMap: Record<string, string> = {
            'character varying': 'varchar',
            'timestamp without time zone': 'timestamp',
            'timestamp with time zone': 'timestamp',
            'double precision': 'double',
        };

        return typeMap[normalized] || normalized;
    }

    getAutoIncrementType(): string {
        return 'SERIAL';
    }

    isTypeMismatch(entityType: string, dbType: string): boolean {
        const normalizedEntity = this.normalizeType(entityType.toLowerCase());
        const normalizedDb = this.normalizeType(dbType.toLowerCase());

        // Simple comparison
        if (normalizedEntity === 'integer' && normalizedDb !== 'integer') return true;
        if (normalizedEntity === 'text' && normalizedDb !== 'text') return true;
        if (normalizedEntity === 'boolean' && normalizedDb !== 'boolean') return true;
        if (normalizedEntity.startsWith('varchar') && normalizedDb !== 'varchar') return true;
        if (normalizedEntity === 'timestamp' && !normalizedDb.includes('timestamp')) return true;

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
            ${column1} INTEGER NOT NULL,
            ${column2} INTEGER NOT NULL,
            PRIMARY KEY (${column1}, ${column2}),
            FOREIGN KEY (${column1}) REFERENCES ${referencedTable1}(id)${cascadeClause},
            FOREIGN KEY (${column2}) REFERENCES ${referencedTable2}(id)${cascadeClause}
        )`;
    }
}
