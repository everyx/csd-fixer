import gnome from 'eslint-config-gnome';

export default [
    {
        ignores: [
            'node_modules/**',
            'schemas/**',
            'research/**',
            'vendor/**',
            'src/lib/*.generated.js',
            'src/effects/*.generated.js',
        ],
    },
    ...gnome.configs.recommended,
    {
        files: ['**/*.js'],
        languageOptions: {
            sourceType: 'module',
            globals: {
                global: 'readonly',
            },
        },
    },
];
