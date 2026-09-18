import "reflect-metadata";
import { MigrationBuilder } from '../../src/migrations/MigrationBuilder';
import { IDatabaseProvider, QueryResult } from '../../src/providers/IDatabaseProvider';
import { ColumnMetadata, EntityMetadata } from '../../src/core/MetadataStorage';

/**
 * MigrationBuilder concatenated every argument into DDL, including string
 * defaults that land inside quotes. Harmless for a hand-written migration,
 * exploitable the moment an app builds operations from request data, which is
 * what the "custom fields per tenant" shape does (issue #44).
 */

class RecordingProvider implements IDatabaseProvider {
    public queries: Array<{ sql: string; params?: any[] }> = [];

    constructor(private dialect: string) {}

    getDialect(): string { return this.dialect; }
    async connect(): Promise<void> {}
    async disconnect(): Promise<void> {}
    async query(text: string, params?: any[]): Promise<QueryResult> {
        this.queries.push({ sql: text, params });
        return { rows: [], rowCount: 0 };
    }
    async beginTransaction(): Promise<void> {}
    async commitTransaction(): Promise<void> {}
    async rollbackTransaction(): Promise<void> {}
    isInTransaction(): boolean { return false; }
    mapType(t: string): string { return t; }
    generateCreateTableSql(_e: EntityMetadata): string { return ''; }
    generateAddColumnSql(_t: string, _c: ColumnMetadata): string { return ''; }
    generateAlterColumnTypeSql(_t: string, _c: ColumnMetadata): string { return ''; }
    generateInsertSql(_t: string, _c: ColumnMetadata[]): string { return ''; }
    generateUpdateSql(_t: string, _c: ColumnMetadata[], _p: ColumnMetadata): string { return ''; }
    generateDeleteSql(_t: string, _p: ColumnMetadata): string { return ''; }
    generateSelectSql(t: string): string { return `SELECT * FROM ${t}`; }
    getParameterPlaceholder(i: number): string { return `$${i}`; }
    getSchemaColumnsQuery(_t: string): { sql: string; params: any[] } { return { sql: '', params: [] }; }
    normalizeType(t: string): string { return t; }
    getAutoIncrementType(): string { return 'SERIAL'; }
    isTypeMismatch(_e: string, _d: string): boolean { return false; }
    generateAddForeignKeySql(): string { return ''; }
    generateCreateIndexSql(): string { return ''; }
    generateCreateUniqueConstraintSql(): string { return ''; }
    generateCreateJoinTableSql(): string { return ''; }
}

function builderFor(dialect = 'postgresql') {
    const provider = new RecordingProvider(dialect);
    return { builder: new MigrationBuilder(provider), provider };
}

const IDENT_PAYLOAD = 'x"; DROP TABLE users; --';
const LITERAL_PAYLOAD = "x'; DROP TABLE users; --";

describe('identifier validation (#44)', () => {
    it('createTable rejects an injected table name', async () => {
        const { builder, provider } = builderFor();
        builder.createTable(IDENT_PAYLOAD, [{ name: 'id', type: 'integer' }]);
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
        expect(provider.queries).toHaveLength(0);
    });

    it('createTable rejects an injected column name', async () => {
        const { builder, provider } = builderFor();
        builder.createTable('t', [{ name: IDENT_PAYLOAD, type: 'integer' }]);
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
        expect(provider.queries).toHaveLength(0);
    });

    it('addColumn rejects an injected column name', async () => {
        const { builder } = builderFor();
        builder.addColumn('t', IDENT_PAYLOAD, 'text');
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
    });

    it('dropColumn rejects an injected column name', async () => {
        const { builder } = builderFor();
        builder.dropColumn('t', IDENT_PAYLOAD);
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
    });

    it('createIndex rejects an injected column in the list', async () => {
        const { builder } = builderFor();
        builder.createIndex('t', 'ix', ['ok', IDENT_PAYLOAD]);
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
    });

    it('addForeignKey rejects an injected referenced table', async () => {
        const { builder } = builderFor();
        builder.addForeignKey('t', 'fk', 'col', IDENT_PAYLOAD, 'id');
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
    });

    it('rejects a column type that is not a type expression', async () => {
        const { builder } = builderFor();
        builder.addColumn('t', 'c', 'text DEFAULT (SELECT password FROM users)');
        await expect(builder.execute()).rejects.toThrow(/not a valid column type/);
    });

    it('accepts ordinary type expressions', async () => {
        const { builder, provider } = builderFor();
        builder.createTable('t', [
            { name: 'a', type: 'varchar(100)' },
            { name: 'b', type: 'decimal(18,4)' },
            { name: 'c', type: 'double precision' },
        ]);
        await builder.execute();
        expect(provider.queries[0].sql).toContain('varchar(100)');
        expect(provider.queries[0].sql).toContain('decimal(18,4)');
        expect(provider.queries[0].sql).toContain('double precision');
    });
});

