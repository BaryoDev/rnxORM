import { DbContext } from "./DbContext";
import { MetadataStorage } from "./MetadataStorage";

export class DbSet<T> {
    private tableName: string;
    private columns: string[];

    constructor(private entityType: new () => T, private context: DbContext) {
        const metadata = MetadataStorage.get().getEntity(entityType);
        if (!metadata) {
            throw new Error(`Entity ${entityType.name} not found in metadata.`);
        }
        this.tableName = metadata.tableName;
        this.columns = metadata.columns.map(c => c.columnName);
    }

    async add(entity: T): Promise<void> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return;

        const columns = metadata.columns.filter(c => !c.isPrimaryKey || c.type !== 'integer'); // Exclude serial PK
        const colNames = columns.map(c => c.columnName).join(", ");
        const values = columns.map((c, i) => `$${i + 1}`).join(", ");
        const params = columns.map(c => (entity as any)[c.propertyName]);

        const sql = `INSERT INTO ${this.tableName} (${colNames}) VALUES (${values})`;
        await this.context.query(sql, params);
    }

    async toList(): Promise<T[]> {
        const res = await this.context.query(`SELECT * FROM ${this.tableName}`);
        return res.rows.map((row: any) => this.mapRowToEntity(row));
    }

    // Simple Fluent API for WHERE
    // usage: dbSet.where("age", ">", 18).toList()
    where(column: string, operator: string, value: any): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).where(column, operator, value);
    }

    async update(entity: T): Promise<void> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return;

        const pkColumn = metadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) throw new Error("Primary key not defined");

        const columns = metadata.columns.filter(c => !c.isPrimaryKey);
        const setClause = columns.map((c, i) => `${c.columnName} = $${i + 1}`).join(", ");
        const params = columns.map(c => (entity as any)[c.propertyName]);

        const pkValue = (entity as any)[pkColumn.propertyName];
        params.push(pkValue);

        const sql = `UPDATE ${this.tableName} SET ${setClause} WHERE ${pkColumn.columnName} = $${params.length}`;
        await this.context.query(sql, params);
    }

    async remove(entity: T): Promise<void> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return;

        const pkColumn = metadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) throw new Error("Primary key not defined");

        const pkValue = (entity as any)[pkColumn.propertyName];
        const sql = `DELETE FROM ${this.tableName} WHERE ${pkColumn.columnName} = $1`;
        await this.context.query(sql, [pkValue]);
    }

    private mapRowToEntity(row: any): T {
        const entity = new this.entityType();
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        metadata?.columns.forEach(col => {
            (entity as any)[col.propertyName] = row[col.columnName];
        });
        return entity;
    }
}

export class QueryBuilder<T> {
    private conditions: string[] = [];
    private params: any[] = [];

    constructor(private entityType: new () => T, private context: DbContext, private tableName: string) { }

    where(column: string, operator: string, value: any): this {
        this.conditions.push(`${column} ${operator} $${this.params.length + 1}`);
        this.params.push(value);
        return this;
    }

    async toList(): Promise<T[]> {
        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT * FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, this.params);

        // Mapping logic (duplicated for now, should be shared)
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        return res.rows.map((row: any) => {
            const entity = new this.entityType();
            metadata?.columns.forEach(col => {
                (entity as any)[col.propertyName] = row[col.columnName];
            });
            return entity;
        });
    }
}
