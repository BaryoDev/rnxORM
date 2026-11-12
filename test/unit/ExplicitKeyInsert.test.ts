import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

@Entity('ek_users')
class EkUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;
}

// An explicit key must reach the INSERT, so a second row with the same key is
// rejected by the database instead of getting a new generated id.
describe('an explicit primary key is kept in the INSERT', () => {
    const expected: Record<CaptureDialect, string> = {
        postgresql: 'INSERT INTO "ek_users" ("id", "name") VALUES ($1, $2)',
        mssql: 'SET IDENTITY_INSERT [ek_users] ON; INSERT INTO [ek_users] ([id], [name]) VALUES (@p0, @p1); SET IDENTITY_INSERT [ek_users] OFF',
        mariadb: 'INSERT INTO `ek_users` (`id`, `name`) VALUES (?, ?)',
    };

    it.each(['postgresql', 'mssql', 'mariadb'] as const)('%s', async (dialect) => {
        const provider = new SqlCaptureProvider(dialect);
        const db = new DbContext(provider);
        const user = new EkUser();
        user.id = 1;
        user.name = 'First';
        db.set(EkUser).add(user);

        await db.saveChanges();

        const insert = provider.calls.find((c) => c.sql.includes('INSERT INTO'))!;
        expect(insert.sql).toBe(expected[dialect]);
        expect(insert.params).toEqual([1, 'First']);
    });
});
