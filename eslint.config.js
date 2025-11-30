const js = require("@eslint/js");
const tseslintParser = require("@typescript-eslint/parser");
const tseslintPlugin = require("@typescript-eslint/eslint-plugin");

const globals = require("globals");

module.exports = [
    js.configs.recommended,
    {
        files: ["src/**/*.ts", "test/**/*.ts"],
        languageOptions: {
            parser: tseslintParser,
            globals: {
                ...globals.node,
                ...globals.jest,
            },
            parserOptions: {
                ecmaVersion: 2020,
                sourceType: "module",
            },
        },
        plugins: {
            "@typescript-eslint": tseslintPlugin,
        },
        rules: {
            ...tseslintPlugin.configs.recommended.rules,
            "@typescript-eslint/explicit-module-boundary-types": "off",
            "@typescript-eslint/no-explicit-any": "warn",
            "@typescript-eslint/no-unused-vars": ["warn", { "argsIgnorePattern": "^_" }]
        }
    },
    {
        ignores: ["dist/", "node_modules/", "coverage/"]
    }
];
