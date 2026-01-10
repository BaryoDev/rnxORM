import { DbContext } from "./DbContext";
import { MetadataStorage, RelationType } from "./MetadataStorage";

/**
 * Represents a collection of entities in the database.
 * @template T The type of entity.
 */
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

        const provider = this.context.getProvider();

        // Exclude serial/auto-increment PK
        const columns = metadata.columns.filter(c => !c.isPrimaryKey || c.type !== 'integer');
        const params = columns.map(c => (entity as any)[c.propertyName]);

        const sql = provider.generateInsertSql(this.tableName, columns);
        await this.context.query(sql, params);
    }

    async toList(): Promise<T[]> {
        const provider = this.context.getProvider();
        const sql = provider.generateSelectSql(this.tableName);
        const res = await this.context.query(sql);
        return res.rows.map((row: any) => this.mapRowToEntity(row));
    }

    // Simple Fluent API for WHERE
    // usage: dbSet.where("age", ">", 18).toList()
    where(column: string, operator: string, value: any): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).where(column, operator, value);
    }

    /**
     * Include a related entity in the query (eager loading)
     * @param relation The relation property selector
     * @returns QueryBuilder with include
     *
     * @example
     * await dbSet.include(post => post.author).toList();
     */
    include(relation: (entity: T) => any): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).include(relation);
    }

    /**
     * Returns a query builder with no-tracking enabled.
     * Entities returned will be frozen (read-only) for better performance.
     * @returns QueryBuilder with no-tracking enabled
     */
    asNoTracking(): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName, false, true);
    }

    /**
     * Order results by column ascending
     */
    orderBy(column: string): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).orderBy(column);
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: string): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).orderByDescending(column);
    }

    /**
     * Skip N results (pagination)
     */
    skip(count: number): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).skip(count);
    }

    /**
     * Take N results (limit)
     */
    take(count: number): QueryBuilder<T> {
        return new QueryBuilder(this.entityType, this.context, this.tableName).take(count);
    }

    /**
     * Finds an entity by its primary key value.
     * @param id - The primary key value
     * @returns The entity if found, null otherwise
     */
    async find(id: any): Promise<T | null> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return null;

        const pkColumn = metadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) throw new Error("Primary key not defined");

        const provider = this.context.getProvider();
        const placeholder = provider.getParameterPlaceholder(1);
        const sql = `SELECT * FROM ${this.tableName} WHERE ${pkColumn.columnName} = ${placeholder}`;
        const res = await this.context.query(sql, [id]);

        if (res.rows.length === 0) return null;
        return this.mapRowToEntity(res.rows[0]);
    }

    async update(entity: T): Promise<void> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return;

        const pkColumn = metadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) throw new Error("Primary key not defined");

        const provider = this.context.getProvider();
        const columns = metadata.columns.filter(c => !c.isPrimaryKey);
        const params = columns.map(c => (entity as any)[c.propertyName]);

        const pkValue = (entity as any)[pkColumn.propertyName];
        params.push(pkValue);

        const sql = provider.generateUpdateSql(this.tableName, columns, pkColumn);
        await this.context.query(sql, params);
    }

    async remove(entity: T): Promise<void> {
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return;

        const pkColumn = metadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) throw new Error("Primary key not defined");

        const provider = this.context.getProvider();
        const pkValue = (entity as any)[pkColumn.propertyName];

        const sql = provider.generateDeleteSql(this.tableName, pkColumn);
        await this.context.query(sql, [pkValue]);
    }

    /**
     * Count all entities
     */
    async count(): Promise<number> {
        const res = await this.context.query(`SELECT COUNT(*) as count FROM ${this.tableName}`);
        return parseInt(res.rows[0].count);
    }

    private mapRowToEntity(row: any, freeze: boolean = false): T {
        const entity = new this.entityType();
        const metadata = MetadataStorage.get().getEntity(this.entityType);
        metadata?.columns.forEach(col => {
            (entity as any)[col.propertyName] = row[col.columnName];
        });
        return freeze ? Object.freeze(entity) : entity;
    }

    /**
     * Shared helper to map database rows to entities
     * @internal
     */
    static mapRowToEntity<T>(entityType: new () => T, row: any, freeze: boolean = false): T {
        const entity = new entityType();
        const metadata = MetadataStorage.get().getEntity(entityType);
        metadata?.columns.forEach(col => {
            (entity as any)[col.propertyName] = row[col.columnName];
        });
        return freeze ? Object.freeze(entity) : entity;
    }
}

