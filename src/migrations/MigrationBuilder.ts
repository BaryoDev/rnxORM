import { IDatabaseProvider, QueryResult } from "../providers/IDatabaseProvider";
import { QueryParameter } from "../core/types";
import { DdlColumn, DdlOperation } from "../core/query/model/DdlOperation";

/** Anything that runs a statement: the provider's pool or a transaction handle. */
export interface SqlExecutor {
    query(text: string, params?: QueryParameter[]): Promise<QueryResult>;
}

/**
 * Column definition for creating tables
 */
export type ColumnDefinition = DdlColumn;

type QueuedStep =
    | { kind: 'ddl'; op: DdlOperation }
    | { kind: 'raw'; sql: string; params?: any[] };

/**
 * Fluent API for defining migration operations.
 *
 * Each method queues a `DdlOperation`. The provider's translator turns it into
 * SQL, and validates every identifier, type and literal, when `execute()` runs.
 */
export class MigrationBuilder {
    private steps: QueuedStep[] = [];

    /**
     * @param provider Supplies the translator for its dialect.
     * @param executor Where the statements run. Defaults to the provider's
     * pool; the Migrator passes the migration's transaction handle.
     */
    constructor(
        private provider: IDatabaseProvider,
        private executor: SqlExecutor = provider
    ) {}

    private queue(op: DdlOperation): this {
        this.steps.push({ kind: 'ddl', op });
        return this;
    }

    /**
     * Create a new table
     * @param tableName Name of the table
     * @param columns Column definitions
     * @example
     * builder.createTable('users', [
     *   { name: 'id', type: 'integer', isPrimaryKey: true, isAutoIncrement: true },
     *   { name: 'name', type: 'varchar(100)', nullable: false },
     *   { name: 'email', type: 'varchar(255)', nullable: false }
     * ]);
     */
    createTable(tableName: string, columns: ColumnDefinition[]): this {
        return this.queue({ op: 'createTable', table: tableName, columns });
    }

    /**
     * Drop a table
     * @param tableName Name of the table to drop
     */
    dropTable(tableName: string): this {
        return this.queue({ op: 'dropTable', table: tableName });
    }

    /**
     * Add a column to an existing table
     * @param tableName Table name
     * @param columnName Column name
     * @param columnType Column type
     * @param options Additional options
     */
    addColumn(
        tableName: string,
        columnName: string,
        columnType: string,
        options?: { nullable?: boolean; defaultValue?: any }
    ): this {
        return this.queue({
            op: 'addColumn',
            table: tableName,
            column: columnName,
            type: columnType,
            nullable: options?.nullable,
            defaultValue: options?.defaultValue,
        });
    }

    /**
     * Drop a column from a table
     * @param tableName Table name
     * @param columnName Column name
     */
    dropColumn(tableName: string, columnName: string): this {
        return this.queue({ op: 'dropColumn', table: tableName, column: columnName });
    }

    /**
     * Alter a column definition
     * @param tableName Table name
     * @param columnName Column name
     * @param newType New column type
     * @param options Additional options
     */
    alterColumn(
        tableName: string,
        columnName: string,
        newType: string,
        options?: { nullable?: boolean; defaultValue?: any }
    ): this {
        return this.queue({
            op: 'alterColumn',
            table: tableName,
            column: columnName,
            type: newType,
            nullable: options?.nullable,
            defaultValue: options?.defaultValue,
        });
    }

    /**
     * Rename a column
     * @param tableName Table name
     * @param oldName Old column name
     * @param newName New column name
     */
    renameColumn(tableName: string, oldName: string, newName: string): this {
        return this.queue({ op: 'renameColumn', table: tableName, from: oldName, to: newName });
    }

    /**
     * Rename a table
     * @param oldName Old table name
     * @param newName New table name
     */
    renameTable(oldName: string, newName: string): this {
        return this.queue({ op: 'renameTable', from: oldName, to: newName });
    }

    /**
     * Create an index
     * @param tableName Table name
     * @param indexName Index name
     * @param columns Columns to index
     * @param unique Whether the index is unique
     */
    createIndex(
        tableName: string,
        indexName: string,
        columns: string[],
        unique: boolean = false
    ): this {
        return this.queue({ op: 'createIndex', table: tableName, index: indexName, columns, unique });
    }

    /**
     * Drop an index
     * @param tableName Table name
     * @param indexName Index name
     */
    dropIndex(tableName: string, indexName: string): this {
        return this.queue({ op: 'dropIndex', table: tableName, index: indexName });
    }

    /**
     * Add a foreign key constraint
     * @param tableName Table name
     * @param constraintName Constraint name
     * @param column Column name
     * @param referencedTable Referenced table
     * @param referencedColumn Referenced column
     * @param onDelete ON DELETE action
     */
    addForeignKey(
        tableName: string,
        constraintName: string,
        column: string,
        referencedTable: string,
        referencedColumn: string,
        onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' = 'NO ACTION'
    ): this {
        return this.queue({
            op: 'addForeignKey',
            table: tableName,
            constraint: constraintName,
            column,
            referencedTable,
            referencedColumn,
            onDelete,
        });
    }

    /**
     * Drop a foreign key constraint
     * @param tableName Table name
     * @param constraintName Constraint name
     */
    dropForeignKey(tableName: string, constraintName: string): this {
        return this.queue({ op: 'dropForeignKey', table: tableName, constraint: constraintName });
    }

    /**
     * Execute raw SQL
     * @param sql SQL statement to execute
     * @param params Parameters for the SQL statement
     */
    sql(sql: string, params?: any[]): this {
        this.steps.push({ kind: 'raw', sql, params });
        return this;
    }

    /**
     * Execute all queued operations
     * @internal
     */
    async execute(): Promise<void> {
        const translator = this.provider.getTranslator();
        for (const step of this.steps) {
            if (step.kind === 'raw') {
                await this.executor.query(step.sql, step.params);
                continue;
            }
            for (const statement of translator.translateDdl(step.op)) {
                await this.executor.query(statement.text);
            }
        }
        this.steps = [];
    }
}
