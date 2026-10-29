import { QueryParameter } from '../../types';
import { Operand } from './Operand';

export type CompareOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'like' | 'notLike' | 'ilike';

export interface ComparePredicate {
    op: CompareOp;
    left: Operand;
    value: QueryParameter;
}

export interface InPredicate {
    op: 'in' | 'notIn';
    left: Operand;
    values: QueryParameter[];
}

export interface NullPredicate {
    op: 'isNull' | 'isNotNull';
    left: Operand;
}

export interface BetweenPredicate {
    op: 'between';
    left: Operand;
    low: QueryParameter;
    high: QueryParameter;
}

export interface LogicalPredicate {
    op: 'and' | 'or';
    parts: Predicate[];
}

export interface NotPredicate {
    op: 'not';
    part: Predicate;
}

export type Predicate =
    | ComparePredicate
    | InPredicate
    | NullPredicate
    | BetweenPredicate
    | LogicalPredicate
    | NotPredicate;
