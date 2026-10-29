import { SqliteProvider } from './SqliteProvider';

describe('SqliteProvider conversions', () => {
    let db: SqliteProvider;

    beforeEach(async () => {
        db = new SqliteProvider();
        await db.connect();
    });

    afterEach(async () => {
        await db.disconnect();
    });

    it('binds and reads back booleans, dates, JSON, null and undefined by declared type', async () => {
        await db.query('CREATE TABLE t (id INTEGER PRIMARY KEY, flag BOOLEAN, at DATETIME, doc TEXT, nothing TEXT, missing TEXT)');
        const when = new Date('2026-03-04T05:06:07.089Z');
        await db.query('INSERT INTO t (id, flag, at, doc, nothing, missing) VALUES (?, ?, ?, ?, ?, ?)', [
            1, true, when, JSON.stringify({ a: 1 }) as string, null, undefined,
        ]);
        await db.query('INSERT INTO t (id, flag) VALUES (?, ?)', [2, false]);
        await db.query('INSERT INTO t (id, doc) VALUES (?, ?)', [3, { a: [1, 2] } as unknown as string]);

        const one = (await db.query('SELECT * FROM t WHERE id = ?', [1])).rows[0];
        expect(one.flag).toBe(true);
        expect(one.at).toBeInstanceOf(Date);
        expect((one.at as Date).getTime()).toBe(when.getTime());
        expect(JSON.parse(one.doc as string)).toEqual({ a: 1 });
        expect(one.nothing).toBeNull();
        expect(one.missing).toBeNull();

        const two = (await db.query('SELECT * FROM t WHERE id = ?', [2])).rows[0];
        expect(two.flag).toBe(false);
        expect(two.at).toBeNull();

        // An object bound as a parameter is stored as JSON text.
        const three = (await db.query('SELECT doc FROM t WHERE id = ?', [3])).rows[0];
        expect(three.doc).toBe('{"a":[1,2]}');
    });

    it('stores a bound boolean as 0/1 and a Date as ISO text', async () => {
        await db.query('CREATE TABLE t (flag BOOLEAN, at DATETIME)');
        await db.query('INSERT INTO t VALUES (?, ?)', [true, new Date('2026-01-02T03:04:05.000Z')]);
        // typeof() and a computed column have no declared type, so nothing is converted on read.
        const raw = (await db.query('SELECT typeof(flag) AS ft, flag + 0 AS f, typeof(at) AS tt, at || \'\' AS a FROM t')).rows[0];
        expect(raw).toEqual({ ft: 'integer', f: 1, tt: 'text', a: '2026-01-02T03:04:05.000Z' });
    });

    it('reads CURRENT_TIMESTAMP, which has no zone, as UTC', async () => {
        await db.query('CREATE TABLE t (at DATETIME)');
        await db.query("INSERT INTO t VALUES ('2026-03-04 05:06:07')");
        const at = (await db.query('SELECT at FROM t')).rows[0].at as Date;
        expect(at.toISOString()).toBe('2026-03-04T05:06:07.000Z');

        await db.query('CREATE TABLE h (at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)');
        const before = Date.now();
        await db.query('INSERT INTO h DEFAULT VALUES');
        const stamped = (await db.query('SELECT at FROM h')).rows[0].at as Date;
        expect(Math.abs(stamped.getTime() - before)).toBeLessThan(5000);
    });

    it('enforces a foreign key declared in createTable', async () => {
        const t = db.getTranslator();
        const run = async (op: Parameters<typeof t.translateDdl>[0]) => {
            for (const s of t.translateDdl(op)) await db.query(s.text);
        };
        await run({ op: 'ensureTable', table: 'parents', columns: [{ name: 'id', type: 'integer', isPrimaryKey: true, nullable: false }] });
        await db.query('CREATE TABLE children (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parents(id))');

        await expect(db.query('INSERT INTO children (id, parent_id) VALUES (1, 99)')).rejects.toThrow(/FOREIGN KEY/i);
        await db.query('INSERT INTO parents (id) VALUES (1)');
        await db.query('INSERT INTO children (id, parent_id) VALUES (1, 1)');
    });
});
