/**
 * arnexORM Quickstart
 *
 * Decorators, connecting, ensureCreated(), change-tracked CRUD, and the
 * fluent query API (where/orderBy/skip/take).
 *
 * In your app: import { Entity, PrimaryKey, Column, DbContext, PostgreSQLProvider } from "arnexorm";
 * Here we import from "../src" so the example runs against the repo's source.
 */
import "reflect-metadata";
import { Entity, PrimaryKey, Column, DbContext } from "../src";
import { PostgreSQLProvider } from "../src/providers";

@Entity("ex1_products")
class Product {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column({ type: "float" })
    price!: number;
}

async function main() {
    const provider = new PostgreSQLProvider({
        host: process.env.POSTGRES_HOST || "localhost",
        port: process.env.POSTGRES_PORT ? parseInt(process.env.POSTGRES_PORT, 10) : 5433,
        user: process.env.POSTGRES_USER || "postgres",
        password: process.env.POSTGRES_PASSWORD || "postgres",
        database: process.env.POSTGRES_DB || "rnxorm_test",
    });

    const db = new DbContext(provider);
    await db.connect();

    console.log("=== 01: Quickstart ===\n");

    // Self-contained: drop this example's table before (re)creating it, so
    // the file can be run repeatedly without manual cleanup.
    await db.executeSqlRaw("DROP TABLE IF EXISTS ex1_products");
    await db.ensureCreated();
    console.log("Schema ready: ex1_products");

    const products = db.set(Product);

    // --- Add + saveChanges: generated id is written back onto the entity ---
    const widget = new Product();
    widget.name = "Widget";
    widget.price = 9.99;
    products.add(widget);
    await db.saveChanges();
    console.log(`Added Widget -> generated id = ${widget.id}`);

    const gadget = new Product();
    gadget.name = "Gadget";
    gadget.price = 19.99;
    const gizmo = new Product();
    gizmo.name = "Gizmo";
    gizmo.price = 29.99;
    products.addRange([gadget, gizmo]);
    await db.saveChanges();
    console.log(`Added Gadget (id=${gadget.id}) and Gizmo (id=${gizmo.id})`);

    // --- Modify: change tracking detects the mutation, no explicit update() needed ---
    widget.price = 12.5;
    await db.saveChanges();
    console.log(`Modified Widget price -> $${widget.price}`);

    // --- find() ---
    const found = await products.find(widget.id);
    console.log(`find(${widget.id}) -> ${found?.name} @ $${found?.price}`);

    // --- where().orderBy().skip().take() ---
    const page = await products
        .where("price", ">", 5)
        .orderBy("price")
        .skip(1)
        .take(1)
        .toList();
    console.log(
        `where(price>5).orderBy(price).skip(1).take(1) -> ${page.map((p) => `${p.name}($${p.price})`).join(", ")}`
    );

    // --- Remove ---
    products.remove(gizmo);
    await db.saveChanges();
    const remaining = await products.toList();
    console.log(`Removed Gizmo -> ${remaining.length} product(s) remain: ${remaining.map((p) => p.name).join(", ")}`);

    await db.disconnect();
    console.log("\nDisconnected. Quickstart complete.");
}

main().catch((err) => {
    console.error("Quickstart failed:", err);
    process.exit(1);
});
