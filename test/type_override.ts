import { Entity, Column, PrimaryKey } from "../src/decorators";
import { DbContext } from "../src/core/DbContext";
import dotenv from "dotenv";

dotenv.config();

@Entity("products")
class Product {
    @PrimaryKey()
    id!: number;

    @Column({ type: "varchar(50)" }) // Override default 'text'
    code!: string;

    @Column({ type: "decimal(10, 2)" }) // Override default 'integer' for number
    price!: number;

    @Column()
    isActive!: boolean;
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
        await db.ensureCreated();

        const products = db.set(Product);

        const p = new Product();
        p.code = "ABC-123";
        p.price = 99.99;
        p.isActive = true;

        await products.add(p);
        console.log("Product added.");

        const all = await products.toList();
        console.log("Products:", all);

        // Verify schema type by querying information_schema (optional, but good for rigorous testing)
        const schemaRes = await db.query(`
        SELECT column_name, data_type, character_maximum_length, numeric_precision, numeric_scale 
        FROM information_schema.columns 
        WHERE table_name = 'products' AND column_name IN ('code', 'price');
    `);
        console.log("Schema Info:", schemaRes.rows);

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await db.disconnect();
    }
}

main();
