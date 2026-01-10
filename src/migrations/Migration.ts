import { MigrationBuilder } from "./MigrationBuilder";

/**
 * Base class for all migrations
 * Each migration represents a set of schema changes
 */
export abstract class Migration {
    /**
     * Unique identifier for this migration (timestamp-based)
     */
    readonly id: string;

    /**
     * Human-readable name for this migration
     */
    readonly name: string;

    constructor(id: string, name: string) {
        this.id = id;
        this.name = name;
    }

    /**
     * Apply the migration (upgrade schema)
     * @param builder Migration builder for defining schema changes
     */
    abstract up(builder: MigrationBuilder): Promise<void>;

    /**
     * Revert the migration (downgrade schema)
     * @param builder Migration builder for defining schema changes
     */
    abstract down(builder: MigrationBuilder): Promise<void>;
}

/**
 * Metadata about a migration stored in the database
 */
export interface MigrationRecord {
    migrationId: string;
    migrationName: string;
    appliedAt: Date;
}
