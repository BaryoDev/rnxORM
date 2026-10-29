import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';
import { MockDatabaseProvider } from '../mocks/MockDatabaseProvider';

/**
 * A transaction is a handle the context holds, not a slot on the provider.
 * Before the handle, a caller-opened transaction and saveChanges()'s own
 * wrapping fought over one provider slot (issue #38), and a second context
 * could not open a transaction at all (issue #52).
 */

@Entity('tx_items')
class TxItem {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

function makeDb() {
    const provider = new SqlCaptureProvider('postgresql');
    return { db: new DbContext(provider), provider };
}

function newItem(id: number, name = 'a'): TxItem {
    const item = new TxItem();
    item.id = id;
    item.name = name;
    return item;
}

async function makeMockDb() {
    const provider = new MockDatabaseProvider();
    await provider.connect();
    const first = new DbContext(provider);
    await first.ensureCreated();
    return { provider, first };
}

async function ids(source: { query(text: string): Promise<{ rows: any[] }> }): Promise<number[]> {
    const result = await source.query('SELECT * FROM tx_items');
    return result.rows.map(r => r.id).sort();
}

describe('saveChanges inside a caller-opened transaction (#38)', () => {
    it('does not open or commit a nested transaction', async () => {
        const { db, provider } = makeDb();

        const tx = await db.beginTransaction();

        db.set(TxItem).add(newItem(1));
        await db.saveChanges();

        // The caller's handle is still the only one open: saveChanges()
        // must not have committed it.
        expect(provider.transactionCalls).toEqual(['begin']);
        expect(tx.isOpen).toBe(true);
        expect(provider.openTransactions).toBe(1);

        await db.commitTransaction();
        expect(provider.transactionCalls).toEqual(['begin', 'commit']);
        expect(tx.isOpen).toBe(false);
    });

    it('runs the caller-transaction writes on the handle', async () => {
        const { db, provider } = makeDb();

        await db.beginTransaction();
        db.set(TxItem).add(newItem(1));
        await db.saveChanges();

        const insertAt = provider.calls.findIndex(c => c.sql.startsWith('INSERT INTO tx_items'));
        expect(provider.queryConnections[insertAt]).toBe('tx1');
    });

    it('a failing saveChanges does not roll back the caller transaction', async () => {
        const { db, provider } = makeDb();

        await db.beginTransaction();

        db.set(TxItem).add(newItem(1));
        provider.failWhen = sql => (sql.startsWith('INSERT') ? new Error('insert blew up') : undefined);

        await expect(db.saveChanges()).rejects.toThrow('insert blew up');

        // The error propagates so the caller can roll back, but saveChanges()
        // must not have rolled back a transaction it did not open.
        expect(provider.transactionCalls).toEqual(['begin']);
    });

    it('still wraps its own transaction when none is open', async () => {
        const { db, provider } = makeDb();

        db.set(TxItem).add(newItem(1));
        await db.saveChanges();

        expect(provider.transactionCalls).toEqual(['begin', 'commit']);
    });

    it('rolls back its own transaction on failure', async () => {
        const { db, provider } = makeDb();

        db.set(TxItem).add(newItem(1));
        provider.failWhen = sql => (sql.startsWith('INSERT') ? new Error('insert blew up') : undefined);

        await expect(db.saveChanges()).rejects.toThrow('insert blew up');
        expect(provider.transactionCalls).toEqual(['begin', 'rollback']);
        expect(provider.openTransactions).toBe(0);
    });

    it('a later rollback undoes writes saveChanges made in the caller transaction', async () => {
        const { provider, first: db } = await makeMockDb();

        await db.beginTransaction();
        db.set(TxItem).add(newItem(1));
        await db.saveChanges();

        expect(await ids(db)).toEqual([1]);

        await db.rollbackTransaction();

        expect(await ids(provider)).toEqual([]);
    });
});

describe('the context owns its transaction handle (#52)', () => {
    it('beginTransaction returns the handle and routes the context through it', async () => {
        const { db, provider } = makeDb();

        const tx = await db.beginTransaction();
        await db.query('SELECT 1');
        await db.executeSqlRaw('UPDATE tx_items SET name = $1', ['x']);

        expect(provider.queryConnections).toEqual(['tx1', 'tx1']);
        expect(tx.isOpen).toBe(true);

        await db.commitTransaction();
        await db.query('SELECT 2');
        expect(provider.queryConnections[2]).toBe('pool');
    });

    it('throws when the same context begins a second transaction', async () => {
        const { db } = makeDb();

        await db.beginTransaction();
        await expect(db.beginTransaction()).rejects.toThrow('already open');
    });

    it('allows a new transaction after the handle was ended directly', async () => {
        const { db, provider } = makeDb();

        const tx = await db.beginTransaction();
        await tx.commit();

        // The context notices the ended handle and goes back to the pool.
        await db.query('SELECT 1');
        expect(provider.queryConnections).toEqual(['pool']);

        await db.beginTransaction();
        expect(provider.openTransactions).toBe(1);
    });

    it('commitTransaction and rollbackTransaction with nothing open do nothing', async () => {
        const { db, provider } = makeDb();

        await db.commitTransaction();
        await db.rollbackTransaction();

        expect(provider.transactionCalls).toEqual([]);
    });

    it('refuses a query on a handle that has ended', async () => {
        const { db } = makeDb();

        const tx = await db.beginTransaction();
        await tx.rollback();

        await expect(tx.query('SELECT 1')).rejects.toThrow('already ended');
    });

    it('two contexts on one provider are independent units of work', async () => {
        const { provider, first } = await makeMockDb();
        const second = new DbContext(provider);

        await first.beginTransaction();
        await second.beginTransaction();

        first.set(TxItem).add(newItem(1, 'first'));
        second.set(TxItem).add(newItem(2, 'second'));
        await first.saveChanges();
        await second.saveChanges();

        // Each sees only its own writes.
        expect(await ids(first)).toEqual([1]);
        expect(await ids(second)).toEqual([2]);
        // Neither is visible outside until it commits.
        expect(await ids(provider)).toEqual([]);

        await first.rollbackTransaction();
        await second.commitTransaction();

        expect(await ids(provider)).toEqual([2]);
    });

    it('a plain provider.query during an open transaction runs on the pool', async () => {
        const { provider, first: db } = await makeMockDb();

        await db.beginTransaction();
        db.set(TxItem).add(newItem(1));
        await db.saveChanges();

        provider.queryLog = [];
        const viaPool = await provider.query('SELECT * FROM tx_items');
        const viaContext = await db.query('SELECT * FROM tx_items');

        expect(provider.queryLog.map(q => q.connection)).toEqual(['pool', 'tx1']);
        expect(viaPool.rows).toEqual([]);
        expect(viaContext.rows).toHaveLength(1);

        await db.rollbackTransaction();
    });
});
