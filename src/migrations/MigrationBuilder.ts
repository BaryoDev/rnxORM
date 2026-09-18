import { IDatabaseProvider } from "../providers/IDatabaseProvider";
import {
    assertCascadeAction,
    assertColumnType,
    assertPlainIdentifier,
    assertQualifiedPlainIdentifier,
    quoteIdentifier,
    quoteLiteral,
} from "./DdlIdentifiers";

/**
 * Column definition for creating tables
 */
export interface ColumnDefinition {
    name: string;
    type: string;
    nullable?: boolean;
    defaultValue?: any;
    isPrimaryKey?: boolean;
    isAutoIncrement?: boolean;
}

/**
 * Fluent API for defining migration operations
 */
export class MigrationBuilder {
    private operations: Array<() => Promise<void>> = [];

    constructor(private provider: IDatabaseProvider) {}

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
        this.operations.push(async () => {
            const table = quoteIdentifier(tableName, this.provider, 'createTable');

            const columnDefs = columns.map(col => {
                const name = quoteIdentifier(col.name, this.provider, 'createTable');
                let def = `${name} ${assertColumnType(col.type, 'createTable')}`;

                if (col.isPrimaryKey) {
                    def += ' PRIMARY KEY';
                }

                if (col.isAutoIncrement) {
                    // Provider-specific auto-increment syntax is handled in the type mapping
                    const dialect = this.provider.getDialect();
                    if (dialect === 'postgresql') {
                        def = `${name} SERIAL PRIMARY KEY`;
                    } else if (dialect === 'mssql') {
                        def = `${name} INT IDENTITY(1,1) PRIMARY KEY`;
                    } else if (dialect === 'mariadb') {
                        def = `${name} INT AUTO_INCREMENT PRIMARY KEY`;
                    }
                }

                if (col.nullable === false && !col.isPrimaryKey) {
                    def += ' NOT NULL';
                }

                if (col.defaultValue !== undefined) {
                    def += ` DEFAULT ${quoteLiteral(col.defaultValue, 'createTable', this.provider.getDialect())}`;
                }

                return def;
            }).join(', ');

            const sql = `CREATE TABLE ${table} (${columnDefs})`;
            await this.provider.query(sql);
        });
        return this;
    }

    /**
     * Drop a table
     * @param tableName Name of the table to drop
     */
    dropTable(tableName: string): this {
        this.operations.push(async () => {
            const table = quoteIdentifier(tableName, this.provider, 'dropTable');
            await this.provider.query(`DROP TABLE IF EXISTS ${table}`);
        });
        return this;
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
        this.operations.push(async () => {
            const table = quoteIdentifier(tableName, this.provider, 'addColumn');
            const column = quoteIdentifier(columnName, this.provider, 'addColumn');
            const type = assertColumnType(columnType, 'addColumn');

            let sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${type}`;

            if (options?.nullable === false) {
                sql += ' NOT NULL';
            }

            if (options?.defaultValue !== undefined) {
                sql += ` DEFAULT ${quoteLiteral(options.defaultValue, 'addColumn', this.provider.getDialect())}`;
            }

            await this.provider.query(sql);
        });
        return this;
    }

    /**
     * Drop a column from a table
     * @param tableName Table name
     * @param columnName Column name
     */
    dropColumn(tableName: string, columnName: string): this {
        this.operations.push(async () => {
            const table = quoteIdentifier(tableName, this.provider, 'dropColumn');
            const column = quoteIdentifier(columnName, this.provider, 'dropColumn');
            await this.provider.query(`ALTER TABLE ${table} DROP COLUMN ${column}`);
        });
        return this;
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
        this.operations.push(async () => {
            const dialect = this.provider.getDialect();
            const table = quoteIdentifier(tableName, this.provider, 'alterColumn');
            const column = quoteIdentifier(columnName, this.provider, 'alterColumn');
            const type = assertColumnType(newType, 'alterColumn');

            // Different databases have different syntax for ALTER COLUMN
            if (dialect === 'postgresql') {
                await this.provider.query(
                    `ALTER TABLE ${table} ALTER COLUMN ${column} TYPE ${type}`
                );

                if (options?.nullable === false) {
                    await this.provider.query(
                        `ALTER TABLE ${table} ALTER COLUMN ${column} SET NOT NULL`
                    );
                } else if (options?.nullable === true) {
                    await this.provider.query(
                        `ALTER TABLE ${table} ALTER COLUMN ${column} DROP NOT NULL`
                    );
                }

                if (options?.defaultValue !== undefined) {
                    const defaultVal = quoteLiteral(options.defaultValue, 'alterColumn', dialect);
                    await this.provider.query(
                        `ALTER TABLE ${table} ALTER COLUMN ${column} SET DEFAULT ${defaultVal}`
                    );
                }
            } else if (dialect === 'mssql') {
                let sql = `ALTER TABLE ${table} ALTER COLUMN ${column} ${type}`;
                if (options?.nullable === false) {
                    sql += ' NOT NULL';
                }
                await this.provider.query(sql);
            } else if (dialect === 'mariadb') {
                let sql = `ALTER TABLE ${table} MODIFY COLUMN ${column} ${type}`;
                if (options?.nullable === false) {
                    sql += ' NOT NULL';
                }
                await this.provider.query(sql);
            }
        });
        return this;
    }

    /**
     * Rename a column
     * @param tableName Table name
     * @param oldName Old column name
     * @param newName New column name
     */
    renameColumn(tableName: string, oldName: string, newName: string): this {
        this.operations.push(async () => {
            const dialect = this.provider.getDialect();
            const table = quoteIdentifier(tableName, this.provider, 'renameColumn');
            const from = quoteIdentifier(oldName, this.provider, 'renameColumn');
            const to = quoteIdentifier(newName, this.provider, 'renameColumn');

            if (dialect === 'postgresql') {
                await this.provider.query(
                    `ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`
                );
            } else if (dialect === 'mssql') {
                // sp_rename takes bare names inside string literals, so these
                // positions cannot be quoted and are validated instead. A
                // payload here used to close the literal and run (issue #44).
                const plainTable = assertQualifiedPlainIdentifier(tableName, 'renameColumn');
                const plainOld = assertPlainIdentifier(oldName, 'renameColumn');
                const plainNew = assertPlainIdentifier(newName, 'renameColumn');
                await this.provider.query(
                    `EXEC sp_rename '${plainTable}.${plainOld}', '${plainNew}', 'COLUMN'`
                );
            } else if (dialect === 'mariadb') {
                await this.provider.query(
                    `ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`
                );
            }
        });
        return this;
    }

    /**
     * Rename a table
     * @param oldName Old table name
     * @param newName New table name
     */
    renameTable(oldName: string, newName: string): this {
        this.operations.push(async () => {
            const dialect = this.provider.getDialect();
            const from = quoteIdentifier(oldName, this.provider, 'renameTable');
            const to = quoteIdentifier(newName, this.provider, 'renameTable');

            if (dialect === 'postgresql') {
                await this.provider.query(`ALTER TABLE ${from} RENAME TO ${to}`);
            } else if (dialect === 'mssql') {
                const plainOld = assertQualifiedPlainIdentifier(oldName, 'renameTable');
                const plainNew = assertPlainIdentifier(newName, 'renameTable');
                await this.provider.query(`EXEC sp_rename '${plainOld}', '${plainNew}'`);
            } else if (dialect === 'mariadb') {
                await this.provider.query(`RENAME TABLE ${from} TO ${to}`);
            }
        });
        return this;
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
        this.operations.push(async () => {
            const uniqueKeyword = unique ? 'UNIQUE ' : '';
            const table = quoteIdentifier(tableName, this.provider, 'createIndex');
            const index = quoteIdentifier(indexName, this.provider, 'createIndex');
            const columnList = columns
                .map(c => quoteIdentifier(c, this.provider, 'createIndex'))
                .join(', ');
            await this.provider.query(
                `CREATE ${uniqueKeyword}INDEX ${index} ON ${table} (${columnList})`
            );
        });
        return this;
    }

    /**
     * Drop an index
     * @param tableName Table name
     * @param indexName Index name
     */
    dropIndex(tableName: string, indexName: string): this {
        this.operations.push(async () => {
            const dialect = this.provider.getDialect();
            const table = quoteIdentifier(tableName, this.provider, 'dropIndex');
            const index = quoteIdentifier(indexName, this.provider, 'dropIndex');

            if (dialect === 'postgresql') {
                await this.provider.query(`DROP INDEX IF EXISTS ${index}`);
            } else if (dialect === 'mssql') {
                await this.provider.query(`DROP INDEX ${index} ON ${table}`);
            } else if (dialect === 'mariadb') {
                await this.provider.query(`DROP INDEX ${index} ON ${table}`);
            }
        });
        return this;
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
        this.operations.push(async () => {
            const table = quoteIdentifier(tableName, this.provider, 'addForeignKey');
            const constraint = quoteIdentifier(constraintName, this.provider, 'addForeignKey');
            const fkColumn = quoteIdentifier(column, this.provider, 'addForeignKey');
            const refTable = quoteIdentifier(referencedTable, this.provider, 'addForeignKey');
            const refColumn = quoteIdentifier(referencedColumn, this.provider, 'addForeignKey');
            const action = assertCascadeAction(onDelete);

            await this.provider.query(
                `ALTER TABLE ${table} ADD CONSTRAINT ${constraint} ` +
                `FOREIGN KEY (${fkColumn}) REFERENCES ${refTable}(${refColumn}) ` +
                `ON DELETE ${action}`
            );
        });
        return this;
    }

    /**
     * Drop a foreign key constraint
     * @param tableName Table name
     * @param constraintName Constraint name
     */
    dropForeignKey(tableName: string, constraintName: string): this {
        this.operations.push(async () => {
            const table = quoteIdentifier(tableName, this.provider, 'dropForeignKey');
            const constraint = quoteIdentifier(constraintName, this.provider, 'dropForeignKey');
            await this.provider.query(
                `ALTER TABLE ${table} DROP CONSTRAINT ${constraint}`
            );
        });
        return this;
    }

    /**
     * Execute raw SQL
     * @param sql SQL statement to execute
     * @param params Parameters for the SQL statement
     */
    sql(sql: string, params?: any[]): this {
        this.operations.push(async () => {
            await this.provider.query(sql, params);
        });
        return this;
    }

    /**
     * Execute all queued operations
     * @internal
     */
    async execute(): Promise<void> {
        for (const operation of this.operations) {
            await operation();
        }
        this.operations = [];
    }
}
