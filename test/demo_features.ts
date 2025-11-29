import { Entity, Column, PrimaryKey } from "../src/decorators";
import { DbContext } from "../src/core/DbContext";
import dotenv from "dotenv";

dotenv.config();

@Entity("demo_users")
class User {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    age!: number;
}

async function main() {
    const db = new DbContext({
        host: process.env.DB_HOST || "localhost",
        port: parseInt(process.env.DB_PORT || "5432"),
        user: process.env.DB_USER || "postgres",
        password: process.env.DB_PASSWORD || "postgres",
        database: process.env.DB_NAME || "postgres",
    });

    console.log("=== rnxORM New Features Demo ===\n");

    await db.connect();
    await db.ensureCreated();

    const users = db.set(User);

    // Clean up
    const existing = await users.toList();
    for (const u of existing) await users.remove(u);

    // Add sample data
    const alice = new User();
    alice.name = "Alice";
    alice.age = 25;
    await users.add(alice);

    const bob = new User();
    bob.name = "Bob";
    bob.age = 35;
    await users.add(bob);

    console.log("✅ Sample data created\n");

    // Feature 1: find() - Quick primary key lookup
    console.log("📌 Feature 1: find() method");
    const allUsers = await users.toList();
    const aliceId = allUsers.find(u => u.name === "Alice")?.id;

    if (aliceId) {
        const found = await users.find(aliceId);
        console.log(`   Found user: ${found?.name} (age: ${found?.age})`);
    }
    console.log();

    // Feature 2: asNoTracking() - Read-only queries
    console.log("📌 Feature 2: asNoTracking() method");
    const readOnlyUsers = await users.asNoTracking().toList();
    console.log(`   Retrieved ${readOnlyUsers.length} users in read-only mode`);
    console.log(`   Entities frozen: ${Object.isFrozen(readOnlyUsers[0])}`);

    try {
        readOnlyUsers[0].age = 999;
        console.log("   ❌ Should have thrown error!");
    } catch (error: any) {
        console.log("   ✅ Correctly prevented modification of frozen entity");
    }
    console.log();

    // Feature 3: Combining features
    console.log("📌 Feature 3: Combine asNoTracking() with where()");
    const adults = await users.asNoTracking().where("age", ">=", 30).toList();
    console.log(`   Found ${adults.length} adults: ${adults.map(u => u.name).join(", ")}`);
    console.log();

    console.log("=== Demo Complete ===");

    await db.disconnect();
}

main().catch(console.error);