interface IncludeInfo {
    propertyName: string;
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    relatedEntityType: Function;
}

export class QueryBuilder<T> {
    private conditions: string[] = [];
    private params: any[] = [];
    private noTracking: boolean = false;
    private includes: IncludeInfo[] = [];
    private orderByColumns: { column: string; direction: 'ASC' | 'DESC' }[] = [];
    private skipCount?: number;
    private takeCount?: number;

    constructor(
        private entityType: new () => T,
        private context: DbContext,
        private tableName: string,
        private loadEager: boolean = false,
        noTracking: boolean = false
    ) {
        this.noTracking = noTracking;
    }

    where(column: string, operator: string, value: any): this {
        const provider = this.context.getProvider();
        const placeholder = provider.getParameterPlaceholder(this.params.length + 1);
        this.conditions.push(`${column} ${operator} ${placeholder}`);
        this.params.push(value);
        return this;
    }

    /**
     * Include related entities (eager loading)
     */
    include(relation: (entity: T) => any): this {
        const propertyName = extractPropertyName(relation);
        const metadata = MetadataStorage.get().getEntity(this.entityType);

        if (!metadata) {
            throw new Error(`Entity ${this.entityType.name} not found in metadata`);
        }

        const relationMetadata = metadata.relations.find(r => r.propertyName === propertyName);
        if (!relationMetadata) {
            throw new Error(`Relation ${propertyName} not found on ${this.entityType.name}`);
        }

        this.includes.push({
            propertyName,
            relatedEntityType: relationMetadata.relatedEntity(),
        });

        return this;
    }

    /**
     * Order results by column ascending
     */
    orderBy(column: string): this {
        this.orderByColumns.push({ column, direction: 'ASC' });
        return this;
    }

    /**
     * Order results by column descending
     */
    orderByDescending(column: string): this {
        this.orderByColumns.push({ column, direction: 'DESC' });
        return this;
    }

    /**
     * Skip N results (for pagination)
     */
    skip(count: number): this {
        this.skipCount = count;
        return this;
    }

    /**
     * Take N results (limit)
     */
    take(count: number): this {
        this.takeCount = count;
        return this;
    }

    /**
     * Enables no-tracking mode for this query.
     * Entities will be frozen (read-only) for better performance.
     * @returns This query builder
     */
    asNoTracking(): this {
        this.noTracking = true;
        return this;
    }

    async toList(): Promise<T[]> {
        let whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";

        // Add ORDER BY clause
        if (this.orderByColumns.length > 0) {
            const orderByClause = this.orderByColumns
                .map(o => `${o.column} ${o.direction}`)
                .join(', ');
            whereClause += (whereClause ? ' ' : '') + `ORDER BY ${orderByClause}`;
        }

        // Add LIMIT/OFFSET (database-specific)
        if (this.takeCount !== undefined) {
            whereClause += ` LIMIT ${this.takeCount}`;
        }
        if (this.skipCount !== undefined) {
            whereClause += ` OFFSET ${this.skipCount}`;
        }

        const provider = this.context.getProvider();
        const sql = provider.generateSelectSql(this.tableName, whereClause);
        const res = await this.context.query(sql, this.params);

        // Map rows to entities
        const entities = res.rows.map((row: any) =>
            DbSet.mapRowToEntity(this.entityType, row, this.noTracking)
        );

        // Load includes (eager loading)
        if (this.includes.length > 0) {
            await this.loadIncludes(entities);
        }

        return entities;
    }

