/**
 * rnxORM Concurrency & Identity
 *
 * The identity map: loading the same row twice through the same DbContext
 * returns the exact same tracked instance.
 *
 * Optimistic concurrency: a concurrency-token column is auto-incremented on
 * every update and checked in the WHERE clause, so a second context saving
 * against a stale version throws instead of silently overwriting.
 *
 * In your app: import { Entity, PrimaryKey, Column, DbContext, ModelBuilder, PostgreSQLProvider } from "rnxorm";
 * Here we import from "../src" so the example runs against the repo's source.
 */
import "reflect-metadata";
import { Entity, PrimaryKey, Column, DbContext, ModelBuilder } from "../src";
import { PostgreSQLProvider } from "../src/providers";
import { DatabaseConfig } from "../src/providers/IDatabaseProvider";

@Entity("ex4_accounts")
class Account {
    @PrimaryKey()
    id!: number;

    @Column()
    owner!: string;

    @Column({ type: "float" })
    balance!: number;

    @Column()
    version!: number;
}

class AppDbContext extends DbContext {
    protected onModelCreating(modelBuilder: ModelBuilder): void {
        modelBuilder.entity(Account).property((a) => a.version).isConcurrencyToken();
    }
}

function config(): DatabaseConfig {
    return {
        host: process.env.POSTGRES_HOST || "localhost",
        port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : 5433,
        user: process.env.POSTGRES_USER || "postgres",
        password: process.env.POSTGRES_PASSWORD || "postgres",
        database: process.env.POSTGRES_DB || "rnxorm_test",
    };
}

async function main() {
    console.log("=== 04: Concurrency & Identity ===\n");

    // --- Setup: self-contained table reset + seed row ---
    const setupDb = new AppDbContext(new PostgreSQLProvider(config()));
    await setupDb.connect();
    await setupDb.executeSqlRaw("DROP TABLE IF EXISTS ex4_accounts");
    await setupDb.ensureCreated();
    console.log("Schema ready: ex4_accounts");

    const seedAccount = new Account();
    seedAccount.owner = "Ada";
    seedAccount.balance = 100;
    seedAccount.version = 1;
    setupDb.set(Account).add(seedAccount);
    await setupDb.saveChanges();
    console.log(`Seeded account id=${seedAccount.id} balance=$${seedAccount.balance} version=${seedAccount.version}`);
    await setupDb.disconnect();

    // --- Identity map: two find() calls on the SAME context return the SAME instance ---
    console.log("\n--- Identity map ---");
    const idmDb = new AppDbContext(new PostgreSQLProvider(config()));
    await idmDb.connect();

    const first = await idmDb.set(Account).find(seedAccount.id);
    const second = await idmDb.set(Account).find(seedAccount.id);
    console.log(`find(${seedAccount.id}) twice -> same instance (===): ${first === second}`);
    await idmDb.disconnect();

    // --- Optimistic concurrency: two DIFFERENT contexts race to update the same row ---
    console.log("\n--- Optimistic concurrency ---");
    const dbA = new AppDbContext(new PostgreSQLProvider(config()));
    const dbB = new AppDbContext(new PostgreSQLProvider(config()));
    await dbA.connect();
    await dbB.connect();

    const accountA = (await dbA.set(Account).find(seedAccount.id))!;
    const accountB = (await dbB.set(Account).find(seedAccount.id))!;
    console.log(`Both contexts loaded version=${accountA.version}`);

    accountB.balance += 50;
    await dbB.saveChanges();
    console.log(`Context B saved first: balance=$${accountB.balance}, version bumped to ${accountB.version}`);

    accountA.balance -= 20;
    try {
        await dbA.saveChanges();
        console.log("UNEXPECTED: no concurrency violation thrown");
    } catch (err: any) {
        console.log(`Context A caught concurrency violation as expected: ${err.message}`);
    }

    await dbA.disconnect();
    await dbB.disconnect();

    // --- Verify B's write is the one that stuck ---
    const verifyDb = new AppDbContext(new PostgreSQLProvider(config()));
    await verifyDb.connect();
    const final = await verifyDb.set(Account).find(seedAccount.id);
    console.log(`\nFinal state: balance=$${final?.balance}, version=${final?.version}`);
    await verifyDb.disconnect();

    console.log("\nDisconnected. Concurrency & identity example complete.");
}

main().catch((err) => {
    console.error("Concurrency & identity example failed:", err);
    process.exit(1);
});
