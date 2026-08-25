import "reflect-metadata";
import {
    ALLOWED_OPERATORS,
    assertColumn,
    assertColumnOrAlias,
    assertHavingExpression,
    assertOperator,
} from '../../src/core/Identifiers';
import { Entity, PrimaryKey, Column } from '../../src/decorators';

@Entity('inj_products')
class InjProduct {
    @PrimaryKey()
    id!: number;

    @Column()
    name!: string;

    @Column({ name: 'unit_price' })
    price!: number;
}

class InjUnmapped {}

describe('assertOperator', () => {
    it.each([...ALLOWED_OPERATORS])('allows %s', op => {
        expect(assertOperator(op, 'where')).toBe(op);
    });

    it('uppercases keyword operators', () => {
        expect(assertOperator('like', 'where')).toBe('LIKE');
        expect(assertOperator('ilike', 'where')).toBe('ILIKE');
        expect(assertOperator('not  like', 'where')).toBe('NOT LIKE');
    });

    it.each([
        '; DROP TABLE users; --',
        '= 1 OR 1',
        'IN',
        'BETWEEN',
        '=;',
        '',
    ])('rejects %j', op => {
        expect(() => assertOperator(op, 'where')).toThrow(/not supported/);
    });
});

describe('assertColumn', () => {
    it('accepts a property name and returns the column name', () => {
        expect(assertColumn(InjProduct, 'price', 'where')).toBe('unit_price');
    });

    it('accepts a column name as-is', () => {
        expect(assertColumn(InjProduct, 'unit_price', 'where')).toBe('unit_price');
    });

    it('accepts default-lowercased columns by either spelling', () => {
        expect(assertColumn(InjProduct, 'name', 'orderBy')).toBe('name');
    });

    it.each([
        'name; DROP TABLE inj_products; --',
        'name) OR (1=1',
        "name'",
        'nonexistent',
        '(SELECT password FROM users)',
    ])('rejects %j with the entity name in the error', column => {
        expect(() => assertColumn(InjProduct, column, 'orderBy')).toThrow(/InjProduct/);
    });

    it('throws for an entity with no metadata', () => {
        expect(() => assertColumn(InjUnmapped as any, 'name', 'where')).toThrow(/no entity metadata/);
    });
});

describe('assertHavingExpression', () => {
    it('allows COUNT(*)', () => {
        expect(assertHavingExpression(InjProduct, 'COUNT(*)', 'having')).toBe('COUNT(*)');
    });

    it('allows aggregates over mapped properties, resolving the column', () => {
        expect(assertHavingExpression(InjProduct, 'SUM(price)', 'having')).toBe('SUM(unit_price)');
        expect(assertHavingExpression(InjProduct, 'avg( unit_price )', 'having')).toBe('AVG(unit_price)');
    });

    it('allows a bare mapped column', () => {
        expect(assertHavingExpression(InjProduct, 'name', 'having')).toBe('name');
    });

    it.each([
        'COUNT(*) > 0; DROP TABLE inj_products',
        'SUM(nonexistent)',
        'EXEC(sp_evil)',
        "COUNT(*') --",
    ])('rejects %j', expression => {
        expect(() => assertHavingExpression(InjProduct, expression, 'having')).toThrow();
    });
});

describe('assertColumnOrAlias', () => {
    it('resolves mapped properties to column names', () => {
        expect(assertColumnOrAlias(InjProduct, 'price', 'orderBy')).toBe('unit_price');
    });

    it('passes through plain-identifier aliases untouched', () => {
        expect(assertColumnOrAlias(InjProduct, 'total', 'orderBy')).toBe('total');
    });

    it.each([
        'total; DROP TABLE x',
        'a b',
        "alias'",
        '1total',
        '',
    ])('rejects %j', name => {
        expect(() => assertColumnOrAlias(InjProduct, name, 'orderBy')).toThrow();
    });
});
