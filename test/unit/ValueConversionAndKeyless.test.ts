import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { Entity, PrimaryKey, Column, ManyToOne, OneToMany } from '../../src/decorators';
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

// Converted primary key and converted non-key column, matching the README's
// enum example. The converter is deliberately not identity-shaped, so a
// missing conversion shows up as the wrong bound parameter (#35).
enum VcRole { Admin = 0, User = 1 }

// Converted PRIMARY KEY: find(key) must convert before binding, or it looks
// up a row that exists using a value the column never holds.
@Entity('vc_tokens')
class VcToken {
    @PrimaryKey()
    id!: string;

    @Column()
    label!: string;
}

@Entity('vc_accounts')
class VcAccount {
    @PrimaryKey()
    id!: number;

    @Column()
    role!: VcRole;

    @Column()
    email!: string;
}

beforeAll(() => {
    new ModelBuilder().entity(VcToken)
        .property(t => t.id)
        .hasConversion(
            (id: string) => `tok_${id}`,
            (stored: string) => stored.replace(/^tok_/, '')
        );
    new ModelBuilder().entity(VcAccount)
        .property(a => a.role)
        .hasConversion(
            (r: VcRole) => VcRole[r],
            (s: string) => (VcRole as any)[s]
        );
});

describe('value converters on query inputs (#35)', () => {
    it('applies the converter to a where() value', async () => {
        const { db, provider } = makeDb();
        await db.set(VcAccount).where('role', '=', VcRole.Admin).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM vc_accounts WHERE role = $1');
        expect(provider.lastCall!.params).toEqual(['Admin']);
    });

    it('applies the converter per element for IN', async () => {
        const { db, provider } = makeDb();
        await db.set(VcAccount).where('role', 'IN', [VcRole.Admin, VcRole.User]).toList();

        expect(provider.lastCall!.params).toEqual(['Admin', 'User']);
    });

    it('binds nothing extra for IS NULL', async () => {
        const { db, provider } = makeDb();
        await db.set(VcAccount).where('role', 'IS', null).toList();

        expect(provider.lastCall!.sql).toBe('SELECT * FROM vc_accounts WHERE role IS NULL');
        expect(provider.lastCall!.params).toEqual([]);
    });

    it('leaves unconverted columns alone', async () => {
        const { db, provider } = makeDb();
        await db.set(VcAccount).where('email', '=', 'ada@example.com').toList();

        expect(provider.lastCall!.params).toEqual(['ada@example.com']);
    });

    it('applies the converter to find() on a converted primary key', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(VcToken).find('abc');

        expect(provider.lastCall!.sql).toBe('SELECT * FROM vc_tokens WHERE id = $1');
        expect(provider.lastCall!.params).toEqual(['tok_abc']);
    });

    it('leaves find() alone on an unconverted primary key', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [], rowCount: 0 });

        await db.set(VcSetting).find(1);

        expect(provider.lastCall!.params).toEqual([1]);
    });
});

// Converted primary key on the *parent* of a relation. The one-to-many and
// many-to-many loaders bind the parent key taken off the entity (domain form)
// against a column that stores the converted form (#35).
@Entity('vc_orgs')
class VcOrg {
    @PrimaryKey()
    id!: string;

    @Column()
    name!: string;

    @OneToMany(() => VcMember, (m: VcMember) => m.org)
    members!: VcMember[];
}

@Entity('vc_members')
class VcMember {
    @PrimaryKey()
    id!: number;

    @Column()
    nickname!: string;

    @ManyToOne(() => VcOrg, (o: VcOrg) => o.members)
    org!: VcOrg;
}

beforeAll(() => {
    new ModelBuilder().entity(VcOrg)
        .property(o => o.id)
        .hasConversion(
            (id: string) => `org_${id}`,
            (stored: string) => stored.replace(/^org_/, '')
        );
});

describe('value converters on include() lookups (#35)', () => {
    it('binds the converted parent key when loading a one-to-many collection', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 'org_7', name: 'Acme' }], rowCount: 1 });
        provider.nextResult({
            rows: [
                { id: 1, nickname: 'ada', orgid: 'org_7' },
                { id: 2, nickname: 'grace', orgid: 'org_7' },
            ],
            rowCount: 2,
        });

        const orgs = await db.set(VcOrg).include(o => o.members).toList();

        expect(provider.calls[1].sql).toBe('SELECT * FROM vc_members WHERE orgid IN ($1)');
        expect(provider.calls[1].params).toEqual(['org_7']);
        // The collection has to actually attach: keying the map by the row's FK
        // (database form) and looking it up by the entity key (domain form)
        // returns [] even when the second query found the rows.
        expect(orgs[0].members.map(m => m.nickname)).toEqual(['ada', 'grace']);
    });

    it('still exposes the parent key in domain form', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({ rows: [{ id: 'org_7', name: 'Acme' }], rowCount: 1 });
        provider.nextResult({ rows: [], rowCount: 0 });

        const orgs = await db.set(VcOrg).include(o => o.members).toList();

        expect(orgs[0].id).toBe('7');
        expect(orgs[0].members).toEqual([]);
    });
});
