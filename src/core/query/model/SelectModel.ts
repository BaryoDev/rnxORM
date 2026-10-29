import { Operand } from './Operand';
import { Predicate } from './Predicate';

export interface SelectItem {
    operand: Operand;
    alias?: string;
}

export interface OrderItem {
    /** A column name or an alias from the select list. */
    operand: Operand;
    direction: 'asc' | 'desc';
}

export interface SelectModel {
    table: string;
    distinct?: boolean;
    /** Empty or omitted renders `*`. */
    items?: SelectItem[];
    where?: Predicate;
    groupBy?: string[];
    having?: Predicate;
    orderBy?: OrderItem[];
    skip?: number;
    take?: number;
}
