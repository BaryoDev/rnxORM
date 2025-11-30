import { Pool, PoolClient, PoolConfig } from "pg";
import { DbSet } from "./DbSet";

/**
 * Represents a session with the database and can be used to query and save instances of your entities.
 */
export class DbContext {
    private pool: Pool;
    private client: PoolClient | null = null;

    constructor(config: PoolConfig) {
        this.pool = new Pool(config);
    }

    /**
     * Connects to the database.
     */
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

    async query(text: string, params?: any[]): Promise<any> {
        if (!this.client) {
            // Auto-connect if not connected, or just use pool.query for stateless queries
            return this.pool.query(text, params);
        }
        return this.client.query(text, params);
    }

    // Placeholder for transaction management
    async beginTransaction() {
        if (!this.client) await this.connect();
        await this.client?.query('BEGIN');
    }

    async commitTransaction() {
        await this.client?.query('COMMIT');
    }

    async rollbackTransaction() {
        await this.client?.query('ROLLBACK');
    }

    async ensureCreated(): Promise<void> {
        const { MetadataStorage } = await import("./MetadataStorage");
        const entities = MetadataStorage.get().getEntities();

        for (const entity of entities) {
            const columns = entity.columns.map((col) => {
                let colDef = `${col.columnName} ${col.type.toUpperCase()}`;
                if (col.isPrimaryKey) {
                    colDef += " PRIMARY KEY";
                    // If it's an integer PK, make it SERIAL for auto-increment
                    if (col.type === "integer") {
                        colDef = `${col.columnName} SERIAL PRIMARY KEY`;
                    }
                }
                if (!col.isNullable && !col.isPrimaryKey) {
                    colDef += " NOT NULL";
                }
                return colDef;
            });

            const createTableSql = `CREATE TABLE IF NOT EXISTS ${entity.tableName} (${columns.join(", ")});`;
            await this.query(createTableSql);

            // Schema Evolution: Check for missing columns and type mismatches
            const existingColumnsRes = await this.query(`
                SELECT column_name, data_type 
                FROM information_schema.columns 
                WHERE table_name = $1;
            `, [entity.tableName]);

            const existingColumns = new Map(existingColumnsRes.rows.map((r: any) => [r.column_name.toLowerCase(), r.data_type.toLowerCase()]));

            for (const col of entity.columns) {
                const colName = col.columnName.toLowerCase();
                const existingType = existingColumns.get(colName);

                if (!existingType) {
                    console.log(`Detected missing column '${col.columnName}' in table '${entity.tableName}'. Adding it...`);
                    let colDef = `${col.type.toUpperCase()}`;
                    const alterTableSql = `ALTER TABLE ${entity.tableName} ADD COLUMN ${col.columnName} ${colDef}`;
                    await this.query(alterTableSql);
                } else {
                    // Check for type mismatch
                    // Simple normalization for comparison
                    const targetType = col.type.toLowerCase();
                    let isMismatch = false;

                    // Basic mapping check
                    if (targetType === 'integer' && existingType !== 'integer') isMismatch = true;
                    else if (targetType === 'text' && existingType !== 'text') isMismatch = true;
                    else if (targetType === 'boolean' && existingType !== 'boolean') isMismatch = true;
                    // For custom types like varchar(50), existingType is 'character varying'
                    // We won't be too strict on length changes for now, just base type
                    else if (targetType.startsWith('varchar') && existingType !== 'character varying') isMismatch = true;
                    else if (targetType === 'timestamp' && !(existingType as string).includes('timestamp')) isMismatch = true;

                    if (isMismatch) {
                        console.warn(`WARNING: Type mismatch detected for column '${col.columnName}'. DB: '${existingType}', Entity: '${targetType}'. Attempting migration...`);
                        try {
                            // Attempt to alter column type with implicit casting
                            const alterColumnSql = `ALTER TABLE ${entity.tableName} ALTER COLUMN ${col.columnName} TYPE ${col.type} USING ${col.columnName}::${col.type}`;
                            await this.query(alterColumnSql);
                            console.log(`SUCCESS: Migrated column '${col.columnName}' to '${col.type}'.`);
                        } catch (error: any) {
                            console.error(`ERROR: Failed to migrate column '${col.columnName}' from '${existingType}' to '${targetType}'. Data might be incompatible.`);
                            console.error(`Details: ${error.message}`);
                        }
                    }
                }
            }
        }
    }

    set<T>(entityType: new () => T): DbSet<T> {
        return new DbSet(entityType, this);
    }
}
