import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';
import { MockDatabaseProvider } from '../mocks/MockDatabaseProvider';

@Entity('vc_settings')
class VcSetting {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    tags!: string[];
}

@Entity('vc_summaries')
class VcSummary {
    @PrimaryKey()
    id!: number;

    @Column()
    label!: string;

    @Column()
    total!: number;
}

beforeAll(() => {
    const builder = new ModelBuilder();
    builder.entity(VcSetting)
        .property(s => s.tags)
        .hasConversion(
            (tags: string[]) => JSON.stringify(tags),
            (value: string) => JSON.parse(value)
        );
    builder.entity(VcSummary).hasNoKey().toTable('vw_summaries');
});

function makeDb(): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider('postgresql');
    const db = new DbContext(provider);
    return { db, provider };
}

describe('value converters end-to-end', () => {
    it('converts entity values to database values on insert', async () => {
        const { db, provider } = makeDb();

        const setting = new VcSetting();
        setting.id = 1;
        setting.name = 'theme';
        setting.tags = ['dark', 'compact'];

        db.set(VcSetting).add(setting);
        await db.saveChanges();

        const insert = provider.calls.find(c => c.sql.startsWith('INSERT INTO vc_settings'))!;
        expect(insert.params).toContain('["dark","compact"]');
    });

    it('converts database values back to entity values when reading', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'theme', tags: '["dark","compact"]' }],
            rowCount: 1,
        });

        const settings = await db.set(VcSetting).toList();

        expect(settings[0].tags).toEqual(['dark', 'compact']);
    });

    it('converts entity values on update of a tracked entity', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'theme', tags: '["dark"]' }],
            rowCount: 1,
        });

        const [setting] = await db.set(VcSetting).toList();
        setting.tags = ['light'];
        await db.saveChanges();

        const update = provider.calls.find(c => c.sql.startsWith('UPDATE vc_settings'))!;
        expect(update.params).toContain('["light"]');
    });
});

describe('keyless entities', () => {
    it('maps query results without a primary key', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [
                { id: 1, label: 'Q1', total: 100 },
                { id: 2, label: 'Q2', total: 200 },
            ],
            rowCount: 2,
        });

        const summaries = await db.set(VcSummary).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM vw_summaries');
        expect(summaries).toHaveLength(2);
        expect(summaries[1].total).toBe(200);
    });

    it('skips table creation for keyless entities in ensureCreated()', async () => {
        const provider = new MockDatabaseProvider();
        const db = new DbContext(provider);
        await db.connect();

        const querySpy = jest.spyOn(provider, 'query');
        await db.ensureCreated();

        const createdTables = querySpy.mock.calls
            .map(([sql]) => sql as string)
            .filter(sql => sql.startsWith('CREATE TABLE'));
        expect(createdTables.some(sql => sql.includes('vw_summaries'))).toBe(false);

        await db.disconnect();
    });

    it('does not persist keyless entities through saveChanges()', async () => {
        const { db, provider } = makeDb();
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

        const summary = new VcSummary();
        summary.label = 'Q3';
        summary.total = 300;

        db.set(VcSummary).add(summary);
        const saved = await db.saveChanges();

        expect(saved).toBe(0);
        expect(provider.calls.some(c => c.sql.startsWith('INSERT INTO'))).toBe(false);

        warnSpy.mockRestore();
    });
});
