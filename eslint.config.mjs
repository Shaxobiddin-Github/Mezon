import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/*.config.*',
      '.dependency-cruiser.cjs',
      '.mezon/**',
    ],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        project: [
          './tsconfig.json',
          './packages/*/tsconfig.json',
          './packages/*/tsconfig.test.json',
          './apps/*/tsconfig.json',
        ],
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
    files: ['**/*.{mjs,cjs,mts,cts,d.mts,d.cts}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['packages/domain/**/*.{ts,tsx}', 'packages/rules/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          object: 'Math',
          property: 'random',
          message: 'Math.random is forbidden in domain/rules. Randomness must be injected.',
        },
        {
          object: 'Date',
          property: 'now',
          message: 'Date.now() is forbidden in domain/rules. Pass time from Clock port.',
        },
      ],
      'no-restricted-globals': [
        'error',
        {
          name: 'crypto',
          message: 'crypto is forbidden in domain/rules. Must be injected via ports.',
        },
        {
          name: 'process',
          message:
            'process is forbidden in domain/rules. Environment variables/process must not be accessed.',
        },
        {
          name: 'Date',
          message: 'Direct Date access is forbidden in domain/rules. Use Clock port.',
        },
        {
          name: 'globalThis',
          message: 'globalThis is forbidden in domain/rules.',
        },
        {
          name: 'global',
          message: 'global is forbidden in domain/rules.',
        },
        {
          name: 'window',
          message: 'window is forbidden in domain/rules.',
        },
        {
          name: 'self',
          message: 'self is forbidden in domain/rules.',
        },
        {
          name: 'performance',
          message: 'performance is forbidden in domain/rules.',
        },
        {
          name: 'fetch',
          message: 'fetch is forbidden in domain/rules.',
        },
        {
          name: 'XMLHttpRequest',
          message: 'XMLHttpRequest is forbidden in domain/rules.',
        },
        {
          name: 'WebSocket',
          message: 'WebSocket is forbidden in domain/rules.',
        },
        {
          name: 'setTimeout',
          message: 'setTimeout is forbidden in domain/rules.',
        },
        {
          name: 'setInterval',
          message: 'setInterval is forbidden in domain/rules.',
        },
        {
          name: 'setImmediate',
          message: 'setImmediate is forbidden in domain/rules.',
        },
        {
          name: 'Number',
          message: 'Number is forbidden in domain/rules. All math must use bigint tiyin/milli.',
        },
        {
          name: 'parseFloat',
          message: 'parseFloat is forbidden in domain/rules. All math must use bigint tiyin/milli.',
        },
        {
          name: 'parseInt',
          message: 'parseInt is forbidden in domain/rules. Use BigInt for parsing integers.',
        },
      ],
      'no-restricted-syntax': [
        'error',
        {
          selector: 'NewExpression[callee.name="Date"]',
          message: 'new Date() is forbidden in domain/rules. Pass time from Clock port.',
        },
        {
          selector: 'MemberExpression[object.name="Date"]',
          message: 'Date methods are forbidden in domain/rules. Pass time from Clock port.',
        },
      ],
    },
  },
);
