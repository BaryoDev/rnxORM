import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { IDatabaseProvider } from '../../src/providers/IDatabaseProvider';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { createTestProvider, getTestProviders } from '../test-config';

@Entity('tx_handle_items')
class TxHandleItem {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

function newItem(id: number, name: string): TxHandleItem {
    const item = new TxHandleItem();
    item.id = id;
    item.name = name;
    return item;
}

async function insertViaPool(provider: IDatabaseProvider, id: number, name: string): Promise<void> {
    let sql = `INSERT INTO tx_handle_items (id, name) VALUES (${provider.getParameterPlaceholder(1)}, ${provider.getParameterPlaceholder(2)})`;
    // An integer key is an IDENTITY column on SQL Server.
    if (provider.getDialect() === 'mssql') {
        sql = `SET IDENTITY_INSERT tx_handle_items ON; ${sql}; SET IDENTITY_INSERT tx_handle_items OFF`;
    }
    await provider.query(sql, [id, name]);
}

/**
 * Read one row by key. A key lookup does not wait on another transaction's
 * uncommitted rows, which a table scan would on SQL Server.
 */
async function names(source: { query: DbContext['query'] }, provider: IDatabaseProvider, id: number): Promise<string[]> {
    const result = await source.query(
        `SELECT * FROM tx_handle_items WHERE id = ${provider.getParameterPlaceholder(1)}`,
        [id]
    );
    return result.rows.map(r => String(r.name));
}

describe('Transaction handle (#52)', () => {
    getTestProviders().forEach(providerName => {
        describe(`${providerName} - transactions`, () => {
            let provider: IDatabaseProvider;
            let first: DbContext;
            let second: DbContext;

            beforeAll(async () => {
                provider = createTestProvider(providerName);
                first = new DbContext(provider);
                second = new DbContext(provider);
                await first.connect();
                await first.ensureCreated();
            });

            afterAll(async () => {
                try {
                    await first.query(`DROP TABLE IF EXISTS tx_handle_items`);
                } catch (e) {
                    // Ignore
                }
                await first.disconnect();
            });

            afterEach(async () => {
                // A failed test must not leave its transaction open for the next one.
                await first.rollbackTransaction().catch(() => undefined);
                await second.rollbackTransaction().catch(() => undefined);
            });

            beforeEach(async () => {
                await first.query(`DELETE FROM tx_handle_items`);
                first.changeTracker.clear();
                second.changeTracker.clear();
            });

            it('keeps two contexts on one provider independent', async () => {
                await first.beginTransaction();
                await second.beginTransaction();

                first.set(TxHandleItem).add(newItem(1, 'first'));
                second.set(TxHandleItem).add(newItem(2, 'second'));
                await first.saveChanges();
                await second.saveChanges();

                // Each sees its own write and, being a different key, not the other's.
                expect(await names(first, provider, 1)).toEqual(['first']);
                expect(await names(second, provider, 2)).toEqual(['second']);

                await first.rollbackTransaction();
                await second.commitTransaction();

                expect(await names(provider, provider, 1)).toEqual([]);
                expect(await names(provider, provider, 2)).toEqual(['second']);
            });

            it('runs a plain provider.query outside an open transaction', async () => {
                await first.beginTransaction();
                first.set(TxHandleItem).add(newItem(1, 'in transaction'));
                await first.saveChanges();

                // Autocommitted on the pool. If it had run on the transaction's
                // connection, the rollback below would take it with it.
                await insertViaPool(provider, 2, 'on the pool');

                await first.rollbackTransaction();

                expect(await names(provider, provider, 1)).toEqual([]);
                expect(await names(provider, provider, 2)).toEqual(['on the pool']);
            });

            it('does not commit a caller transaction in saveChanges, and a rollback undoes it', async () => {
                const tx = await first.beginTransaction();

                first.set(TxHandleItem).add(newItem(1, 'a'));
                await first.saveChanges();

                expect(tx.isOpen).toBe(true);
                expect(await names(first, provider, 1)).toEqual(['a']);

                await first.rollbackTransaction();

                expect(tx.isOpen).toBe(false);
                expect(await names(provider, provider, 1)).toEqual([]);
            });

            it('commits the caller transaction when the caller commits the handle', async () => {
                const tx = await first.beginTransaction();

                first.set(TxHandleItem).add(newItem(1, 'kept'));
                await first.saveChanges();
                await tx.commit();

                expect(await names(provider, provider, 1)).toEqual(['kept']);
            });
        });
    });
});
