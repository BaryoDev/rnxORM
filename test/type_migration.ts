import { Entity, Column, PrimaryKey } from "../src/decorators";
import { DbContext } from "../src/core/DbContext";
import dotenv from "dotenv";

dotenv.config();

// 1. Define initial entity with TEXT column
@Entity("migration_test")
class TestEntityV1 {
    @PrimaryKey()
    id!: number;

    @Column({ type: "text" })
    data!: string;
}

// 2. Define evolved entity with INTEGER column
@Entity("migration_test")
class TestEntityV2 {
    @PrimaryKey()
    id!: number;

    @Column({ type: "integer" })
    data!: number;
}

async function main() {
    const db = new DbContext({
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432"),
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD || "postgres",
        database: process.env.DB_NAME || "postgres",
    });

    try {
        await db.connect();

        // Clean up
        await db.query("DROP TABLE IF EXISTS migration_test");

        console.log("--- Scenario 1: Successful Migration ---");
        // 1. Create table with TEXT
        await db.query("CREATE TABLE migration_test (id SERIAL PRIMARY KEY, data TEXT)");

        // 2. Insert compatible data ("123")
        await db.query("INSERT INTO migration_test (data) VALUES ('123')");
        console.log("Inserted '123' (text).");

        // 3. Run ensureCreated with INTEGER schema
        console.log("Running ensureCreated (TEXT -> INTEGER)...");
        await db.ensureCreated();

        // 4. Verify type
        const res1 = await db.query(`
        SELECT data_type FROM information_schema.columns 
        WHERE table_name = 'migration_test' AND column_name = 'data'
    `);
        const type1 = res1.rows[0].data_type;
        console.log(`Column type is now: ${type1}`);

        if (type1 === 'integer') {
            console.log("SUCCESS: Migrated to integer.");
        } else {
            console.error(`FAILURE: Expected integer, got ${type1}`);
        }

        console.log("\n--- Scenario 2: Failed Migration (Incompatible Data) ---");
        // 1. Reset table to TEXT
        await db.query("DROP TABLE migration_test");
        await db.query("CREATE TABLE migration_test (id SERIAL PRIMARY KEY, data TEXT)");

        // 2. Insert incompatible data ("abc")
        await db.query("INSERT INTO migration_test (data) VALUES ('abc')");
        console.log("Inserted 'abc' (text).");

        // 3. Run ensureCreated with INTEGER schema
        console.log("Running ensureCreated (TEXT -> INTEGER) with incompatible data...");
        await db.ensureCreated();

        // 4. Verify type (should still be text)
        const res2 = await db.query(`
        SELECT data_type FROM information_schema.columns 
        WHERE table_name = 'migration_test' AND column_name = 'data'
    `);
        const type2 = res2.rows[0].data_type;
        console.log(`Column type is now: ${type2}`);

        if (type2 === 'text') {
            console.log("SUCCESS: Migration failed gracefully, type remains text.");
        } else {
            console.error(`FAILURE: Expected text, got ${type2}`);
        }

        console.log("\n--- Scenario 3: String -> Boolean (Success) ---");
        // 1. Reset table to TEXT
        await db.query("DROP TABLE migration_test");
        await db.query("CREATE TABLE migration_test (id SERIAL PRIMARY KEY, data TEXT)");
        await db.query("INSERT INTO migration_test (data) VALUES ('true')");
        console.log("Inserted 'true' (text).");

        // 2. Define Entity with Boolean
        @Entity("migration_test")
        class TestEntityBoolean {
            @PrimaryKey() id!: number;
            @Column({ type: "boolean" }) data!: boolean;
        }

        // 3. Run ensureCreated (TEXT -> BOOLEAN)
        // We need to trick DbContext to use this new entity definition for the same table.
        // Since decorators run once, we can't easily swap the class definition for the *same* table name in the global metadata 
        // without clearing it or using a different table name.
        // However, for this script, we can just manually update the metadata for the *existing* target if we want, 
        // OR simpler: use different table names for different scenarios to avoid metadata conflicts in a single run.

        // Let's use a new table for boolean tests to be clean.
        await db.query("DROP TABLE IF EXISTS migration_bool_test");
        await db.query("CREATE TABLE migration_bool_test (id SERIAL PRIMARY KEY, data TEXT)");
        await db.query("INSERT INTO migration_bool_test (data) VALUES ('true')");

        @Entity("migration_bool_test")
        class TestEntityBool {
            @PrimaryKey() id!: number;
            @Column({ type: "boolean" }) data!: boolean;
        }

        console.log("Running ensureCreated (TEXT -> BOOLEAN)...");
        await db.ensureCreated();

        const res3 = await db.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'migration_bool_test' AND column_name = 'data'`);
        if (res3.rows[0].data_type === 'boolean') console.log("SUCCESS: Migrated to boolean.");
        else console.error(`FAILURE: Expected boolean, got ${res3.rows[0].data_type}`);

        console.log("\n--- Scenario 4: String -> Boolean (Failure) ---");
        await db.query("DROP TABLE migration_bool_test");
        await db.query("CREATE TABLE migration_bool_test (id SERIAL PRIMARY KEY, data TEXT)");
        await db.query("INSERT INTO migration_bool_test (data) VALUES ('random_text')");
        console.log("Inserted 'random_text' (text).");

        console.log("Running ensureCreated (TEXT -> BOOLEAN) with incompatible data...");
        await db.ensureCreated();

        const res4 = await db.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'migration_bool_test' AND column_name = 'data'`);
        if (res4.rows[0].data_type === 'text') console.log("SUCCESS: Migration failed gracefully.");
        else console.error(`FAILURE: Expected text, got ${res4.rows[0].data_type}`);

        console.log("\n--- Scenario 5: Integer -> String (Success) ---");
        await db.query("DROP TABLE IF EXISTS migration_int_str_test");
        await db.query("CREATE TABLE migration_int_str_test (id SERIAL PRIMARY KEY, data INTEGER)");
        await db.query("INSERT INTO migration_int_str_test (data) VALUES (123)");

        @Entity("migration_int_str_test")
        class TestEntityIntStr {
            @PrimaryKey() id!: number;
            @Column({ type: "text" }) data!: string;
        }

        console.log("Running ensureCreated (INTEGER -> TEXT)...");
        await db.ensureCreated();

        const res5 = await db.query(`SELECT data_type FROM information_schema.columns WHERE table_name = 'migration_int_str_test' AND column_name = 'data'`);
        if (res5.rows[0].data_type === 'text') console.log("SUCCESS: Migrated to text.");
        else console.error(`FAILURE: Expected text, got ${res5.rows[0].data_type}`);

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await db.disconnect();
    }
}

main();
