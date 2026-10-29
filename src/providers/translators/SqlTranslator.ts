import { AggregateFn, Operand } from '../../core/query/model/Operand';
import { Predicate } from '../../core/query/model/Predicate';
import { InsertModel } from '../../core/query/model/InsertModel';
import { UpdateModel } from '../../core/query/model/UpdateModel';
import { DeleteModel } from '../../core/query/model/DeleteModel';
import { SelectModel } from '../../core/query/model/SelectModel';
import { SqlStatement } from '../../core/query/model/SqlStatement';
import { QueryParameter } from '../../core/types';

const COMPARE_SQL = {
    eq: '=',
    ne: '!=',
    gt: '>',
    gte: '>=',
    lt: '<',
    lte: '<=',
    like: 'LIKE',
    notLike: 'NOT LIKE',
} as const;

interface RenderState {
    params: QueryParameter[];
}

/**
 * Renders a SelectModel to SQL. Shared ANSI rendering lives here; each
 * dialect overrides only the hooks that differ.
 */
export abstract class SqlTranslator {
    /** Identifiers are bare in the query path today. */
    protected quoteIdentifier(name: string): string {
        return name;
    }

    /** 1-based position of the parameter. */
    protected abstract placeholder(n: number): string;

    /** Pagination fragment with a leading space, including any ORDER BY it needs. */
    protected abstract renderPagination(
        skip: number | undefined,
        take: number | undefined,
        hasOrder: boolean
    ): string;

    protected abstract renderIlike(left: string, placeholder: string): string;

    protected renderAggregate(fn: AggregateFn, column: string | undefined, _columnType?: string): string {
        return `${fn.toUpperCase()}(${column === undefined ? '*' : this.quoteIdentifier(column)})`;
    }

    /**
     * An aggregate rendered where its value is returned (the select list).
     * Dialects override this to change what comes back; HAVING and ORDER BY
     * keep the plain form from renderAggregate.
     */
    protected renderAggregateOutput(fn: AggregateFn, column: string | undefined, columnType?: string): string {
        return this.renderAggregate(fn, column, columnType);
    }

    protected renderBoolean(value: boolean): string {
        return value ? '1 = 1' : '1 = 0';
    }

    translateSelect(model: SelectModel): SqlStatement {
        const state: RenderState = { params: [] };
        let text = `SELECT ${model.distinct ? 'DISTINCT ' : ''}${this.renderItems(model)} FROM ${this.quoteIdentifier(model.table)}`;

        if (model.where) text += ` WHERE ${this.renderPredicate(model.where, state, false)}`;
        if (model.groupBy && model.groupBy.length > 0) {
            text += ` GROUP BY ${model.groupBy.map((c) => this.quoteIdentifier(c)).join(', ')}`;
        }
        if (model.having) text += ` HAVING ${this.renderPredicate(model.having, state, false)}`;

        const order = model.orderBy ?? [];
        if (order.length > 0) {
            const parts = order.map(
                (o) => `${this.renderOrderOperand(o.operand, model)} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`
            );
            text += ` ORDER BY ${parts.join(', ')}`;
        }
        if (model.skip !== undefined || model.take !== undefined) {
            text += this.renderPagination(model.skip, model.take, order.length > 0);
        }
        return { text, params: state.params };
    }

    /** ORDER BY operand. A dialect can override this when a select alias would change what a bare column name sorts by. */
    protected renderOrderOperand(operand: Operand, _model: SelectModel): string {
        return this.renderOperand(operand);
    }

    private renderItems(model: SelectModel): string {
        const items = model.items ?? [];
        if (items.length === 0) return '*';
        return items
            .map((item) => {
                const sql = item.operand.kind === 'agg'
                    ? this.renderAggregateOutput(item.operand.fn, item.operand.column, item.operand.columnType)
                    : this.renderOperand(item.operand);
                if (item.alias === undefined) return sql;
                return `${sql}${item.operand.kind === 'agg' ? ' as ' : ' AS '}${item.alias}`;
            })
            .join(', ');
    }

