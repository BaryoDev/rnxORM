import { QueryParameter } from '../../types';

export interface InsertModel {
    table: string;
    columns: string[];
    /** One value per column, in the same order. */
    values: QueryParameter[];
    /** Key column to read back. The translator picks RETURNING, OUTPUT INSERTED or nothing. */
    returning?: string;
    /** The statement writes an explicit value into an identity column. Only SQL Server cares. */
    identityInsert?: boolean;
}
