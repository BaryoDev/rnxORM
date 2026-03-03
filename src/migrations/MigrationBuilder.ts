import { IDatabaseProvider } from "../providers/IDatabaseProvider";

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
            const columnDefs = columns.map(col => {
                let def = `${col.name} ${col.type}`;

                if (col.isPrimaryKey) {
                    def += ' PRIMARY KEY';
                }

                if (col.isAutoIncrement) {
                    // Provider-specific auto-increment syntax is handled in the type mapping
                    const dialect = this.provider.getDialect();
                    if (dialect === 'postgresql') {
                        def = `${col.name} SERIAL PRIMARY KEY`;
                    } else if (dialect === 'mssql') {
                        def = `${col.name} INT IDENTITY(1,1) PRIMARY KEY`;
                    } else if (dialect === 'mariadb') {
                        def = `${col.name} INT AUTO_INCREMENT PRIMARY KEY`;
                    }
                }

                if (col.nullable === false && !col.isPrimaryKey) {
                    def += ' NOT NULL';
                }

                if (col.defaultValue !== undefined) {
                    if (typeof col.defaultValue === 'string') {
                        def += ` DEFAULT '${col.defaultValue}'`;
                    } else {
                        def += ` DEFAULT ${col.defaultValue}`;
                    }
                }

                return def;
            }).join(', ');

            const sql = `CREATE TABLE ${tableName} (${columnDefs})`;
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
            await this.provider.query(`DROP TABLE IF EXISTS ${tableName}`);
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
            let sql = `ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`;

            if (options?.nullable === false) {
                sql += ' NOT NULL';
            }

            if (options?.defaultValue !== undefined) {
                if (typeof options.defaultValue === 'string') {
                    sql += ` DEFAULT '${options.defaultValue}'`;
                } else {
                    sql += ` DEFAULT ${options.defaultValue}`;
                }
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
            await this.provider.query(`ALTER TABLE ${tableName} DROP COLUMN ${columnName}`);
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

            // Different databases have different syntax for ALTER COLUMN
            if (dialect === 'postgresql') {
                await this.provider.query(
                    `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} TYPE ${newType}`
                );

                if (options?.nullable === false) {
                    await this.provider.query(
                        `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET NOT NULL`
                    );
                } else if (options?.nullable === true) {
                    await this.provider.query(
                        `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} DROP NOT NULL`
                    );
                }

                if (options?.defaultValue !== undefined) {
                    const defaultVal = typeof options.defaultValue === 'string'
                        ? `'${options.defaultValue}'`
                        : options.defaultValue;
                    await this.provider.query(
                        `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} SET DEFAULT ${defaultVal}`
                    );
                }
            } else if (dialect === 'mssql') {
                let sql = `ALTER TABLE ${tableName} ALTER COLUMN ${columnName} ${newType}`;
                if (options?.nullable === false) {
                    sql += ' NOT NULL';
                }
                await this.provider.query(sql);
            } else if (dialect === 'mariadb') {
                let sql = `ALTER TABLE ${tableName} MODIFY COLUMN ${columnName} ${newType}`;
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

            if (dialect === 'postgresql') {
                await this.provider.query(
                    `ALTER TABLE ${tableName} RENAME COLUMN ${oldName} TO ${newName}`
                );
            } else if (dialect === 'mssql') {
                await this.provider.query(
                    `EXEC sp_rename '${tableName}.${oldName}', '${newName}', 'COLUMN'`
                );
            } else if (dialect === 'mariadb') {
                await this.provider.query(
                    `ALTER TABLE ${tableName} RENAME COLUMN ${oldName} TO ${newName}`
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

            if (dialect === 'postgresql') {
                await this.provider.query(`ALTER TABLE ${oldName} RENAME TO ${newName}`);
            } else if (dialect === 'mssql') {
                await this.provider.query(`EXEC sp_rename '${oldName}', '${newName}'`);
            } else if (dialect === 'mariadb') {
                await this.provider.query(`RENAME TABLE ${oldName} TO ${newName}`);
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
            const columnList = columns.join(', ');
            await this.provider.query(
                `CREATE ${uniqueKeyword}INDEX ${indexName} ON ${tableName} (${columnList})`
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

            if (dialect === 'postgresql') {
                await this.provider.query(`DROP INDEX IF EXISTS ${indexName}`);
            } else if (dialect === 'mssql') {
                await this.provider.query(`DROP INDEX ${indexName} ON ${tableName}`);
            } else if (dialect === 'mariadb') {
                await this.provider.query(`DROP INDEX ${indexName} ON ${tableName}`);
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
            await this.provider.query(
                `ALTER TABLE ${tableName} ADD CONSTRAINT ${constraintName} ` +
                `FOREIGN KEY (${column}) REFERENCES ${referencedTable}(${referencedColumn}) ` +
                `ON DELETE ${onDelete}`
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
            await this.provider.query(
                `ALTER TABLE ${tableName} DROP CONSTRAINT ${constraintName}`
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
