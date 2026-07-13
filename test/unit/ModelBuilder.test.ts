import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { createTestProvider } from '../test-config';

@Entity('mb_users')
class MbUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    email!: string;

    @Column()
    isDeleted!: boolean;
}

@Entity('mb_orders')
class MbOrder {
    @PrimaryKey()
    id!: number;

    @Column()
    code!: string;

    @Column()
    total!: number;
}

@Entity('mb_views')
class MbView {
    @PrimaryKey()
    id!: number;

    @Column()
    label!: string;
}

@Entity('mb_seeds')
class MbSeed {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

function meta(entityType: any) {
    return MetadataStorage.get().getEntity(entityType)!;
}

describe('ModelBuilder metadata configuration', () => {
    const builder = new ModelBuilder();

    it('toTable() changes the table name', () => {
        builder.entity(MbOrder).toTable('mb_orders_renamed');
        expect(meta(MbOrder).tableName).toBe('mb_orders_renamed');
        builder.entity(MbOrder).toTable('mb_orders');
        expect(meta(MbOrder).tableName).toBe('mb_orders');
    });

    it('hasKey() moves the primary key to the selected property', () => {
        builder.entity(MbOrder).hasKey(o => o.code);
        expect(meta(MbOrder).columns.find(c => c.propertyName === 'code')!.isPrimaryKey).toBe(true);
        expect(meta(MbOrder).columns.find(c => c.propertyName === 'id')!.isPrimaryKey).toBe(false);
        builder.entity(MbOrder).hasKey(o => o.id);
    });

    it('hasNoKey() marks the entity keyless and clears primary keys', () => {
        builder.entity(MbView).hasNoKey();
        expect(meta(MbView).isKeyless).toBe(true);
        expect(meta(MbView).columns.some(c => c.isPrimaryKey)).toBe(false);
    });

    it('hasIndex() registers an index with unique flag and custom name', () => {
        builder.entity(MbUser).hasIndex(u => u.email, { unique: true, name: 'idx_mb_email' });
        const index = meta(MbUser).indexes.find(i => i.name === 'idx_mb_email');
        expect(index).toBeDefined();
        expect(index!.columns).toEqual(['email']);
        expect(index!.unique).toBe(true);
    });

    it('hasCompositeIndex() registers a multi-column index', () => {
        builder.entity(MbUser).hasCompositeIndex([u => u.name, u => u.email], { name: 'idx_mb_name_email' });
        const index = meta(MbUser).indexes.find(i => i.name === 'idx_mb_name_email');
        expect(index).toBeDefined();
        expect(index!.columns).toEqual(['name', 'email']);
    });

    it('hasUnique() registers a unique constraint', () => {
        builder.entity(MbUser).hasUnique(u => u.name, { name: 'uq_mb_name' });
        const constraint = meta(MbUser).uniqueConstraints.find(u => u.name === 'uq_mb_name');
        expect(constraint).toBeDefined();
        expect(constraint!.columns).toEqual(['name']);
    });

    it('property() configures nullability, length, column name and type', () => {
        builder.entity(MbUser)
            .property(u => u.email)
            .isRequired()
            .hasMaxLength(100);
        const email = meta(MbUser).columns.find(c => c.propertyName === 'email')!;
        expect(email.isNullable).toBe(false);
        expect(email.type).toBe('varchar(100)');

        builder.entity(MbUser).property(u => u.email).isOptional();
        expect(email.isNullable).toBe(true);

        builder.entity(MbOrder)
            .property(o => o.total)
            .hasColumnName('order_total')
            .hasColumnType('decimal(10, 2)');
        const total = meta(MbOrder).columns.find(c => c.propertyName === 'total')!;
        expect(total.columnName).toBe('order_total');
        expect(total.type).toBe('decimal(10, 2)');
        builder.entity(MbOrder).property(o => o.total).hasColumnName('total');
    });

    it('hasConversion() stores converters that round-trip values', () => {
        builder.entity(MbUser)
            .property(u => u.name)
            .hasConversion(
                (value: string) => JSON.stringify(value),
                (value: string) => JSON.parse(value)
            );
        const name = meta(MbUser).columns.find(c => c.propertyName === 'name')!;
        expect(name.hasConversion).toBe(true);
        const stored = name.convertToDb!('Alice');
        expect(stored).toBe('"Alice"');
        expect(name.convertFromDb!(stored)).toBe('Alice');

        // Remove the converter so it doesn't affect the query-filter tests below
        name.hasConversion = false;
        name.convertToDb = undefined;
        name.convertFromDb = undefined;
    });

    it('isConcurrencyToken() flags the column', () => {
        builder.entity(MbOrder).property(o => o.total).isConcurrencyToken();
        const total = meta(MbOrder).columns.find(c => c.propertyName === 'total')!;
        expect(total.isConcurrencyToken).toBe(true);
        total.isConcurrencyToken = false;
    });

    it('shadowProperty() adds a database-only column', () => {
        builder.entity(MbOrder).shadowProperty('created_at', 'timestamp', {
            nullable: true,
            defaultValue: 'legacy',
        });
        const shadow = meta(MbOrder).columns.find(c => c.propertyName === 'created_at')!;
        expect(shadow.isShadowProperty).toBe(true);
        expect(shadow.type).toBe('timestamp');
        expect(shadow.defaultValue).toBe('legacy');
    });

    it('hasData() stores seed data', () => {
        builder.entity(MbSeed).hasData([
            { id: 1, name: 'first' },
            { id: 2, name: 'second' },
        ]);
        expect(meta(MbSeed).seedData).toHaveLength(2);
    });
});

describe('Seeding via ensureCreated (mock provider)', () => {
    it('inserts seed data idempotently', async () => {
        const db = new DbContext(createTestProvider('mock'));
        await db.connect();
        await db.ensureCreated();

        const first = await db.set(MbSeed).toList();
        expect(first).toHaveLength(2);
        expect(first.map(s => s.name).sort()).toEqual(['first', 'second']);

        // Second run must not duplicate
        await db.ensureCreated();
        const second = await db.set(MbSeed).toList();
        expect(second).toHaveLength(2);

        await db.disconnect();
    });
});

describe('Global query filters (mock provider)', () => {
    let db: DbContext;

    beforeAll(async () => {
        new ModelBuilder().entity(MbUser).hasQueryFilter(u => !u.isDeleted);

        db = new DbContext(createTestProvider('mock'));
        await db.connect();
        await db.ensureCreated();

        const users = db.set(MbUser);
        const active = new MbUser();
        active.id = 1;
        active.name = 'Active';
        active.email = 'a@test.com';
        active.isDeleted = false;

        const deleted = new MbUser();
        deleted.id = 2;
        deleted.name = 'Deleted';
        deleted.email = 'd@test.com';
        deleted.isDeleted = true;

        users.add(active);
        users.add(deleted);
        await db.saveChanges();
        db.changeTracker.clear();
    });

    afterAll(async () => {
        await db.disconnect();
    });

    it('stores the filter in metadata', () => {
        expect(meta(MbUser).queryFilter).toBeDefined();
    });

    it('plain toList() applies the filter', async () => {
        const users = await db.set(MbUser).toList();
        expect(users).toHaveLength(1);
        expect(users[0].name).toBe('Active');
        db.changeTracker.clear();
    });

    it('find() returns null for filtered-out entities', async () => {
        expect(await db.set(MbUser).find(2)).toBeNull();
        expect(await db.set(MbUser).find(1)).not.toBeNull();
        db.changeTracker.clear();
    });

    it('where() chains apply the filter', async () => {
        const users = await db.set(MbUser).where('id', '>', 0).toList();
        expect(users).toHaveLength(1);
        expect(users[0].name).toBe('Active');
        db.changeTracker.clear();
    });

    it('ignoreQueryFilters() bypasses the filter', async () => {
        const users = await db.set(MbUser).where('id', '>', 0).ignoreQueryFilters().toList();
        expect(users).toHaveLength(2);
        db.changeTracker.clear();
    });
});