    /**
     * Get the first result or null
     */
    async first(): Promise<T | null> {
        const results = await this.take(1).toList();
        return results.length > 0 ? results[0] : null;
    }

    /**
     * Count results
     */
    async count(): Promise<number> {
        const whereClause = this.conditions.length > 0 ? `WHERE ${this.conditions.join(" AND ")}` : "";
        const sql = `SELECT COUNT(*) as count FROM ${this.tableName} ${whereClause}`;
        const res = await this.context.query(sql, this.params);
        return parseInt(res.rows[0].count);
    }

    /**
     * Check if any results exist
     */
    async any(): Promise<boolean> {
        const count = await this.count();
        return count > 0;
    }

    private async loadIncludes(entities: T[]): Promise<void> {
        if (entities.length === 0) return;

        const metadata = MetadataStorage.get().getEntity(this.entityType);
        if (!metadata) return;

        for (const include of this.includes) {
            const relationMetadata = metadata.relations.find(r => r.propertyName === include.propertyName);
            if (!relationMetadata) continue;

            const relatedMetadata = MetadataStorage.get().getEntity(include.relatedEntityType);
            if (!relatedMetadata) continue;

            const relatedPkColumn = relatedMetadata.columns.find(c => c.isPrimaryKey);
            if (!relatedPkColumn) continue;

            // Handle different relation types
            if (relationMetadata.relationType === RelationType.ManyToOne || relationMetadata.relationType === RelationType.OneToOne) {
                // Load the single related entity
                await this.loadManyToOneRelation(entities, relationMetadata, relatedMetadata, relatedPkColumn.columnName);
            } else if (relationMetadata.relationType === RelationType.OneToMany) {
                // Load the collection of related entities
                await this.loadOneToManyRelation(entities, relationMetadata, relatedMetadata);
            } else if (relationMetadata.relationType === RelationType.ManyToMany) {
                // Load many-to-many relation through join table
                await this.loadManyToManyRelation(entities, relationMetadata, relatedMetadata);
            }
        }
    }

    private async loadManyToOneRelation(
        entities: T[],
        relationMetadata: any,
        relatedMetadata: any,
        relatedPkColumn: string
    ): Promise<void> {
        const foreignKeyColumn = relationMetadata.foreignKeyColumn;
        if (!foreignKeyColumn) return;

        // Get all unique foreign key values
        const foreignKeyValues = entities
            .map(e => (e as any)[foreignKeyColumn])
            .filter(v => v !== null && v !== undefined);

        if (foreignKeyValues.length === 0) return;

        // Load related entities
        const uniqueFkValues = [...new Set(foreignKeyValues)];
        const placeholders = uniqueFkValues.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const sql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${relatedPkColumn} IN (${placeholders})`;
        const res = await this.context.query(sql, uniqueFkValues);

        // Map related entities by their primary key
        const relatedEntitiesMap = new Map();
        res.rows.forEach((row: any) => {
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking);
            relatedEntitiesMap.set(row[relatedPkColumn], relatedEntity);
        });

        // Attach related entities to main entities
        entities.forEach(entity => {
            const fkValue = (entity as any)[foreignKeyColumn];
            if (fkValue && relatedEntitiesMap.has(fkValue)) {
                (entity as any)[relationMetadata.propertyName] = relatedEntitiesMap.get(fkValue);
            }
        });
    }

    private async loadOneToManyRelation(
        entities: T[],
        relationMetadata: any,
        relatedMetadata: any
    ): Promise<void> {
        const entityMetadata = MetadataStorage.get().getEntity(this.entityType);
        if (!entityMetadata) return;

        const pkColumn = entityMetadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) return;

        // Find the foreign key column on the related entity
        const inverseSide = relationMetadata.inverseSide;
        const relatedRelation = relatedMetadata.relations.find((r: any) => r.propertyName === inverseSide);
        if (!relatedRelation || !relatedRelation.foreignKeyColumn) return;

        const foreignKeyColumn = relatedRelation.foreignKeyColumn;

        // Get all primary key values
        const pkValues = entities.map(e => (e as any)[pkColumn.propertyName]);

        // Load all related entities
        const placeholders = pkValues.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const sql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${foreignKeyColumn} IN (${placeholders})`;
        const res = await this.context.query(sql, pkValues);

        // Group related entities by foreign key
        const relatedEntitiesMap = new Map<any, any[]>();
        res.rows.forEach((row: any) => {
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking);
            const fkValue = row[foreignKeyColumn];

            if (!relatedEntitiesMap.has(fkValue)) {
                relatedEntitiesMap.set(fkValue, []);
            }
            relatedEntitiesMap.get(fkValue)!.push(relatedEntity);
        });

