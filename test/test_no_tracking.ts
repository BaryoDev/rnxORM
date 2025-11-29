import { Entity, Column, PrimaryKey } from "../src/decorators";
import { DbContext } from "../src/core/DbContext";
import dotenv from "dotenv";

dotenv.config();

@Entity("test_products")
class Product {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    price!: number;

    @Column()
    inStock!: boolean;
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
        console.log("🔌 Connecting to database...");
        await db.connect();
        console.log("✅ Connected.\n");

        console.log("📋 Ensuring schema...");
        await db.ensureCreated();
        console.log("✅ Schema created.\n");

        const products = db.set(Product);

        // Clean up any existing test data
        console.log("🧹 Cleaning up existing test data...");
        const existingProducts = await products.toList();
        for (const p of existingProducts) {
            await products.remove(p);
        }
        console.log("✅ Cleanup complete.\n");

        // ============================================================
        // TEST 1: Find by Primary Key
        // ============================================================
        console.log("=".repeat(60));
        console.log("TEST 1: Find by Primary Key");
        console.log("=".repeat(60));

        console.log("Adding test product...");
        const newProduct = new Product();
        newProduct.name = "Laptop";
        newProduct.price = 1200;
        newProduct.inStock = true;
        await products.add(newProduct);

        // Get the ID of the inserted product
        const allProducts = await products.toList();
        const insertedId = allProducts[0].id;
        console.log(`✅ Product added with ID: ${insertedId}\n`);

        console.log(`Finding product by ID ${insertedId}...`);
        const foundProduct = await products.find(insertedId);
        if (foundProduct) {
            console.log("✅ Product found:", foundProduct);
            console.log(`   Name: ${foundProduct.name}`);
            console.log(`   Price: $${foundProduct.price}`);
            console.log(`   In Stock: ${foundProduct.inStock}\n`);
        } else {
            console.error("❌ FAIL: Product not found!");
            process.exit(1);
        }

        console.log("Finding non-existent product (ID 99999)...");
        const notFound = await products.find(99999);
        if (notFound === null) {
            console.log("✅ Correctly returned null for non-existent ID\n");
        } else {
            console.error("❌ FAIL: Should have returned null!");
            process.exit(1);
        }

        // ============================================================
        // TEST 2: AsNoTracking - Basic Read-Only Query
        // ============================================================
        console.log("=".repeat(60));
        console.log("TEST 2: AsNoTracking - Basic Read-Only Query");
        console.log("=".repeat(60));

        console.log("Adding more test products...");
        const product2 = new Product();
        product2.name = "Mouse";
        product2.price = 25;
        product2.inStock = true;
        await products.add(product2);

        const product3 = new Product();
        product3.name = "Keyboard";
        product3.price = 75;
        product3.inStock = false;
        await products.add(product3);
        console.log("✅ Additional products added.\n");

        console.log("Fetching products with asNoTracking()...");
        const readOnlyProducts = await products.asNoTracking().toList();
        console.log(`✅ Retrieved ${readOnlyProducts.length} products in no-tracking mode\n`);

        console.log("Verifying entities are frozen (read-only)...");
        try {
            // Attempt to modify a frozen object
            readOnlyProducts[0].price = 9999;
            // In non-strict mode, assignment might succeed but not actually change the value
            if (Object.isFrozen(readOnlyProducts[0])) {
                console.log("✅ Entities are frozen (Object.isFrozen = true)");
                console.log(`   Attempted modification did not change value: ${readOnlyProducts[0].price !== 9999 ? "PASS" : "FAIL"}\n`);
            } else {
                console.error("❌ FAIL: Entities should be frozen!");
                process.exit(1);
            }
        } catch (error: any) {
            // In strict mode, assignment throws TypeError
            if (error.message.includes("frozen") || error.message.includes("read only")) {
                console.log("✅ Correctly threw error when attempting to modify frozen entity");
                console.log(`   Error: ${error.message}\n`);
            } else {
                console.error("❌ Unexpected error:", error.message);
                process.exit(1);
            }
        }

        // ============================================================
        // TEST 3: AsNoTracking with Where Clause
        // ============================================================
        console.log("=".repeat(60));
        console.log("TEST 3: AsNoTracking with Where Clause");
        console.log("=".repeat(60));

