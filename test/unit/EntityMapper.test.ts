import "reflect-metadata";
import { DbContext } from '../../src/core/DbContext';
import { ModelBuilder } from '../../src/core/ModelBuilder';
import { EntityState } from '../../src/core/EntityEntry';
import { Entity, PrimaryKey, Column } from '../../src/decorators';
import { SqlCaptureProvider, CaptureDialect } from '../mocks/SqlCaptureProvider';

/**
 * Characterization tests for DbSet's row -> entity mapping (GitHub issue #15).
 *
 * These tests pin the CURRENT behavior of DbSet.prototype.mapRowToEntity
 * (used by bare toList()/find()) and the static DbSet.mapRowToEntity (used by
 * QueryBuilder.toList(), i.e. where(...).toList()) as observed through the
 * public API, ahead of a future refactor that consolidates the two mapping
 * paths. They intentionally assert what the code DOES today, not what it
 * "should" do.
 */

@Entity('em_users')
class EmUser {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    // Renamed column: propertyName 'fullName' maps to DB column 'em_full_name'
    @Column({ name: 'em_full_name' })
    fullName!: string;

    // No initializer/conversion configured yet here - conversion wired below
    // via ModelBuilder so we can pin PropertyBuilder.hasConversion's effect.
    @Column()
    status!: string;

    // Plain numeric column with no conversion, used to pin "missing row key"
    // behavior distinctly from the converted 'status' column.
    @Column()
    age!: number;

    // Deliberately NOT declaring `secretFlag` here - it only exists as a
    // shadow property (configured below), i.e. a DB column with no
    // corresponding class field.
}

new ModelBuilder()
    .entity(EmUser)
    .property(u => u.status)
    .hasConversion(
        (value: string) => (value === 'Active' ? 'A' : 'I'),
        // Current implementation calls convertFromDb() unconditionally, even
        // when the raw DB value is null/undefined - there is no built-in
        // short-circuit for missing values. This converter surfaces that by
        // returning a distinguishable 'UNKNOWN' sentinel for null/undefined
        // input, rather than passing null/undefined through untouched.
        (value: string | null | undefined) =>
            value == null ? 'UNKNOWN' : value === 'A' ? 'Active' : 'Inactive'
    );

// Shadow property: exists as a DB column but is intentionally absent from
// the EmUser class. shadowProperty() defaults columnName to the exact
// propertyName given (no lowercasing - that only happens in the @Column
// decorator), so the DB column here is literally 'secretFlag'.
new ModelBuilder().entity(EmUser).shadowProperty('secretFlag', 'boolean');

function makeDb(dialect: CaptureDialect = 'postgresql'): { db: DbContext; provider: SqlCaptureProvider } {
    const provider = new SqlCaptureProvider(dialect);
    const db = new DbContext(provider);
    return { db, provider };
}

type Mode = 'bare' | 'where';

/**
 * Fetch EmUser rows through one of the two mapping paths:
 * - 'bare':  db.set(EmUser).toList()        -> DbSet.prototype.mapRowToEntity (instance)
 * - 'where': db.set(EmUser).where(...).toList() -> QueryBuilder.toList() -> DbSet.mapRowToEntity (static)
 */
async function fetchRows(db: DbContext, mode: Mode): Promise<EmUser[]> {
    if (mode === 'bare') {
        return db.set(EmUser).toList();
    }
    return db.set(EmUser).where('id', '>', 0).toList();
}

