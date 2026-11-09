import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '*.config.*',
      '.dependency-cruiser.cjs',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['packages/domain/**/*.{ts,tsx}', 'packages/rules/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'crypto',
          message: 'Forbidden in domain/rules. Must be injected via ports.',
        },
        {
          name: 'process',
          message: 'Forbidden in domain/rules. Environment variables/process must not be accessed.',
        },
        {
          name: 'Date',
          message: 'Direct Date access forbidden in domain/rules. Use Clock port.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'MemberExpression[object.name="Date"][property.name="now"]',
          message: 'Date.now() is forbidden in domain/rules. Pass time from Clock port.',
        },
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: 'new Date() is forbidden in domain/rules. Pass time from Clock port.',
        },
        {
          selector: 'MemberExpression[object.name="Math"][property.name="random"]',
          message:
            'Math.random() is forbidden in domain/rules. Randomness must be deterministic and injected.',
        },
      ],
    },
  },
);