        console.log("Querying products with price > 50 using asNoTracking()...");
        const expensiveProducts = await products.asNoTracking().where("price", ">", 50).toList();
        console.log(`✅ Found ${expensiveProducts.length} expensive products:`);
        expensiveProducts.forEach(p => {
            console.log(`   - ${p.name}: $${p.price}`);
        });
        console.log();

        console.log("Verifying frozen state...");
        if (Object.isFrozen(expensiveProducts[0])) {
            console.log("✅ Query results are frozen\n");
        } else {
            console.error("❌ FAIL: Results should be frozen!");
            process.exit(1);
        }

        // ============================================================
        // TEST 4: Where + AsNoTracking (chained in different order)
        // ============================================================
        console.log("=".repeat(60));
        console.log("TEST 4: Chaining Where + AsNoTracking");
        console.log("=".repeat(60));

        console.log("Querying with where().asNoTracking()...");
        const affordableProducts = await products.where("price", "<=", 50).asNoTracking().toList();
        console.log(`✅ Found ${affordableProducts.length} affordable products:`);
        affordableProducts.forEach(p => {
            console.log(`   - ${p.name}: $${p.price}`);
        });
        console.log();

        if (Object.isFrozen(affordableProducts[0])) {
            console.log("✅ Chained query results are frozen\n");
        } else {
            console.error("❌ FAIL: Results should be frozen!");
            process.exit(1);
        }

        // ============================================================
        // TEST 5: Regular Queries Still Mutable
        // ============================================================
        console.log("=".repeat(60));
        console.log("TEST 5: Regular Queries Still Mutable");
        console.log("=".repeat(60));

        console.log("Fetching products WITHOUT asNoTracking()...");
        const mutableProducts = await products.toList();
        console.log(`✅ Retrieved ${mutableProducts.length} products\n`);

        console.log("Verifying entities are NOT frozen...");
        if (!Object.isFrozen(mutableProducts[0])) {
            console.log("✅ Regular query results are mutable (not frozen)");

            const originalPrice = mutableProducts[0].price;
            mutableProducts[0].price = 42;
            if (mutableProducts[0].price === 42) {
                console.log("✅ Successfully modified entity property\n");
                mutableProducts[0].price = originalPrice; // Restore
            } else {
                console.error("❌ FAIL: Should be able to modify regular entities!");
                process.exit(1);
            }
        } else {
            console.error("❌ FAIL: Regular entities should NOT be frozen!");
            process.exit(1);
        }

        // ============================================================
        // TEST 6: Update/Delete Still Work (Regression Test)
        // ============================================================
        console.log("=".repeat(60));
        console.log("TEST 6: Update and Delete Operations (Regression)");
        console.log("=".repeat(60));

        console.log("Testing update operation...");
        const productToUpdate = await products.find(insertedId);
        if (productToUpdate) {
            const oldName = productToUpdate.name;
            productToUpdate.name = "Gaming Laptop";
            await products.update(productToUpdate);

            const updated = await products.find(insertedId);
            if (updated && updated.name === "Gaming Laptop") {
                console.log(`✅ Update successful: "${oldName}" → "${updated.name}"\n`);
            } else {
                console.error("❌ FAIL: Update did not persist!");
                process.exit(1);
            }
        }

        console.log("Testing delete operation...");
        const beforeCount = (await products.toList()).length;
        const productToDelete = await products.find(insertedId);
        if (productToDelete) {
            await products.remove(productToDelete);
            const afterCount = (await products.toList()).length;

            if (afterCount === beforeCount - 1) {
                console.log(`✅ Delete successful: ${beforeCount} → ${afterCount} products\n`);
            } else {
                console.error("❌ FAIL: Delete did not work correctly!");
                process.exit(1);
            }
        }

        // ============================================================
        // SUMMARY
        // ============================================================
        console.log("=".repeat(60));
        console.log("🎉 ALL TESTS PASSED!");
        console.log("=".repeat(60));
        console.log("✅ Find by primary key works correctly");
        console.log("✅ AsNoTracking returns frozen entities");
        console.log("✅ AsNoTracking works with where clauses");
        console.log("✅ Method chaining works in both orders");
        console.log("✅ Regular queries remain mutable");
        console.log("✅ Existing update/delete operations unaffected");
        console.log("=".repeat(60));

    } catch (error) {
        console.error("\n❌ TEST FAILED WITH ERROR:");
        console.error(error);
        process.exit(1);
    } finally {
        await db.disconnect();
    }
}

main();
