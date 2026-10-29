import { ALLOWED_OPERATORS, operatorToPredicate, resolvePredicate } from '../../src/core/Identifiers';

const upper = {
    columnName: 'name',
    hasConversion: true,
    convertToDb: (v: any) => `db:${v}`,
};

describe('operatorToPredicate', () => {
    const sample = (op: string): any => {
        if (op === 'IN' || op === 'NOT IN') return [1, 2];
        if (op === 'IS' || op === 'IS NOT') return null;
        return 5;
    };

    it.each([...ALLOWED_OPERATORS])('maps %s to a predicate on the column', op => {
        const predicate = operatorToPredicate('age', op, sample(op));
        expect((predicate as any).left).toEqual({ kind: 'column', name: 'age' });
    });

    it.each([
        ['=', 'eq'], ['!=', 'ne'], ['<>', 'ne'], ['>', 'gt'], ['<', 'lt'], ['>=', 'gte'], ['<=', 'lte'],
        ['LIKE', 'like'], ['ILIKE', 'ilike'], ['NOT LIKE', 'notLike'],
        ['IN', 'in'], ['NOT IN', 'notIn'], ['IS', 'isNull'], ['IS NOT', 'isNotNull'],
    ])('maps %s to %s', (op, expected) => {
        expect(operatorToPredicate('age', op, sample(op)).op).toBe(expected);
    });

    it('covers every allowed operator', () => {
        expect(ALLOWED_OPERATORS.length).toBe(14);
    });

    it('rejects an operator outside the allowlist', () => {
        expect(() => operatorToPredicate('age', '; DROP TABLE x', 1)).toThrow();
    });

    it('requires an array for IN and null for IS', () => {
        expect(() => operatorToPredicate('age', 'IN', 1)).toThrow(/array/);
        expect(() => operatorToPredicate('age', 'IS', 1)).toThrow(/null/);
    });
});

describe('resolvePredicate', () => {
    it('uses the column name and converts a compared value', () => {
        expect(resolvePredicate(upper, '=', 'a')).toEqual({
            op: 'eq', left: { kind: 'column', name: 'name' }, value: 'db:a',
        });
    });

    it('converts each element of an IN list', () => {
        const predicate = resolvePredicate(upper, 'IN', ['a', 'b']) as any;
        expect(predicate.op).toBe('in');
        expect(predicate.values).toEqual(['db:a', 'db:b']);
    });

    it('converts each element of a NOT IN list', () => {
        const predicate = resolvePredicate(upper, 'NOT IN', ['a', 'b']) as any;
        expect(predicate.values).toEqual(['db:a', 'db:b']);
    });

    it('leaves null alone', () => {
        const predicate = resolvePredicate(upper, '=', null) as any;
        expect(predicate.value).toBeNull();
        expect((resolvePredicate(upper, 'IS', null) as any).op).toBe('isNull');
    });

    it('passes values through when the column has no converter', () => {
        const plain = { columnName: 'age' };
        expect((resolvePredicate(plain, '>', 3) as any).value).toBe(3);
        expect((resolvePredicate(plain, 'IN', [1, 2]) as any).values).toEqual([1, 2]);
    });
});
