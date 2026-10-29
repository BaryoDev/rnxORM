/** A column as declared in a createTable operation. Types are raw strings and are validated by the translator. */
export interface DdlColumn {
    name: string;
    type: string;
    nullable?: boolean;
    defaultValue?: unknown;
    isPrimaryKey?: boolean;
    isAutoIncrement?: boolean;
}

export type ReferentialDeleteAction = 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION';

export interface CreateTableOp {
    op: 'createTable';
    table: string;
    columns: DdlColumn[];
}

export interface DropTableOp {
    op: 'dropTable';
    table: string;
}

export interface AddColumnOp {
    op: 'addColumn';
    table: string;
    column: string;
    type: string;
    nullable?: boolean;
    defaultValue?: unknown;
}

export interface DropColumnOp {
    op: 'dropColumn';
    table: string;
    column: string;
}

export interface AlterColumnOp {
    op: 'alterColumn';
    table: string;
    column: string;
    type: string;
    nullable?: boolean;
    defaultValue?: unknown;
}

export interface RenameColumnOp {
    op: 'renameColumn';
    table: string;
    from: string;
    to: string;
}

export interface RenameTableOp {
    op: 'renameTable';
    from: string;
    to: string;
}

export interface CreateIndexOp {
    op: 'createIndex';
    table: string;
    index: string;
    columns: string[];
    unique: boolean;
}

export interface DropIndexOp {
    op: 'dropIndex';
    table: string;
    index: string;
}

export interface AddForeignKeyOp {
    op: 'addForeignKey';
    table: string;
    constraint: string;
    column: string;
    referencedTable: string;
    referencedColumn: string;
    onDelete: ReferentialDeleteAction;
}

export interface DropForeignKeyOp {
    op: 'dropForeignKey';
    table: string;
    constraint: string;
}

/** Creates the migration history table if it is missing. `table` is a trusted constant, not user input. */
export interface CreateMigrationHistoryOp {
    op: 'createMigrationHistory';
    table: string;
}

export type DdlOperation =
    | CreateTableOp
    | DropTableOp
    | AddColumnOp
    | DropColumnOp
    | AlterColumnOp
    | RenameColumnOp
    | RenameTableOp
    | CreateIndexOp
    | DropIndexOp
    | AddForeignKeyOp
    | DropForeignKeyOp
    | CreateMigrationHistoryOp;
