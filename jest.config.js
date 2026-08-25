module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/.claude/'],
    modulePathIgnorePatterns: ['<rootDir>/.claude/'],
    collectCoverage: true,
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
};
