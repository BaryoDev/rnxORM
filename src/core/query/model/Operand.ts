export type AggregateFn = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** A resolved column name. Translators never look up metadata. */
export interface ColumnOperand {
    kind: 'column';
    name: string;
}

/** An aggregate over a column. `column` is omitted for COUNT(*). */
export interface AggregateOperand {
    kind: 'agg';
    fn: AggregateFn;
    column?: string;
    /** Declared column type, carried for dialect casts of aggregate results. */
    columnType?: string;
}

export type Operand = ColumnOperand | AggregateOperand;
