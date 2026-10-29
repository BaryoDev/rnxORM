import * as rnxorm from '../../src/index';

describe('public translators', () => {
    it('lets a custom provider return a built-in translator from the package entry', () => {
        const translators = [
            new rnxorm.PostgresTranslator(),
            new rnxorm.MsSqlTranslator(),
            new rnxorm.MariaDbTranslator(),
        ];
        for (const t of translators) {
            expect(t).toBeInstanceOf(rnxorm.SqlTranslator);
        }
    });
});
