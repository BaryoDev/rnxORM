import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { createTestProvider, getTestProviders } from '../test-config';

// No table name given, so the table defaults to the lower-cased class name:
// `order` and `user`, both reserved words. `group` and `select` are reserved
// column names.
@Entity()
class Order {
    @PrimaryKey()
    id!: number;

    @Column()
    group!: string;

    @Column({ type: 'integer' })
    select!: number;
}

@Entity()
class User {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column()
    order!: string;
}

async function dropTables(db: DbContext): Promise<void> {
    const translator = db.getProvider().getTranslator();
    for (const table of ['order', 'user']) {
        for (const statement of translator.translateDdl({ op: 'dropTable', table })) {
            await db.query(statement.text).catch(() => undefined);
        }
    }
}

describe('entities named after reserved words', () => {
    const realProviders = getTestProviders().filter(p => p !== 'mock');
    // The mock provider has no SQL engine. Without a real database the suite
    // would hold no test, which Jest fails.
    if (realProviders.length === 0) it.skip('needs a real database (USE_REAL_DB=true)', () => undefined);

    for (const providerName of realProviders) {
        describe(providerName, () => {
            let db: DbContext;
            // One provider for every context: an in-memory SQLite database lives in the provider.
            let provider: ReturnType<typeof createTestProvider>;

            beforeAll(async () => {
                provider = createTestProvider(providerName);
                db = new DbContext(provider);
                await db.connect();
                await dropTables(db);
                await db.ensureCreated();
            });

            afterAll(async () => {
                await dropTables(db);
                await db.disconnect();
            });

            it('Order: create, insert, query, update, delete', async () => {
                const orders = db.set(Order);

                const a = new Order();
                a.group = 'a';
                a.select = 1;
                const b = new Order();
                b.group = 'b';
                b.select = 2;
                orders.add(a);
                orders.add(b);
                await db.saveChanges();
                expect(a.id).toBeGreaterThan(0);

                const found = await orders.where('group', '=', 'b').toList();
                expect(found.map(o => o.select)).toEqual([2]);

                const sorted = await orders.orderByDescending('select').toList();
                expect(sorted.map(o => o.group)).toEqual(['b', 'a']);

                a.select = 10;
                await db.saveChanges();
                const reread = new DbContext(provider);
                {
                    const updated = await reread.set(Order).where('group', '=', 'a').toList();
                    expect(updated.map(o => o.select)).toEqual([10]);
                }

                orders.remove(a);
                orders.remove(b);
                await db.saveChanges();
                expect(await orders.toList()).toEqual([]);
            }, 30000);

            it('User: create, insert, query, update, delete', async () => {
                const users = db.set(User);

                const u = new User();
                u.name = 'Ann';
                u.order = 'first';
                users.add(u);
                await db.saveChanges();
                expect(u.id).toBeGreaterThan(0);

                const found = await users.where('order', '=', 'first').toList();
                expect(found.map(x => x.name)).toEqual(['Ann']);
                expect(await users.count()).toBe(1);

                u.name = 'Anna';
                await db.saveChanges();
                const reread = new DbContext(provider);
                {
                    const [row] = await reread.set(User).toList();
                    expect(row.name).toBe('Anna');
                }

                users.remove(u);
                await db.saveChanges();
                expect(await users.count()).toBe(0);
            }, 30000);
        });
    }
});
