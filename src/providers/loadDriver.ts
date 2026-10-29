/**
 * Load a database driver by name when a provider is built, so importing
 * rnxorm does not pull in drivers the app does not use.
 */
export function loadDriver<T>(provider: string, name: string): T {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        return require(name) as T;
    } catch (error) {
        const e = error as { code?: string; message: string };
        if (e?.code === 'MODULE_NOT_FOUND' && missingModule(e.message) === name) {
            throw new Error(
                `${provider} needs the "${name}" package. Install it with: npm install ${name}`
            );
        }
        throw error;
    }
}

/** The module a MODULE_NOT_FOUND error is about, from "Cannot find module 'x'". */
function missingModule(message: string): string | undefined {
    const match = /Cannot find module '([^']+)'/.exec(message);
    return match?.[1];
}
