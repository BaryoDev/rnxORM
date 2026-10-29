import { Predicate } from './Predicate';

export interface DeleteModel {
    table: string;
    where?: Predicate;
}
