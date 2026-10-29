/**
 * Load a database driver when a provider is built, so importing rnxorm does
 * not pull in drivers the app does not use.
 *
 * `load` is a literal `require("name")` written in the provider file, inside a
 * try block. Bundlers only see a literal require, and webpack only treats a
 * missing module as optional when the require sits in a try.
 */
export function loadDriver<T>(provider: string, name: string, load: () => unknown): T {
    try {
        return load() as T;
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
