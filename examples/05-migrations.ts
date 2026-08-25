/**
 * rnxORM Migrations
 *
 * A programmatic Migrator with two migrations (createTable, then addColumn,
 * each with a matching down()), applied with migrate() and inspected with
 * status().
 *
 * In your app: import { DbContext, PostgreSQLProvider, Migration, MigrationBuilder, Migrator } from "rnxorm";
 * Here we import from "../src" so the example runs against the repo's source.
 *
 * --- CLI equivalents ---
 *
 * Scaffold a migration file:
 *   npx rnxorm migration:create create-widgets-table
 *
 * Apply/inspect migrations, driven by a rnxorm.config.js in your project root:
 *   npx rnxorm migration:run
 *   npx rnxorm migration:status
 *
 * rnxorm.config.js shape (loaded by migration:run/revert/status):
 *
 *   const { DbContext, PostgreSQLProvider, Migrator } = require("rnxorm");
 *   const migrations = require("./dist/migrations");
 *
 *   module.exports = {
 *       async createMigrator() {
 *           const context = new DbContext(new PostgreSQLProvider({
 *               host: "localhost", port: 5433, user: "postgres",
 *               password: "postgres", database: "rnxorm_test",
 *           }));
 *           await context.connect();
 *           const migrator = new Migrator(context);
 *           migrator.addMigrations(Object.values(migrations).map((M) => new M()));
 *           return migrator;
 *       },
 *   };
 */
import "reflect-metadata";
import { DbContext, Migration, MigrationBuilder, Migrator } from "../src";
import { PostgreSQLProvider } from "../src/providers";

const CREATE_ID = "20260101000001";
const ADD_COLUMN_ID = "20260101000002";

class CreateWidgetsTable extends Migration {
    constructor() {
        super(CREATE_ID, "create_ex5_widgets");
    }

    async up(builder: MigrationBuilder): Promise<void> {
        builder.createTable("ex5_widgets", [
            { name: "id", type: "integer", isPrimaryKey: true, isAutoIncrement: true },
            { name: "name", type: "varchar(100)", nullable: false },
        ]);
    }

    async down(builder: MigrationBuilder): Promise<void> {
        builder.dropTable("ex5_widgets");
    }
}

class AddPriceColumn extends Migration {
    constructor() {
        super(ADD_COLUMN_ID, "add_ex5_widgets_price");
    }

    async up(builder: MigrationBuilder): Promise<void> {
        builder.addColumn("ex5_widgets", "price", "integer", { nullable: false, defaultValue: 0 });
    }

    async down(builder: MigrationBuilder): Promise<void> {
        builder.dropColumn("ex5_widgets", "price");
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

    const db = new DbContext(provider);
    await db.connect();

    console.log("=== 05: Migrations ===\n");

    // Self-contained: drop this example's table, and clear any history rows
    // from a previous run of this file so migrate() treats both migrations
    // as pending again. The history table itself may not exist yet on a
    // fresh database, hence the guard.
    await db.executeSqlRaw("DROP TABLE IF EXISTS ex5_widgets");
    try {
        // Unquoted, matching how Migrator creates it: Postgres folds unquoted
        // identifiers to lowercase, so a quoted "__MigrationHistory" here
        // would silently miss the real (lowercased) table.
        await db.executeSqlRaw(
            "DELETE FROM __MigrationHistory WHERE migration_id = $1 OR migration_id = $2",
            [CREATE_ID, ADD_COLUMN_ID]
        );
    } catch {
        // History table doesn't exist yet on a fresh database - nothing to clear.
    }

    const migrator = new Migrator(db);
    migrator.addMigrations([new CreateWidgetsTable(), new AddPriceColumn()]);

    console.log("--- migrate() ---");
    const applied = await migrator.migrate();
    console.log(`migrate() applied ${applied} migration(s)`);

    console.log("\n--- status() ---");
    await migrator.status();

    const columns = await db.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position",
        ["ex5_widgets"]
    );
    console.log(
        `ex5_widgets columns: ${columns.rows.map((r: any) => r.column_name).join(", ")}`
    );

    await db.disconnect();
    console.log("\nDisconnected. Migrations example complete.");
}

main().catch((err) => {
    console.error("Migrations example failed:", err);
    process.exit(1);
});
