import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

@Entity('seed_roles')
class SeedRole {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

/** Capture provider that answers the existence check with zero rows, so ensureCreated seeds. */
class SeedCapture extends SqlCaptureProvider {
    constructor(dialect: CaptureDialect) {
        super(dialect);
        this.defaultResult = { rows: [{ count: 0 }], rowCount: 1 };
    }
}

describe('Seed insert with an explicit auto-increment key', () => {
    beforeAll(() => {
        new ModelBuilder().entity(SeedRole).hasData([{ id: 1, name: 'admin' }]);
    });

    async function seedSql(dialect: CaptureDialect): Promise<string[]> {
        const provider = new SeedCapture(dialect);
        const db = new DbContext(provider);
        await db.connect();
        await db.ensureCreated();
        return provider.calls.map((c) => c.sql).filter((s) => s.includes('INSERT INTO seed_roles'));
    }

    it('wraps the insert in IDENTITY_INSERT on mssql', async () => {
        const sql = await seedSql('mssql');
        expect(sql).toEqual([
            'SET IDENTITY_INSERT seed_roles ON; INSERT INTO seed_roles (id, name) VALUES (@p0, @p1); SET IDENTITY_INSERT seed_roles OFF',
        ]);
    });

    it('does not use IDENTITY_INSERT on postgresql or mariadb', async () => {
        expect(await seedSql('postgresql')).toEqual(['INSERT INTO seed_roles (id, name) VALUES ($1, $2)']);
        expect(await seedSql('mariadb')).toEqual(['INSERT INTO seed_roles (id, name) VALUES (?, ?)']);
    });
});
