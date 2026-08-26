/**
 * arnexORM Query Filters & Security
 *
 * Part 1: a structured hasQueryFilter() soft-delete filter, and how count(),
 * pagination, and groupBy() all respect it automatically — plus
 * ignoreQueryFilters() to bypass it deliberately.
 *
 * Part 2: the security showcase. orderBy() (like where() and having())
 * validates its column argument against the entity's mapped columns before
 * it ever touches SQL, so a string that looks like an injection payload is
 * rejected with a thrown error instead of being interpolated.
 *
 * In your app: import { Entity, PrimaryKey, Column, DbContext, ModelBuilder, PostgreSQLProvider } from "arnexorm";
 * Here we import from "../src" so the example runs against the repo's source.
 */
import "reflect-metadata";
import { Entity, PrimaryKey, Column, DbContext, ModelBuilder } from "../src";
import { PostgreSQLProvider } from "../src/providers";

@Entity("ex3_orders")
class Order {
    @PrimaryKey()
    id!: number;

    @Column()
    customer!: string;

    @Column({ type: "float" })
    amount!: number;

    @Column({ type: "boolean" })
    isDeleted!: boolean;
}

class AppDbContext extends DbContext {
    protected onModelCreating(modelBuilder: ModelBuilder): void {
        // Structured form: compiled into the SQL WHERE clause, so soft-deleted
        // rows never leave the database (unlike the legacy predicate form,
        // which filters in memory after the full result set is fetched).
        modelBuilder.entity(Order).hasQueryFilter({ property: "isDeleted", operator: "=", value: false });
    }
}

async function main() {
    const provider = new PostgreSQLProvider({
        host: process.env.POSTGRES_HOST || "localhost",
        port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : 5433,
        user: process.env.POSTGRES_USER || "postgres",
        password: process.env.POSTGRES_PASSWORD || "postgres",
        database: process.env.POSTGRES_DB || "rnxorm_test",
    });

    const db = new AppDbContext(provider);
    await db.connect();

    console.log("=== 03: Query Filters & Security ===\n");

    // Self-contained: drop this example's table before (re)creating it.
    await db.executeSqlRaw("DROP TABLE IF EXISTS ex3_orders");
    await db.ensureCreated();
    console.log("Schema ready: ex3_orders");

    const orders = db.set(Order);
    const seed: Array<Partial<Order>> = [
        { customer: "Acme", amount: 100, isDeleted: false },
        { customer: "Acme", amount: 50, isDeleted: false },
        { customer: "Acme", amount: 75, isDeleted: true }, // soft-deleted
        { customer: "Globex", amount: 200, isDeleted: false },
        { customer: "Globex", amount: 30, isDeleted: true }, // soft-deleted
    ];
    for (const s of seed) {
        const order = new Order();
        Object.assign(order, s);
        orders.add(order);
    }
    await db.saveChanges();
    console.log(`Seeded ${seed.length} orders (2 soft-deleted)\n`);

    console.log("--- hasQueryFilter respected by count / pagination / groupBy ---");

    const activeCount = await orders.count();
    console.log(`count() -> ${activeCount} (soft-deleted excluded)`);

    const page = await orders.orderBy("amount").skip(0).take(2).toList();
    console.log(
        `orderBy(amount).skip(0).take(2) -> ${page.map((o) => `${o.customer}:$${o.amount}`).join(", ")}`
    );

    const totals = await orders
        .groupBy((o) => o.customer)
        .select((g) => ({ customer: g.key, total: g.sum((o) => o.amount), count: g.count() }))
        .toList();
    console.log("groupBy(customer).select(sum, count) ->", totals);

    const allCount = await orders.ignoreQueryFilters().count();
    console.log(`ignoreQueryFilters().count() -> ${allCount} (soft-deleted included)`);

    console.log("\n--- Security: orderBy() validates its column against mapped metadata ---");
    // Typed where()/orderBy() autocomplete: because DbSet<T>.where() and
    // QueryBuilder<T>.where()/orderBy() are overloaded with
    // `(column: keyof T & string, ...)`, an editor autocompletes `column` to
    // Order's mapped property names when you pass a string literal. The
    // runtime check below applies regardless of how the string arrived.
    const userInput = "amount; DROP TABLE ex3_orders; --";
    try {
        await orders.orderBy(userInput).toList();
        console.log("UNEXPECTED: injection payload was accepted!");
    } catch (err: any) {
        console.log(`Caught as expected: ${err.message}`);
    }

    const acmeOrders = await orders.where("customer", "=", "Acme").toList();
    console.log(`\nwhere("customer","=","Acme") -> ${acmeOrders.length} order(s) (filter still applied)`);

    await db.disconnect();
    console.log("\nDisconnected. Query filters & security example complete.");
}

main().catch((err) => {
    console.error("Query filters & security example failed:", err);
    process.exit(1);
});
