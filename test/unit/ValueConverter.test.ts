import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { MockDatabaseProvider } from '../mocks/MockDatabaseProvider';

@Entity('vc_settings')
class VcSetting {
    @PrimaryKey()
    id!: number;

    @Column()
    tags!: string[]; // stored as comma-separated string

    @Column()
    config!: { theme: string }; // stored as JSON string
}

describe('Value converters end-to-end (mock provider)', () => {
    let provider: MockDatabaseProvider;

    beforeAll(() => {
        new ModelBuilder().entity(VcSetting)
            .property(s => s.tags)
            .hasConversion(
                (value: string[]) => value.join(','),
                (value: string) => (value ? value.split(',') : [])
            );
        new ModelBuilder().entity(VcSetting)
            .property(s => s.config)
            .hasConversion(
                (value: { theme: string }) => JSON.stringify(value),
                (value: string) => JSON.parse(value)
            );
    });

    beforeEach(async () => {
        provider = new MockDatabaseProvider();
        const db = new DbContext(provider);
        await db.connect();
        await db.ensureCreated();
    });

    it('applies convertToDb on insert and convertFromDb on read', async () => {
        const db = new DbContext(provider);
        const setting = new VcSetting();
        setting.id = 1;
        setting.tags = ['alpha', 'beta'];
        setting.config = { theme: 'dark' };
        db.set(VcSetting).add(setting);
        await db.saveChanges();

        // The database row holds the converted representations
        const raw = await db.query('SELECT * FROM vc_settings WHERE id = $1', [1]);
        expect(raw.rows[0].tags).toBe('alpha,beta');
        expect(raw.rows[0].config).toBe('{"theme":"dark"}');

        // Reading through the ORM converts back
        const db2 = new DbContext(provider);
        const loaded = (await db2.set(VcSetting).find(1))!;
        expect(loaded.tags).toEqual(['alpha', 'beta']);
        expect(loaded.config).toEqual({ theme: 'dark' });
    });

    it('applies conversion on update', async () => {
        const db = new DbContext(provider);
        const setting = new VcSetting();
        setting.id = 1;
        setting.tags = ['alpha'];
        setting.config = { theme: 'dark' };
        db.set(VcSetting).add(setting);
        await db.saveChanges();

        const loaded = (await db.set(VcSetting).find(1))!;
        loaded.tags = ['alpha', 'gamma'];
        await db.saveChanges();

        const raw = await db.query('SELECT * FROM vc_settings WHERE id = $1', [1]);
        expect(raw.rows[0].tags).toBe('alpha,gamma');
    });
});
