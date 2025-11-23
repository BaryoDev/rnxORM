export interface ColumnMetadata {
    target: Function;
    propertyName: string;
    columnName: string;
    type: string;
    isPrimaryKey: boolean;
    isNullable: boolean;
}

export interface EntityMetadata {
    target: Function;
    tableName: string;
    columns: ColumnMetadata[];
}

export class MetadataStorage {
    private static instance: MetadataStorage;
    private entities: EntityMetadata[] = [];

    private constructor() { }

    static get(): MetadataStorage {
        if (!MetadataStorage.instance) {
            MetadataStorage.instance = new MetadataStorage();
        }
        return MetadataStorage.instance;
    }

    addEntity(target: Function, tableName: string) {
        let entity = this.entities.find((e) => e.target === target);
        if (entity) {
            entity.tableName = tableName;
        } else {
            this.entities.push({
                target,
                tableName,
                columns: [],
            });
        }
    }

    addColumn(target: Function, propertyName: string, options: Partial<ColumnMetadata> = {}) {
        let entity = this.entities.find((e) => e.target === target);
        if (!entity) {
            entity = {
                target,
                tableName: target.name.toLowerCase(), // Default table name
                columns: [],
            };
            this.entities.push(entity);
        }

        entity.columns.push({
            target,
            propertyName,
            columnName: options.columnName || propertyName,
            type: options.type || "text", // Default type, will be inferred later if possible
            isPrimaryKey: options.isPrimaryKey || false,
            isNullable: options.isNullable || false,
        });
    }

    getEntity(target: Function): EntityMetadata | undefined {
        return this.entities.find((e) => e.target === target);
    }

    getEntities(): EntityMetadata[] {
        return this.entities;
    }
}
