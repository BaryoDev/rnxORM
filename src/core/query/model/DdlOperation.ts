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

/**
 * The operations below are what `ensureCreated` emits. Names are written bare
 * (no validation, no quoting) and column types are logical ones the
 * translator maps, which is how that path has always behaved.
 */
export interface EnsureColumn {
    name: string;
    /** A logical type such as `integer` or `varchar(50)`. */
    type: string;
    isPrimaryKey: boolean;
    nullable: boolean;
}

/** Creates the table if it is missing. An integer primary key becomes the dialect's auto-increment column. */
export interface EnsureTableOp {
    op: 'ensureTable';
    table: string;
    columns: EnsureColumn[];
}

/** Creates a many-to-many join table if it is missing. Referenced columns default to `id`, delete action to CASCADE. */
export interface EnsureJoinTableOp {
    op: 'ensureJoinTable';
    table: string;
    column1: string;
    column2: string;
    referencedTable1: string;
    referencedTable2: string;
    referencedColumn1?: string;
    referencedColumn2?: string;
    onDelete?: string;
}

/** Adds a foreign key named `fk_<table>_<column>`. */
export interface EnsureForeignKeyOp {
    op: 'ensureForeignKey';
    table: string;
    column: string;
    referencedTable: string;
    referencedColumn: string;
    onDelete?: string;
    onUpdate?: string;
}

export interface EnsureIndexOp {
    op: 'ensureIndex';
    table: string;
    index: string;
    columns: string[];
    unique: boolean;
}

export interface EnsureUniqueConstraintOp {
    op: 'ensureUniqueConstraint';
    table: string;
    constraint: string;
    columns: string[];
}

export interface EnsureAddColumnOp {
    op: 'ensureAddColumn';
    table: string;
    column: string;
    type: string;
}

export interface EnsureAlterColumnTypeOp {
    op: 'ensureAlterColumnType';
    table: string;
    column: string;
    type: string;
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
    | CreateMigrationHistoryOp
    | EnsureTableOp
    | EnsureJoinTableOp
    | EnsureForeignKeyOp
    | EnsureIndexOp
    | EnsureUniqueConstraintOp
    | EnsureAddColumnOp
    | EnsureAlterColumnTypeOp;
