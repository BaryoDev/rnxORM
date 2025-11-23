import { Entity, Column, PrimaryKey } from "../src/decorators";
import { DbContext } from "../src/core/DbContext";
import dotenv from "dotenv";

dotenv.config();

// 1. Define initial entity
@Entity("evolution_test")
class TestEntityV1 {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

// 2. Define evolved entity (same table name, new field)
@Entity("evolution_test")
class TestEntityV2 {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    newField!: string;
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

        // Clean up previous run
        await db.query("DROP TABLE IF EXISTS evolution_test");

        console.log("--- Version 1 ---");
        // Simulate V1 usage
        // We need to manually register V1 because decorators run at import time.
        // But since V2 is also defined, MetadataStorage has V2's definition (last one wins for same class name usually, but here classes are different).
        // Actually, MetadataStorage stores by target (class constructor).
        // So we have two entries in MetadataStorage: TestEntityV1 and TestEntityV2, both pointing to 'evolution_test'.

        // To test evolution, we need to trick the system or just use V1 first, then V2.
        // Since decorators run immediately, both are already in metadata.
        // ensureCreated iterates ALL entities. It will try to create/update 'evolution_test' twice.
        // This is a bit tricky for a single script.

        // Let's manually manipulate what ensureCreated sees, or just rely on the loop.
        // If the loop runs V1 then V2, V2 will add the column.

        // Let's force it:
        // 1. Create table with V1 columns manually (simulating existing state)
        await db.query("CREATE TABLE evolution_test (id SERIAL PRIMARY KEY, name TEXT)");
        console.log("Table created with V1 schema (id, name).");

        // 2. Run ensureCreated with V2 (which has newField)
        // We can use db.set(TestEntityV2) to get the repo, but ensureCreated scans ALL metadata.
        // So it will see TestEntityV2 and try to sync it.

        console.log("--- Running ensureCreated (should detect V2) ---");
        await db.ensureCreated();

        // 3. Verify column exists
        const res = await db.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_name = 'evolution_test' AND column_name = 'newfield';
    `);

        if (res.rows.length > 0) {
            console.log("SUCCESS: 'newfield' was added to the table.");
        } else {
            console.error("FAILURE: 'newfield' was NOT found.");
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await db.disconnect();
    }
}

main();
