import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { MetadataStorage } from '../../src/core/MetadataStorage';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

/**
 * MetadataStorage was a process-wide singleton and onModelCreating mutated it
 * on every construction, so two context types mapping the same entity shared
 * one model and the last one constructed won. For a multi-tenant app mapping
 * one entity to per-tenant tables, that is a cross-tenant read (issue #32).
 */

@Entity('ms_users')
class MsUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    isdeleted!: boolean;
}

@Entity('ms_late')
class MsLate {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

class TenantAContext extends DbContext {
    protected onModelCreating(mb: ModelBuilder): void {
        mb.entity(MsUser).toTable('tenant_a_users');
    }
}

class TenantBContext extends DbContext {
    protected onModelCreating(mb: ModelBuilder): void {
        mb.entity(MsUser).toTable('tenant_b_users');
    }
}

class FilteredContext extends DbContext {
    protected onModelCreating(mb: ModelBuilder): void {
        mb.entity(MsUser).hasQueryFilter({ property: 'isdeleted', operator: '=', value: false });
    }
}

class UnfilteredContext extends DbContext {
    protected onModelCreating(_mb: ModelBuilder): void {
        // deliberately no filter
    }
}

function provider() {
    return new SqlCaptureProvider('postgresql');
}

describe('model is scoped per context type (#32)', () => {
    it('does not retarget an existing context when a second one is constructed', async () => {
        const pa = provider();
        const pb = provider();

        const a = new TenantAContext(pa);
        const b = new TenantBContext(pb);

        await a.set(MsUser).toList();
        await b.set(MsUser).toList();

        expect(pa.lastCall!.sql).toBe('SELECT * FROM tenant_a_users');
        expect(pb.lastCall!.sql).toBe('SELECT * FROM tenant_b_users');
    });

    it('holds regardless of construction order', async () => {
        const pb = provider();
        const pa = provider();

        const b = new TenantBContext(pb);
        const a = new TenantAContext(pa);

        await b.set(MsUser).toList();
        await a.set(MsUser).toList();

        expect(pb.lastCall!.sql).toBe('SELECT * FROM tenant_b_users');
        expect(pa.lastCall!.sql).toBe('SELECT * FROM tenant_a_users');
    });

    it('keeps two instances of the same context type consistent', async () => {
        const p1 = provider();
        const p2 = provider();

        const one = new TenantAContext(p1);
        const two = new TenantAContext(p2);

        await one.set(MsUser).toList();
        await two.set(MsUser).toList();

        expect(p1.lastCall!.sql).toBe('SELECT * FROM tenant_a_users');
        expect(p2.lastCall!.sql).toBe('SELECT * FROM tenant_a_users');
    });

    it('does not leak a query filter between context types', async () => {
        const pf = provider();
        const pu = provider();

        const filtered = new FilteredContext(pf);
        const unfiltered = new UnfilteredContext(pu);

        await filtered.set(MsUser).toList();
        await unfiltered.set(MsUser).toList();

        expect(pf.lastCall!.sql).toBe('SELECT * FROM ms_users WHERE isdeleted = $1');
        expect(pu.lastCall!.sql).toBe('SELECT * FROM ms_users');
    });

    it('interleaves queries from two contexts correctly', async () => {
        const pa = provider();
        const pb = provider();

        const a = new TenantAContext(pa);
        const b = new TenantBContext(pb);

        await a.set(MsUser).toList();
        await b.set(MsUser).toList();
        await a.set(MsUser).toList();
        await b.set(MsUser).toList();

        expect(pa.calls.map(c => c.sql)).toEqual([
            'SELECT * FROM tenant_a_users',
            'SELECT * FROM tenant_a_users',
        ]);
        expect(pb.calls.map(c => c.sql)).toEqual([
            'SELECT * FROM tenant_b_users',
            'SELECT * FROM tenant_b_users',
        ]);
    });

    it('a context with no onModelCreating still sees decorator metadata', async () => {
        const p = provider();
        const plain = new DbContext(p);

        await plain.set(MsUser).toList();

        expect(p.lastCall!.sql).toBe('SELECT * FROM ms_users');
    });

    it('lets a bare DbContext see standalone ModelBuilder registrations', async () => {
        // `new ModelBuilder().entity(X)...` outside onModelCreating is a
        // supported form, and it writes into the shared registry. A context
        // with no onModelCreating of its own reads that registry directly, so
        // it picks up registrations made after it was constructed.
        const p = provider();
        const plain = new DbContext(p);

        new ModelBuilder().entity(MsLate).toTable('late_table');

        await plain.set(MsLate).toList();
        expect(p.lastCall!.sql).toBe('SELECT * FROM late_table');
    });

    it('leaves the decorator registry unmodified by onModelCreating', () => {
        new TenantAContext(provider());

        // The shared seed keeps the table name the decorator declared; only the
        // per-context copy is retargeted.
        expect(MetadataStorage.shared().getEntity(MsUser)!.tableName).toBe('ms_users');
    });
});
