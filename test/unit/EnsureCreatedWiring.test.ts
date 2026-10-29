import { DbContext } from '../../src/core/DbContext';
import { CascadeOption, MetadataStorage, RelationType } from '../../src/core/MetadataStorage';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

class WtUser {}
class WtPost {}

/**
 * Two entities that between them cover a nullable and a required column, an
 * integer key, two indexes (one unique, one default named), a two-column
 * unique constraint, a foreign key with both actions and a many-to-many
 * whose key columns differ from `id`.
 */
beforeAll(() => {
    const storage = MetadataStorage.get();
    storage.addEntity(WtUser, 'wt_users');
    storage.addColumn(WtUser, 'uid', { columnName: 'uid', type: 'integer', isPrimaryKey: true, isAutoIncrement: true });
    storage.addColumn(WtUser, 'name', { columnName: 'name', type: 'text', isNullable: true });
    storage.addColumn(WtUser, 'email', { columnName: 'email', type: 'varchar(50)', isNullable: false });
    storage.addIndex(WtUser, { target: WtUser, columns: ['name', 'email'], unique: false });
    storage.addIndex(WtUser, { target: WtUser, columns: ['email'], unique: true, name: 'ux_wt_users_email' });
    storage.addUniqueConstraint(WtUser, { target: WtUser, columns: ['name', 'email'] });

    storage.addEntity(WtPost, 'wt_posts');
    storage.addColumn(WtPost, 'pid', { columnName: 'pid', type: 'integer', isPrimaryKey: true, isAutoIncrement: true });
    storage.addColumn(WtPost, 'authorid', { columnName: 'authorid', type: 'integer', isNullable: false });
    storage.addRelation(WtPost, {
        target: WtPost,
        propertyName: 'author',
        relatedEntity: () => WtUser,
        relationType: RelationType.ManyToOne,
        foreignKeyColumn: 'authorid',
        onDelete: CascadeOption.SetNull,
        onUpdate: CascadeOption.Cascade,
    });
    storage.addRelation(WtPost, {
        target: WtPost,
        propertyName: 'readers',
        relatedEntity: () => WtUser,
        relationType: RelationType.ManyToMany,
        joinTable: 'wt_post_user',
        joinColumn: 'post_ref',
        inverseJoinColumn: 'user_ref',
        onDelete: CascadeOption.SetNull,
    });
});

async function captured(dialect: CaptureDialect): Promise<string[]> {
    const provider = new SqlCaptureProvider(dialect);
    const db = new DbContext(provider);
    await db.connect();
    await db.ensureCreated();
    return provider.calls.map((c) => c.sql).filter((sql) => !sql.includes('information_schema') && !sql.includes('INFORMATION_SCHEMA'));
}

const MSSQL_GUARD = (table: string) => `IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = '${table}')\n                `;

const FK =
    'ALTER TABLE wt_posts ADD CONSTRAINT fk_wt_posts_authorid FOREIGN KEY (authorid) REFERENCES wt_users(uid) ON DELETE SET NULL ON UPDATE CASCADE';
const INDEX_PLAIN = 'CREATE INDEX idx_wt_users_name_email ON wt_users (name, email)';
const INDEX_UNIQUE = 'CREATE UNIQUE INDEX ux_wt_users_email ON wt_users (email)';
const UNIQUE = 'ALTER TABLE wt_users ADD CONSTRAINT uq_wt_users_name_email UNIQUE (name, email)';

const joinTable = (type: string, pad: string, close: string) =>
    [
        `CREATE TABLE ${close === '        )' ? 'IF NOT EXISTS ' : ''}wt_post_user (`,
        `${pad}post_ref ${type} NOT NULL,`,
        `${pad}user_ref ${type} NOT NULL,`,
        `${pad}PRIMARY KEY (post_ref, user_ref),`,
        `${pad}FOREIGN KEY (post_ref) REFERENCES wt_posts(pid) ON DELETE SET NULL,`,
        `${pad}FOREIGN KEY (user_ref) REFERENCES wt_users(uid) ON DELETE SET NULL`,
        close,
    ].join('\n');

