import * as mssql from "mssql";
import { DatabaseConfig, IDatabaseProvider, QueryResult } from "./IDatabaseProvider";
import { ColumnMetadata, EntityMetadata } from "../core/MetadataStorage";

/**
 * Microsoft SQL Server database provider implementation
 */
export class MSSQLProvider implements IDatabaseProvider {
    private pool: mssql.ConnectionPool | null = null;
    private transaction: mssql.Transaction | null = null;
    private config: mssql.config;

    constructor(config: DatabaseConfig) {
        this.config = {
            server: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            options: {
                encrypt: false, // Use true for Azure
                trustServerCertificate: true,
            },
            pool: {
                max: config.max || 10,
                min: config.min || 0,
                idleTimeoutMillis: config.idleTimeoutMillis || 30000,
            },
        };
    }

    async connect(): Promise<void> {
        this.pool = await mssql.connect(this.config);
    }

    async disconnect(): Promise<void> {
        if (this.pool) {
            await this.pool.close();
            this.pool = null;
        }
    }

    async query(text: string, params?: any[]): Promise<QueryResult> {
        if (!this.pool) {
            throw new Error("Not connected to database");
        }

        const request = this.transaction
            ? new mssql.Request(this.transaction)
            : this.pool.request();

        // Add parameters
        if (params) {
            params.forEach((param, index) => {
                request.input(`p${index}`, param);
            });
        }

        const result = await request.query(text);

        return {
            rows: result.recordset || [],
            rowCount: result.rowsAffected[0] || 0,
        };
    }

    async beginTransaction(): Promise<void> {
        if (!this.pool) await this.connect();
        this.transaction = new mssql.Transaction(this.pool!);
        await this.transaction.begin();
    }

    async commitTransaction(): Promise<void> {
        if (this.transaction) {
            await this.transaction.commit();
            this.transaction = null;
        }
    }

    async rollbackTransaction(): Promise<void> {
        if (this.transaction) {
            await this.transaction.rollback();
            this.transaction = null;
        }
    }

    mapType(tsType: string): string {
        // Map TypeScript types to SQL Server types
        const typeMap: Record<string, string> = {
            text: 'NVARCHAR(MAX)',
            integer: 'INT',
            boolean: 'BIT',
            timestamp: 'DATETIME2',
            date: 'DATE',
            time: 'TIME',
            decimal: 'DECIMAL(18,2)',
            float: 'REAL',
            double: 'FLOAT',
            bigint: 'BIGINT',
            json: 'NVARCHAR(MAX)', // SQL Server 2016+ supports JSON functions
        };

        const lowerType = tsType.toLowerCase();

        // Check if it's a custom type (e.g., varchar(50))
        if (lowerType.startsWith('varchar')) {
            return 'N' + tsType.toUpperCase(); // Use NVARCHAR for SQL Server
        }
        if (lowerType.startsWith('nvarchar') || lowerType.startsWith('decimal')) {
            return tsType.toUpperCase();
        }

        return typeMap[lowerType] || tsType.toUpperCase();
    }

    generateCreateTableSql(entity: EntityMetadata): string {
        const columns = entity.columns.map((col) => {
            let colDef = `${col.columnName} ${this.mapType(col.type)}`;

            if (col.isPrimaryKey) {
                // If it's an integer PK, make it IDENTITY for auto-increment
                if (col.type === "integer") {
                    colDef = `${col.columnName} INT IDENTITY(1,1) PRIMARY KEY`;
                } else {
                    colDef += " PRIMARY KEY";
                }
            } else if (!col.isNullable) {
                colDef += " NOT NULL";
            }

            return colDef;
        });

        return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${entity.tableName}')
                CREATE TABLE ${entity.tableName} (${columns.join(", ")});`;
    }

    generateAddColumnSql(tableName: string, column: ColumnMetadata): string {
        const colDef = this.mapType(column.type);
        return `ALTER TABLE ${tableName} ADD ${column.columnName} ${colDef}`;
    }

    generateAlterColumnTypeSql(tableName: string, column: ColumnMetadata): string {
        // SQL Server doesn't support USING clause like PostgreSQL
        // Need to convert data manually if needed
        return `ALTER TABLE ${tableName} ALTER COLUMN ${column.columnName} ${this.mapType(column.type)}`;
    }

    generateInsertSql(tableName: string, columns: ColumnMetadata[]): string {
        const colNames = columns.map(c => c.columnName).join(", ");
        const values = columns.map((_, i) => `@p${i}`).join(", ");
        return `INSERT INTO ${tableName} (${colNames}) VALUES (${values})`;
    }

    generateUpdateSql(tableName: string, columns: ColumnMetadata[], pkColumn: ColumnMetadata): string {
        const setClause = columns.map((c, i) => `${c.columnName} = @p${i}`).join(", ");
        return `UPDATE ${tableName} SET ${setClause} WHERE ${pkColumn.columnName} = @p${columns.length}`;
    }

    generateDeleteSql(tableName: string, pkColumn: ColumnMetadata): string {
        return `DELETE FROM ${tableName} WHERE ${pkColumn.columnName} = @p0`;
    }

    generateSelectSql(tableName: string, whereClause?: string): string {
        const where = whereClause ? ` ${whereClause}` : "";
        return `SELECT * FROM ${tableName}${where}`;
    }

    getParameterPlaceholder(index: number): string {
        return `@p${index}`;
    }

    getSchemaColumnsQuery(tableName: string): { sql: string; params: any[] } {
        return {
            sql: `
                SELECT COLUMN_NAME as column_name, DATA_TYPE as data_type
                FROM INFORMATION_SCHEMA.COLUMNS
                WHERE TABLE_NAME = @p0;
            `,
            params: [tableName],
        };
    }

    normalizeType(dbType: string): string {
        const normalized = dbType.toLowerCase();

        // Map SQL Server types to normalized types
        const typeMap: Record<string, string> = {
            'nvarchar': 'varchar',
            'int': 'integer',
            'bit': 'boolean',
            'datetime2': 'timestamp',
            'datetime': 'timestamp',
        };

        return typeMap[normalized] || normalized;
    }

    getAutoIncrementType(): string {
        return 'IDENTITY(1,1)';
    }

    isTypeMismatch(entityType: string, dbType: string): boolean {
        const normalizedEntity = this.normalizeType(entityType.toLowerCase());
        const normalizedDb = this.normalizeType(dbType.toLowerCase());

        // Simple comparison
        if (normalizedEntity === 'integer' && normalizedDb !== 'integer') return true;
        if (normalizedEntity === 'text' && !normalizedDb.includes('varchar')) return true;
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
        const constraintName = `FK_${tableName}_${columnName}`;
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

        return `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${joinTableName}')
                CREATE TABLE ${joinTableName} (
                    ${column1} INT NOT NULL,
                    ${column2} INT NOT NULL,
                    PRIMARY KEY (${column1}, ${column2}),
                    FOREIGN KEY (${column1}) REFERENCES ${referencedTable1}(id)${cascadeClause},
                    FOREIGN KEY (${column2}) REFERENCES ${referencedTable2}(id)${cascadeClause}
                )`;
    }
}