describe('the mssql sp_rename literal (#44)', () => {
    it('renameColumn rejects a payload that would break out of the literal', async () => {
        const { builder, provider } = builderFor('mssql');
        builder.renameColumn('t', 'a', "b', 'COLUMN'; DROP TABLE users; --");
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
        expect(provider.queries).toHaveLength(0);
    });

    it('renameTable rejects the same shape', async () => {
        const { builder } = builderFor('mssql');
        builder.renameTable('a', "b'; DROP TABLE users; --");
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
    });
});

describe('string defaults are escaped, not concatenated (#44)', () => {
    it('addColumn doubles embedded quotes instead of closing the literal', async () => {
        const { builder, provider } = builderFor();
        builder.addColumn('tenant_fields', 'note', 'text', { defaultValue: LITERAL_PAYLOAD });
        await builder.execute();

        // One statement, and the payload is inert inside the literal.
        expect(provider.queries).toHaveLength(1);
        expect(provider.queries[0].sql).toBe(
            `ALTER TABLE tenant_fields ADD COLUMN note text DEFAULT 'x''; DROP TABLE users; --'`
        );
    });

    it('createTable escapes a string default the same way', async () => {
        const { builder, provider } = builderFor();
        builder.createTable('t', [{ name: 'c', type: 'text', defaultValue: "it's" }]);
        await builder.execute();
        expect(provider.queries[0].sql).toContain(`DEFAULT 'it''s'`);
    });

    it('alterColumn escapes a string default the same way', async () => {
        const { builder, provider } = builderFor();
        builder.alterColumn('t', 'c', 'text', { defaultValue: LITERAL_PAYLOAD });
        await builder.execute();
        const setDefault = provider.queries.find(q => q.sql.includes('SET DEFAULT'))!;
        expect(setDefault.sql).toContain(`'x''; DROP TABLE users; --'`);
    });

    it('renders numbers and booleans bare', async () => {
        const { builder, provider } = builderFor();
        builder.createTable('t', [
            { name: 'n', type: 'int', defaultValue: 0 },
            { name: 'b', type: 'boolean', defaultValue: true },
        ]);
        await builder.execute();
        expect(provider.queries[0].sql).toContain('DEFAULT 0');
        expect(provider.queries[0].sql).toContain('DEFAULT TRUE');
    });

    it('rejects a default that is neither string, number, nor boolean', async () => {
        const { builder } = builderFor();
        builder.addColumn('t', 'c', 'text', { defaultValue: { nested: 'object' } });
        await expect(builder.execute()).rejects.toThrow(/must be a string, number, or boolean/);
    });
});