        // Attach collections to main entities
        entities.forEach(entity => {
            const pkValue = (entity as any)[pkColumn.propertyName];
            (entity as any)[relationMetadata.propertyName] = relatedEntitiesMap.get(pkValue) || [];
        });
    }

    private async loadManyToManyRelation(
        entities: T[],
        relationMetadata: any,
        relatedMetadata: any
    ): Promise<void> {
        if (!relationMetadata.joinTable) return;

        const entityMetadata = MetadataStorage.get().getEntity(this.entityType);
        if (!entityMetadata) return;

        const pkColumn = entityMetadata.columns.find(c => c.isPrimaryKey);
        if (!pkColumn) return;

        const pkValues = entities.map(e => (e as any)[pkColumn.propertyName]);

        // Query join table
        const placeholders = pkValues.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const joinSql = `SELECT * FROM ${relationMetadata.joinTable} WHERE ${relationMetadata.joinColumn} IN (${placeholders})`;
        const joinRes = await this.context.query(joinSql, pkValues);

        if (joinRes.rows.length === 0) {
            // No related entities
            entities.forEach(entity => {
                (entity as any)[relationMetadata.propertyName] = [];
            });
            return;
        }

        // Get related entity IDs
        const relatedIds = joinRes.rows.map((r: any) => r[relationMetadata.inverseJoinColumn!]);
        const uniqueRelatedIds = [...new Set(relatedIds)];

        // Load related entities
        const relatedPkColumn = relatedMetadata.columns.find((c: any) => c.isPrimaryKey);
        if (!relatedPkColumn) return;

        const relatedPlaceholders = uniqueRelatedIds.map((_, i) => this.context.getProvider().getParameterPlaceholder(i + 1)).join(', ');
        const relatedSql = `SELECT * FROM ${relatedMetadata.tableName} WHERE ${relatedPkColumn.columnName} IN (${relatedPlaceholders})`;
        const relatedRes = await this.context.query(relatedSql, uniqueRelatedIds);

        // Map related entities
        const relatedEntitiesMap = new Map();
        relatedRes.rows.forEach((row: any) => {
            const relatedEntity = DbSet.mapRowToEntity(relationMetadata.relatedEntity(), row, this.noTracking);
            relatedEntitiesMap.set(row[relatedPkColumn.columnName], relatedEntity);
        });

        // Group by source entity
        const relationMap = new Map<any, any[]>();
        joinRes.rows.forEach((joinRow: any) => {
            const sourceId = joinRow[relationMetadata.joinColumn!];
            const targetId = joinRow[relationMetadata.inverseJoinColumn!];

            if (!relationMap.has(sourceId)) {
                relationMap.set(sourceId, []);
            }

            if (relatedEntitiesMap.has(targetId)) {
                relationMap.get(sourceId)!.push(relatedEntitiesMap.get(targetId));
            }
        });

        // Attach to entities
        entities.forEach(entity => {
            const pkValue = (entity as any)[pkColumn.propertyName];
            (entity as any)[relationMetadata.propertyName] = relationMap.get(pkValue) || [];
        });
    }
}

// Helper function to extract property name from lambda
function extractPropertyName(fn: (entity: any) => any): string {
    const fnStr = fn.toString();
    const match = fnStr.match(/(?:=>|return)\s*\w+\.(\w+)/);
    if (match && match[1]) {
        return match[1];
    }
    throw new Error(`Unable to extract property name from function: ${fnStr}`);
}
