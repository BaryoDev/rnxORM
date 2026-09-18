import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider } from '../mocks/SqlCaptureProvider';

/**
 * Transaction state lives in a single slot on the provider instance, so a
 * caller-opened transaction and saveChanges()'s own wrapping fought over it:
 * saveChanges() committed the caller's outer transaction early and the
 * caller's later rollback became a no-op (issue #38).
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

describe('saveChanges inside a caller-opened transaction (#38)', () => {
    it('does not open or commit a nested transaction', async () => {
        const { db, provider } = makeDb();

        await db.beginTransaction();

        const item = new TxItem();
        item.id = 1;
        item.name = 'a';
        db.set(TxItem).add(item);
        await db.saveChanges();

        // The caller's transaction is still the only one open: saveChanges()
        // must not have committed it.
        expect(provider.transactionCalls).toEqual(['begin']);
        expect(provider.isInTransaction()).toBe(true);

        await db.commitTransaction();
        expect(provider.transactionCalls).toEqual(['begin', 'commit']);
    });

    it('a failing saveChanges does not roll back the caller transaction', async () => {
        const { db, provider } = makeDb();

        await db.beginTransaction();

        const item = new TxItem();
        item.id = 1;
        item.name = 'a';
        db.set(TxItem).add(item);

        jest.spyOn(provider, 'query').mockRejectedValueOnce(new Error('insert blew up'));

        await expect(db.saveChanges()).rejects.toThrow('insert blew up');

        // The error propagates so the caller can roll back, but saveChanges()
        // must not have rolled back a transaction it did not open.
        expect(provider.transactionCalls).toEqual(['begin']);
    });

    it('still wraps its own transaction when none is open', async () => {
        const { db, provider } = makeDb();

        const item = new TxItem();
        item.id = 1;
        item.name = 'a';
        db.set(TxItem).add(item);
        await db.saveChanges();

        expect(provider.transactionCalls).toEqual(['begin', 'commit']);
    });

    it('rolls back its own transaction on failure', async () => {
        const { db, provider } = makeDb();

        const item = new TxItem();
        item.id = 1;
        item.name = 'a';
        db.set(TxItem).add(item);

        jest.spyOn(provider, 'query').mockRejectedValueOnce(new Error('insert blew up'));

        await expect(db.saveChanges()).rejects.toThrow('insert blew up');
        expect(provider.transactionCalls).toEqual(['begin', 'rollback']);
    });
});
