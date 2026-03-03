import { DbContext } from "../core/DbContext";
import { Migration, MigrationRecord } from "./Migration";
import { MigrationBuilder } from "./MigrationBuilder";

/**
 * Manages database migrations
 */
export class Migrator {
    private static readonly HISTORY_TABLE = "__MigrationHistory";
    private migrations: Migration[] = [];

    constructor(private context: DbContext) {}

    /**
     * Register a migration
     * @param migration Migration instance
     */
    addMigration(migration: Migration): this {
        this.migrations.push(migration);
        return this;
    }

    /**
     * Register multiple migrations
     * @param migrations Array of migration instances
     */
    addMigrations(migrations: Migration[]): this {
        this.migrations.push(...migrations);
        return this;
    }

    /**
     * Ensure the migration history table exists
     */
    private async ensureMigrationHistoryTable(): Promise<void> {
        const provider = this.context.getProvider();
        const dialect = provider.getDialect();

        let createTableSql: string;

        if (dialect === 'postgresql') {
            createTableSql = `
                CREATE TABLE IF NOT EXISTS ${Migrator.HISTORY_TABLE} (
                    migration_id VARCHAR(255) PRIMARY KEY,
                    migration_name VARCHAR(255) NOT NULL,
                    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            `;
        } else if (dialect === 'mssql') {
            createTableSql = `
                IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${Migrator.HISTORY_TABLE}')
                CREATE TABLE ${Migrator.HISTORY_TABLE} (
                    migration_id NVARCHAR(255) PRIMARY KEY,
                    migration_name NVARCHAR(255) NOT NULL,
                    applied_at DATETIME2 NOT NULL DEFAULT GETDATE()
                )
            `;
        } else if (dialect === 'mariadb') {
            createTableSql = `
                CREATE TABLE IF NOT EXISTS ${Migrator.HISTORY_TABLE} (
                    migration_id VARCHAR(255) PRIMARY KEY,
                    migration_name VARCHAR(255) NOT NULL,
                    applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
                )
            `;
        } else {
            throw new Error(`Unsupported database dialect: ${dialect}`);
        }

        await provider.query(createTableSql);
    }

    /**
     * Get all applied migrations from the database
     */
    private async getAppliedMigrations(): Promise<MigrationRecord[]> {
        await this.ensureMigrationHistoryTable();

        const provider = this.context.getProvider();
        const result = await provider.query(
            `SELECT migration_id, migration_name, applied_at FROM ${Migrator.HISTORY_TABLE} ORDER BY applied_at`
        );

        return result.rows.map(row => ({
            migrationId: row.migration_id,
            migrationName: row.migration_name,
            appliedAt: new Date(row.applied_at)
        }));
    }

    /**
     * Record a migration as applied
     */
    private async recordMigration(migration: Migration): Promise<void> {
        const provider = this.context.getProvider();
        const placeholder1 = provider.getParameterPlaceholder(1);
        const placeholder2 = provider.getParameterPlaceholder(2);

        await provider.query(
            `INSERT INTO ${Migrator.HISTORY_TABLE} (migration_id, migration_name) VALUES (${placeholder1}, ${placeholder2})`,
            [migration.id, migration.name]
        );
    }

    /**
     * Remove a migration record
     */
    private async removeMigrationRecord(migrationId: string): Promise<void> {
        const provider = this.context.getProvider();
        const placeholder = provider.getParameterPlaceholder(1);

        await provider.query(
            `DELETE FROM ${Migrator.HISTORY_TABLE} WHERE migration_id = ${placeholder}`,
            [migrationId]
        );
    }

