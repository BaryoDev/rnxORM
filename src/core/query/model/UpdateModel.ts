import { QueryParameter } from '../../types';
import { Predicate } from './Predicate';

export interface UpdateAssignment {
    column: string;
    value: QueryParameter;
}

export interface UpdateModel {
    table: string;
    /** Rendered first, so its values are bound before the where values. */
    set: UpdateAssignment[];
    where?: Predicate;
}