describe.each<Mode>(['bare', 'where'])('row -> entity mapping via %s toList()', (mode) => {
    it('maps plain columns, including renamed columns, from row to entity', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'Alice A. Employee', status: 'A', age: 30 }],
            rowCount: 1,
        });

        const [entity] = await fetchRows(db, mode);

        expect(entity.id).toBe(1);
        expect(entity.name).toBe('Alice');
        // Renamed column 'em_full_name' -> propertyName 'fullName'
        expect(entity.fullName).toBe('Alice A. Employee');
        expect(entity.age).toBe(30);
    });

    it('applies the value converter (convertFromDb) to raw DB values on read', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'x', status: 'A', age: 30 }],
            rowCount: 1,
        });
        const [active] = await fetchRows(db, mode);
        expect(active.status).toBe('Active');

        provider.nextResult({
            rows: [{ id: 2, name: 'Bob', em_full_name: 'x', status: 'I', age: 25 }],
            rowCount: 1,
        });
        const [inactive] = await fetchRows(db, mode);
        expect(inactive.status).toBe('Inactive');
    });

    it('current behavior: convertFromDb runs even when the raw column value is null (not skipped)', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'x', status: null, age: 30 }],
            rowCount: 1,
        });

        const [entity] = await fetchRows(db, mode);

        // mapRowToEntity does `value = col.convertFromDb(value)` unconditionally
        // when hasConversion + convertFromDb are set - there is no null guard.
        // Our converter turns null into the 'UNKNOWN' sentinel, proving the
        // converter was invoked rather than null passing through untouched.
        expect(entity.status).toBe('UNKNOWN');
    });

    it('current behavior: a row missing a non-converted column key maps the property to undefined', async () => {
        const { db, provider } = makeDb();
        // 'age' key is entirely absent from the row (not even `age: undefined`)
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'x', status: 'A' }],
            rowCount: 1,
        });

        const [entity] = await fetchRows(db, mode);

        // The mapping loop assigns `(entity as any)[col.propertyName] = value`
        // unconditionally for every non-shadow column, so the property IS set
        // as an own property on the entity, just with value undefined.
        expect(Object.prototype.hasOwnProperty.call(entity, 'age')).toBe(true);
        expect(entity.age).toBeUndefined();
    });

    it('excludes shadow properties from the mapped entity even when present in the row', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'x', status: 'A', age: 30, secretFlag: true }],
            rowCount: 1,
        });

        const [entity] = await fetchRows(db, mode);

        // mapRowToEntity skips assignment entirely for isShadowProperty columns,
        // so 'secretFlag' never becomes an own property of the entity - not even
        // as `undefined`.
        expect(Object.prototype.hasOwnProperty.call(entity, 'secretFlag')).toBe(false);
        expect((entity as any).secretFlag).toBeUndefined();
    });
});

describe('tracked vs asNoTracking mapping', () => {
    it('db.set(X).toList() (bare) registers mapped entities in the change tracker with originalValues', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'Alice A.', status: 'A', age: 30 }],
            rowCount: 1,
        });

        const [entity] = await db.set(EmUser).toList();

        expect(db.changeTracker.isTracked(entity)).toBe(true);
        const entry = db.changeTracker.entry(entity)!;
        expect(entry.state).toBe(EntityState.Unchanged);
        expect(entry.originalValues).toEqual({
            id: 1,
            name: 'Alice',
            fullName: 'Alice A.',
            status: 'Active',
            age: 30,
        });
    });

    it('db.set(X).find(id) registers the mapped entity in the change tracker', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'Alice A.', status: 'A', age: 30 }],
            rowCount: 1,
        });

        const entity = await db.set(EmUser).find(1);

        expect(entity).not.toBeNull();
        expect(db.changeTracker.isTracked(entity!)).toBe(true);
    });

    it('db.set(X).where(...).toList() (QueryBuilder default) also tracks mapped entities', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'Alice A.', status: 'A', age: 30 }],
            rowCount: 1,
        });

        const [entity] = await db.set(EmUser).where('id', '>', 0).toList();

        expect(db.changeTracker.isTracked(entity)).toBe(true);
        const entry = db.changeTracker.entry(entity)!;
        expect(entry.originalValues).toEqual({
            id: 1,
            name: 'Alice',
            fullName: 'Alice A.',
            status: 'Active',
            age: 30,
        });
    });

    it('db.set(X).asNoTracking().toList() does NOT register mapped entities in the change tracker', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'Alice A.', status: 'A', age: 30 }],
            rowCount: 1,
        });

        const [entity] = await db.set(EmUser).asNoTracking().toList();

        expect(db.changeTracker.isTracked(entity)).toBe(false);
        expect(db.changeTracker.entry(entity)).toBeUndefined();
    });

    it('db.set(X).where(...).asNoTracking().toList() does NOT register mapped entities either', async () => {
        const { db, provider } = makeDb();
        provider.nextResult({
            rows: [{ id: 1, name: 'Alice', em_full_name: 'Alice A.', status: 'A', age: 30 }],
            rowCount: 1,
        });

        const [entity] = await db.set(EmUser).where('id', '>', 0).asNoTracking().toList();

        expect(db.changeTracker.isTracked(entity)).toBe(false);
    });
});
