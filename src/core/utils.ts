/**
 * Extract a property name from a lambda selector function.
 * Supports: `u => u.name`, `(u) => u.name`, `function(u) { return u.name; }`
 */
export function extractPropertyName<T>(selector: (entity: T) => any): string {
    const funcStr = selector.toString();

    // Match: u => u.propertyName or (u) => u.propertyName
    const arrowMatch = funcStr.match(/(?:.*?=>.*?\.)(\w+)/);
    if (arrowMatch) {
        return arrowMatch[1];
    }

    // Match: function(u) { return u.propertyName; }
    const functionMatch = funcStr.match(/return\s+\w+\.(\w+)/);
    if (functionMatch) {
        return functionMatch[1];
    }

    throw new Error(`Cannot extract property name from selector: ${funcStr}`);
}