    /**
     * Get pending migrations that haven't been applied
     */
    async getPendingMigrations(): Promise<Migration[]> {
        const appliedMigrations = await this.getAppliedMigrations();
        const appliedIds = new Set(appliedMigrations.map(m => m.migrationId));

        return this.migrations
            .filter(m => !appliedIds.has(m.id))
            .sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * Get all applied migrations in order
     */
    async getAppliedMigrationsOrdered(): Promise<Migration[]> {
        const appliedRecords = await this.getAppliedMigrations();
        const migrationMap = new Map(this.migrations.map(m => [m.id, m]));

        return appliedRecords
            .map(record => migrationMap.get(record.migrationId))
            .filter((m): m is Migration => m !== undefined);
    }

    /**
     * Apply all pending migrations
     * @returns Number of migrations applied
     */
    async migrate(): Promise<number> {
        const pending = await this.getPendingMigrations();

        if (pending.length === 0) {
            console.log('No pending migrations.');
            return 0;
        }

        console.log(`Found ${pending.length} pending migration(s):`);
        pending.forEach(m => console.log(`  - ${m.id}_${m.name}`));

        const provider = this.context.getProvider();

        for (const migration of pending) {
            console.log(`Applying migration: ${migration.id}_${migration.name}...`);

            try {
                await provider.beginTransaction();

                const builder = new MigrationBuilder(provider);
                await migration.up(builder);
                await builder.execute();

                await this.recordMigration(migration);
                await provider.commitTransaction();

                console.log(`✓ Applied: ${migration.id}_${migration.name}`);
            } catch (error) {
                await provider.rollbackTransaction();
                console.error(`✗ Failed to apply migration: ${migration.id}_${migration.name}`);
                console.error(error);
                throw error;
            }
        }

        console.log(`Successfully applied ${pending.length} migration(s).`);
        return pending.length;
    }

    /**
     * Revert the last applied migration
     * @returns True if a migration was reverted, false if no migrations to revert
     */
    async revert(): Promise<boolean> {
        const applied = await this.getAppliedMigrationsOrdered();

        if (applied.length === 0) {
            console.log('No migrations to revert.');
            return false;
        }

        const lastMigration = applied[applied.length - 1];
        console.log(`Reverting migration: ${lastMigration.id}_${lastMigration.name}...`);

        const provider = this.context.getProvider();

        try {
            await provider.beginTransaction();

            const builder = new MigrationBuilder(provider);
            await lastMigration.down(builder);
            await builder.execute();

            await this.removeMigrationRecord(lastMigration.id);
            await provider.commitTransaction();

            console.log(`✓ Reverted: ${lastMigration.id}_${lastMigration.name}`);
            return true;
        } catch (error) {
            await provider.rollbackTransaction();
            console.error(`✗ Failed to revert migration: ${lastMigration.id}_${lastMigration.name}`);
            console.error(error);
            throw error;
        }
    }

    /**
     * Revert migrations to a specific migration (inclusive)
     * @param targetMigrationId Migration ID to revert to (this migration will also be reverted)
     */
    async revertTo(targetMigrationId: string): Promise<number> {
        const applied = await this.getAppliedMigrationsOrdered();
        const targetIndex = applied.findIndex(m => m.id === targetMigrationId);

        if (targetIndex === -1) {
            throw new Error(`Migration ${targetMigrationId} not found in applied migrations.`);
        }

        // Revert from last to target (inclusive)
        const migrationsToRevert = applied.slice(targetIndex).reverse();

        console.log(`Reverting ${migrationsToRevert.length} migration(s) to ${targetMigrationId}...`);

        const provider = this.context.getProvider();
        let revertedCount = 0;

        for (const migration of migrationsToRevert) {
            console.log(`Reverting: ${migration.id}_${migration.name}...`);

            try {
                await provider.beginTransaction();

                const builder = new MigrationBuilder(provider);
                await migration.down(builder);
                await builder.execute();

                await this.removeMigrationRecord(migration.id);
                await provider.commitTransaction();

                console.log(`✓ Reverted: ${migration.id}_${migration.name}`);
                revertedCount++;
            } catch (error) {
                await provider.rollbackTransaction();
                console.error(`✗ Failed to revert migration: ${migration.id}_${migration.name}`);
                console.error(error);
                throw error;
            }
        }

        console.log(`Successfully reverted ${revertedCount} migration(s).`);
        return revertedCount;
    }

    /**
     * Show migration status
     */
    async status(): Promise<void> {
        const applied = await this.getAppliedMigrations();
        const appliedIds = new Set(applied.map(m => m.migrationId));

        console.log('\n=== Migration Status ===\n');

        if (this.migrations.length === 0) {
            console.log('No migrations registered.');
            return;
        }

        const sorted = [...this.migrations].sort((a, b) => a.id.localeCompare(b.id));

        console.log('Applied Migrations:');
        const appliedMigrations = sorted.filter(m => appliedIds.has(m.id));
        if (appliedMigrations.length === 0) {
            console.log('  (none)');
        } else {
            appliedMigrations.forEach(m => {
                const record = applied.find(r => r.migrationId === m.id);
                console.log(`  ✓ ${m.id}_${m.name} (applied: ${record?.appliedAt.toISOString()})`);
            });
        }

        console.log('\nPending Migrations:');
        const pendingMigrations = sorted.filter(m => !appliedIds.has(m.id));
        if (pendingMigrations.length === 0) {
            console.log('  (none)');
        } else {
            pendingMigrations.forEach(m => {
                console.log(`  ○ ${m.id}_${m.name}`);
            });
        }

        console.log('');
    }
}