describe('ensureCreated hands the model to the DDL translator', () => {
    it('postgresql', async () => {
        expect(await captured('postgresql')).toEqual([
            'CREATE TABLE IF NOT EXISTS wt_users (uid SERIAL PRIMARY KEY, name TEXT, email VARCHAR(50) NOT NULL);',
            'CREATE TABLE IF NOT EXISTS wt_posts (pid SERIAL PRIMARY KEY, authorid INTEGER NOT NULL);',
            joinTable('INTEGER', ' '.repeat(12), '        )'),
            FK,
            INDEX_PLAIN,
            INDEX_UNIQUE,
            UNIQUE,
            'ALTER TABLE wt_users ADD COLUMN uid INTEGER',
            'ALTER TABLE wt_users ADD COLUMN name TEXT',
            'ALTER TABLE wt_users ADD COLUMN email VARCHAR(50)',
            'ALTER TABLE wt_posts ADD COLUMN pid INTEGER',
            'ALTER TABLE wt_posts ADD COLUMN authorid INTEGER',
        ]);
    });

    it('mssql', async () => {
        expect(await captured('mssql')).toEqual([
            MSSQL_GUARD('wt_users') +
                'CREATE TABLE wt_users (uid INT IDENTITY(1,1) PRIMARY KEY, name NVARCHAR(MAX), email NVARCHAR(50) NOT NULL);',
            MSSQL_GUARD('wt_posts') + 'CREATE TABLE wt_posts (pid INT IDENTITY(1,1) PRIMARY KEY, authorid INT NOT NULL);',
            MSSQL_GUARD('wt_post_user') +
                [
                    'CREATE TABLE wt_post_user (',
                    ...[
                        'post_ref INT NOT NULL,',
                        'user_ref INT NOT NULL,',
                        'PRIMARY KEY (post_ref, user_ref),',
                        'FOREIGN KEY (post_ref) REFERENCES wt_posts(pid) ON DELETE SET NULL,',
                        'FOREIGN KEY (user_ref) REFERENCES wt_users(uid) ON DELETE SET NULL',
                    ].map((l) => ' '.repeat(20) + l),
                    ' '.repeat(16) + ')',
                ].join('\n'),
            FK,
            INDEX_PLAIN,
            INDEX_UNIQUE,
            UNIQUE,
            'ALTER TABLE wt_users ADD uid INT',
            'ALTER TABLE wt_users ADD name NVARCHAR(MAX)',
            'ALTER TABLE wt_users ADD email NVARCHAR(50)',
            'ALTER TABLE wt_posts ADD pid INT',
            'ALTER TABLE wt_posts ADD authorid INT',
        ]);
    });

    it('mariadb', async () => {
        expect(await captured('mariadb')).toEqual([
            'CREATE TABLE IF NOT EXISTS wt_users (uid INT AUTO_INCREMENT PRIMARY KEY, name TEXT, email VARCHAR(50) NOT NULL);',
            'CREATE TABLE IF NOT EXISTS wt_posts (pid INT AUTO_INCREMENT PRIMARY KEY, authorid INT NOT NULL);',
            joinTable('INT', ' '.repeat(12), '        )'),
            FK,
            INDEX_PLAIN,
            INDEX_UNIQUE,
            UNIQUE,
            'ALTER TABLE wt_users ADD COLUMN uid INT',
            'ALTER TABLE wt_users ADD COLUMN name TEXT',
            'ALTER TABLE wt_users ADD COLUMN email VARCHAR(50)',
            'ALTER TABLE wt_posts ADD COLUMN pid INT',
            'ALTER TABLE wt_posts ADD COLUMN authorid INT',
        ]);
    });
});
