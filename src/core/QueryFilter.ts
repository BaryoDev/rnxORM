import { IDatabaseProvider } from "../providers/IDatabaseProvider";
import { EntityMetadata } from "./MetadataStorage";
import { assertOperator, buildComparison } from "./Identifiers";

/**
 * A global query filter compiled to parameterized SQL fragments.
 */
export interface CompiledQueryFilter {
    clauses: string[];
    params: any[];
}

/**
 * Compile an entity's structured query filter conditions into parameterized
 * SQL clauses. Property names are mapped to column names via metadata and
 * value conversions are applied, so the clauses can be appended to any WHERE
 * clause for the entity's table.
 * @param metadata Entity metadata (may be undefined when the entity is unknown)
 * @param provider Database provider used for placeholder syntax
 * @param startIndex 1-based placeholder index to start numbering from
 */
export function compileQueryFilter(
    metadata: EntityMetadata | undefined,
    provider: IDatabaseProvider,
    startIndex: number
): CompiledQueryFilter {
    const compiled: CompiledQueryFilter = { clauses: [], params: [] };

    if (!metadata?.queryFilterConditions) {
        return compiled;
    }

    for (const condition of metadata.queryFilterConditions) {
        const column = metadata.columns.find(c => c.propertyName === condition.property);
        if (!column) {
            throw new Error(
                `Query filter references unknown property '${condition.property}' on entity ${metadata.target.name}`
            );
        }

        // The operator string reaches SQL, so it goes through the same closed
        // set as where() — filter conditions are data, not trusted SQL.
        // ModelBuilder.hasQueryFilter() validates at registration time too; this
        // check stays because metadata can also be populated directly.
        const operator = assertOperator(condition.operator, 'hasQueryFilter');

        let value = typeof condition.value === 'function' ? condition.value() : condition.value;
        const convert = (v: any) =>
            column.hasConversion && column.convertToDb && v !== undefined && v !== null
                ? column.convertToDb(v)
                : v;
        // A set operator binds each element, so the converter applies per element.
        value = (operator === 'IN' || operator === 'NOT IN') && Array.isArray(value)
            ? value.map(convert)
            : convert(value);

        // Placeholder numbering continues from however many parameters the
        // preceding conditions actually bound — IN binds one per element and
        // IS binds none, so "one placeholder per condition" is not safe here.
        const comparison = buildComparison(
            column.columnName,
            operator,
            value,
            provider,
            startIndex + compiled.params.length,
            'hasQueryFilter'
        );
        compiled.clauses.push(comparison.clause);
        compiled.params.push(...comparison.params);
    }

    return compiled;
}

/**
 * Evaluate an entity's global query filters in memory. Used by query paths
 * that cannot modify the SQL (raw SQL queries) and by the legacy predicate
 * form of hasQueryFilter().
 * @returns true when the entity passes all filters
 */
export function matchesQueryFilter(metadata: EntityMetadata | undefined, entity: any): boolean {
    if (!metadata) {
        return true;
    }

    if (metadata.queryFilter && !metadata.queryFilter(entity)) {
        return false;
    }

    if (metadata.queryFilterConditions) {
        for (const condition of metadata.queryFilterConditions) {
            const value = typeof condition.value === 'function' ? condition.value() : condition.value;
            const entityValue = entity[condition.property];
            const operator = condition.operator.trim().toUpperCase().replace(/\s+/g, ' ');

            switch (operator) {
                case '=': if (!(entityValue === value)) return false; break;
                case '!=':
                case '<>': if (!(entityValue !== value)) return false; break;
                case '>': if (!(entityValue > value)) return false; break;
                case '<': if (!(entityValue < value)) return false; break;
                case '>=': if (!(entityValue >= value)) return false; break;
                case '<=': if (!(entityValue <= value)) return false; break;
                case 'IN': if (!(Array.isArray(value) && value.includes(entityValue))) return false; break;
                case 'NOT IN': if (Array.isArray(value) && value.includes(entityValue)) return false; break;
                case 'IS': if (entityValue !== null && entityValue !== undefined) return false; break;
                case 'IS NOT': if (entityValue === null || entityValue === undefined) return false; break;
                default:
                    // Operators without an in-memory equivalent (LIKE, ILIKE,
                    // NOT LIKE) are only enforced on the SQL side.
                    break;
            }
        }
    }

    return true;
}
