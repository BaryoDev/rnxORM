import "reflect-metadata";
import { MetadataStorage } from "../core/MetadataStorage";

export function Entity(tableName?: string) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
    return function (target: Function) {
        MetadataStorage.get().addEntity(target, tableName || target.name.toLowerCase());
    };
}

export interface ColumnOptions {
    name?: string;
    type?: string;
    nullable?: boolean;
}

export function Column(options: ColumnOptions = {}) {
    return function (target: object, propertyName: string) {
        const designType = Reflect.getMetadata("design:type", target, propertyName);
        let type = options.type;

        if (!type && designType) {
            if (designType === String) type = "text";
            else if (designType === Number) type = "integer";
            else if (designType === Boolean) type = "boolean";
            else if (designType === Date) type = "timestamp";
        }

        MetadataStorage.get().addColumn(target.constructor, propertyName, {
            columnName: options.name || propertyName.toLowerCase(),
            type,
            isNullable: options.nullable,
        });
    };
}

export function PrimaryKey() {
    return function (target: object, propertyName: string) {
        const designType = Reflect.getMetadata("design:type", target, propertyName);
        let type = "integer"; // Default PK type

        if (designType === String) type = "text";

        MetadataStorage.get().addColumn(target.constructor, propertyName, {
            isPrimaryKey: true,
            type
        });
    };
}