    protected renderOperand(operand: Operand): string {
        if (operand.kind === 'column') return this.quoteIdentifier(operand.name);
        return this.renderAggregate(operand.fn, operand.column, operand.columnType);
    }

    private bind(value: QueryParameter, state: RenderState): string {
        state.params.push(value);
        return this.placeholder(state.params.length);
    }

    private renderPredicate(p: Predicate, state: RenderState, nested: boolean): string {
        switch (p.op) {
            case 'and':
            case 'or': {
                if (p.parts.length === 0) return this.renderBoolean(p.op === 'and');
                const joined = p.parts
                    .map((part) => this.renderPredicate(part, state, true))
                    .join(p.op === 'and' ? ' AND ' : ' OR ');
                return nested && p.parts.length > 1 ? `(${joined})` : joined;
            }
            case 'not':
                return `NOT (${this.renderPredicate(p.part, state, false)})`;
            case 'isNull':
                return `${this.renderOperand(p.left)} IS NULL`;
            case 'isNotNull':
                return `${this.renderOperand(p.left)} IS NOT NULL`;
            case 'in':
            case 'notIn': {
                if (p.values.length === 0) return this.renderBoolean(p.op === 'notIn');
                const left = this.renderOperand(p.left);
                const marks = p.values.map((v) => this.bind(v, state)).join(', ');
                return `${left} ${p.op === 'in' ? 'IN' : 'NOT IN'} (${marks})`;
            }
            case 'between': {
                const left = this.renderOperand(p.left);
                const low = this.bind(p.low, state);
                const high = this.bind(p.high, state);
                return `${left} BETWEEN ${low} AND ${high}`;
            }
            case 'ilike': {
                const left = this.renderOperand(p.left);
                return this.renderIlike(left, this.bind(p.value, state));
            }
            default: {
                const left = this.renderOperand(p.left);
                return `${left} ${COMPARE_SQL[p.op]} ${this.bind(p.value, state)}`;
            }
        }
    }

    /** Text placed between the column list and VALUES (SQL Server OUTPUT). */
    protected renderInsertOutput(_returning: string): string {
        return '';
    }

    /** Text placed after VALUES (PostgreSQL RETURNING). */
    protected renderInsertReturning(_returning: string): string {
        return '';
    }

    /** Wraps an insert that writes an explicit identity value. No-op unless the dialect needs it. */
    protected wrapIdentityInsert(_table: string, sql: string): string {
        return sql;
    }

    translateInsert(model: InsertModel): SqlStatement {
        const state: RenderState = { params: [] };
        const marks = model.values.map((v) => this.bind(v, state));
        const cols = model.columns.map((c) => this.quoteIdentifier(c)).join(', ');
        const output = model.returning === undefined ? '' : this.renderInsertOutput(this.quoteIdentifier(model.returning));
        const tail = model.returning === undefined ? '' : this.renderInsertReturning(this.quoteIdentifier(model.returning));
        let text = `INSERT INTO ${this.quoteIdentifier(model.table)} (${cols})${output} VALUES (${marks.join(', ')})${tail}`;
        if (model.identityInsert) text = this.wrapIdentityInsert(this.quoteIdentifier(model.table), text);
        return { text, params: state.params };
    }

    translateUpdate(model: UpdateModel): SqlStatement {
        const state: RenderState = { params: [] };
        const set = model.set
            .map((a) => `${this.quoteIdentifier(a.column)} = ${this.bind(a.value, state)}`)
            .join(', ');
        let text = `UPDATE ${this.quoteIdentifier(model.table)} SET ${set}`;
        if (model.where) text += ` WHERE ${this.renderPredicate(model.where, state, false)}`;
        return { text, params: state.params };
    }

    translateDelete(model: DeleteModel): SqlStatement {
        const state: RenderState = { params: [] };
        let text = `DELETE FROM ${this.quoteIdentifier(model.table)}`;
        if (model.where) text += ` WHERE ${this.renderPredicate(model.where, state, false)}`;
        return { text, params: state.params };
    }
}
