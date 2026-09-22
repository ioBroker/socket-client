import config from '@iobroker/eslint-config';

export default [
    ...config,
    {
        languageOptions: {
            parserOptions: {
                projectService: {
                    allowDefaultProject: ['*.js', '*.mjs'],
                },
                tsconfigRootDir: import.meta.dirname,
            },
        },
    },
    {
        ignores: ['node_modules/', 'build/', 'build-test/'],
    },
    {
        files: ['test/**/*.ts'],
        rules: {
            // describe() and it() of node:test return promises, which the test runner handles
            '@typescript-eslint/no-floating-promises': [
                'warn',
                {
                    allowForKnownSafeCalls: [
                        { from: 'package', package: 'node:test', name: ['describe', 'it', 'test', 'suite'] },
                    ],
                },
            ],
        },
    },
    {
        // disable temporary the rule 'jsdoc/require-param' and enable 'jsdoc/require-jsdoc'
        rules: {
            'jsdoc/require-jsdoc': 'off',
            'jsdoc/require-param': 'off',
        },
    },
];