describe('identifier quoting (#44)', () => {
    /**
     * PostgreSQL folds unquoted identifiers to lower case and leaves quoted
     * ones alone, so quoting a name that used to be emitted bare points it at
     * a different object. The manual's advice is "always quote a particular
     * name or never quote it", so lower-case names stay bare and only names
     * that need quoting get it. This is what the Npgsql provider does.
     * MySQL/MariaDB and SQL Server do not resolve case through their quote
     * characters, so quoting there is unconditional.
     */
    it('leaves a lower-case name bare on postgresql', async () => {
        const { builder, provider } = builderFor('postgresql');
        builder.createTable('t', [{ name: 'c', type: 'integer' }]);
        await builder.execute();
        expect(provider.queries[0].sql).toBe('CREATE TABLE t (c integer)');
    });

    it('quotes unconditionally on mssql and mariadb', async () => {
        for (const [dialect, expected] of [
            ['mssql', 'CREATE TABLE [t] ([c] integer)'],
            ['mariadb', 'CREATE TABLE `t` (`c` integer)'],
        ] as const) {
            const { builder, provider } = builderFor(dialect);
            builder.createTable('t', [{ name: 'c', type: 'integer' }]);
            await builder.execute();
            expect(provider.queries[0].sql).toBe(expected);
        }
    });

    it('quotes a reserved word on postgresql so it is usable as a name', async () => {
        const { builder, provider } = builderFor('postgresql');
        builder.createTable('order', [{ name: 'select', type: 'integer' }]);
        await builder.execute();
        expect(provider.queries[0].sql).toBe('CREATE TABLE "order" ("select" integer)');
    });

    it('quotes a mixed-case name on postgresql, because bare would fold it', async () => {
        const { builder, provider } = builderFor('postgresql');
        builder.createTable('UserAccounts', [{ name: 'firstName', type: 'text' }]);
        await builder.execute();
        expect(provider.queries[0].sql).toBe('CREATE TABLE "UserAccounts" ("firstName" text)');
    });

    it('leaves an underscore or digit name bare on postgresql', async () => {
        const { builder, provider } = builderFor('postgresql');
        builder.createTable('_tmp_2024', [{ name: 'col_1', type: 'integer' }]);
        await builder.execute();
        expect(provider.queries[0].sql).toBe('CREATE TABLE _tmp_2024 (col_1 integer)');
    });

    it('quotes only the part that needs it in a qualified name', async () => {
        const { builder, provider } = builderFor('postgresql');
        builder.dropTable('app.Orders');
        await builder.execute();
        expect(provider.queries[0].sql).toBe('DROP TABLE IF EXISTS app."Orders"');
    });

    it('supports a schema-qualified lower-case table name', async () => {
        const { builder, provider } = builderFor('postgresql');
        builder.dropTable('app.users');
        await builder.execute();
        expect(provider.queries[0].sql).toBe('DROP TABLE IF EXISTS app.users');
    });

    it('rejects more than one qualifier', async () => {
        const { builder } = builderFor();
        builder.dropTable('a.b.c');
        await expect(builder.execute()).rejects.toThrow(/too many qualifiers/);
    });
});

describe('review findings on the first pass (#44 follow-up)', () => {
    it('renders a boolean default as a bit literal on sql server', async () => {
        const { builder, provider } = builderFor('mssql');
        builder.createTable('t', [{ name: 'flag', type: 'bit', defaultValue: true }]);
        await builder.execute();
        // SQL Server has no boolean type and rejects TRUE as a bit literal.
        expect(provider.queries[0].sql).toContain('DEFAULT 1');
    });

    it('still renders TRUE on postgresql and mariadb', async () => {
        for (const dialect of ['postgresql', 'mariadb'] as const) {
            const { builder, provider } = builderFor(dialect);
            builder.createTable('t', [{ name: 'flag', type: 'boolean', defaultValue: false }]);
            await builder.execute();
            expect(provider.queries[0].sql).toContain('DEFAULT FALSE');
        }
    });

    it('accepts a schema-qualified source table in sp_rename', async () => {
        const { builder, provider } = builderFor('mssql');
        builder.renameColumn('dbo.users', 'name', 'full_name');
        await builder.execute();
        expect(provider.queries[0].sql).toBe(
            `EXEC sp_rename 'dbo.users.name', 'full_name', 'COLUMN'`
        );
    });

    it('accepts a schema-qualified source table in renameTable', async () => {
        const { builder, provider } = builderFor('mssql');
        builder.renameTable('dbo.users', 'people');
        await builder.execute();
        expect(provider.queries[0].sql).toBe(`EXEC sp_rename 'dbo.users', 'people'`);
    });

    it('still rejects an injected qualified name', async () => {
        const { builder } = builderFor('mssql');
        builder.renameColumn("dbo.users'; DROP TABLE x; --", 'a', 'b');
        await expect(builder.execute()).rejects.toThrow(/not a valid SQL identifier/);
    });
});
