export interface ColumnMetadata {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    target: Function;
    propertyName: string;
    columnName: string;
    type: string;
    isPrimaryKey: boolean;
    isNullable: boolean;
}

export interface EntityMetadata {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    addEntity(target: Function, tableName: string) {
        console.log(`MetadataStorage: Adding entity ${target.name} -> ${tableName}`);
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    getEntity(target: Function): EntityMetadata | undefined {
        const entity = this.entities.find((e) => e.target === target);
        console.log(`MetadataStorage: Getting entity ${target.name} -> ${entity ? 'Found' : 'Not Found'}`);
        return entity;
    }

    getEntities(): EntityMetadata[] {
        return this.entities;
    }
}
