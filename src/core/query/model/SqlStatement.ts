import { QueryParameter } from '../../types';

/** A finished statement: SQL text plus its bound parameters in placeholder order. */
export interface SqlStatement {
    text: string;
    params: QueryParameter[];
}
