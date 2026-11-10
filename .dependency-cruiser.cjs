/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-src-imports-nothing',
      comment:
        'packages/domain source files must not import anything (no node builtins, no npm packages, no other workspace packages)',
      severity: 'error',
      from: {
        path: '^packages/domain/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^packages/domain/src/',
      },
    },
    {
      name: 'domain-tests-imports-only-testing',
      comment:
        'packages/domain test files can only import internal source files, vitest, and fast-check',
      severity: 'error',
      from: {
        path: '^packages/domain/src/.*\\.test\\.ts$',
      },
      to: {
        pathNot: '^(packages/domain/src/|node_modules/(\\.pnpm/)?(fast-check|vitest)@)',
      },
    },
    {
      name: 'rules-src-imports-only-domain',
      comment:
        'packages/rules source files can only import within packages/rules/src or from packages/domain',
      severity: 'error',
      from: {
        path: '^packages/rules/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^(packages/rules/src/|packages/domain/)',
      },
    },
    {
      name: 'rules-tests-imports-only-testing-and-domain',
      comment:
        'packages/rules test files can only import internal source files, packages/domain, packages/test-utils, vitest, and fast-check',
      severity: 'error',
      from: {
        path: '^packages/rules/src/.*\\.test\\.ts$',
      },
      to: {
        pathNot:
          '^(packages/rules/src/|packages/domain/|packages/test-utils/|node_modules/(\\.pnpm/)?(fast-check|vitest)@)',
      },
    },
    {
      name: 'drivers-src-imports',
      comment:
        'packages/drivers source files can only import within packages/drivers/src or from packages/domain',
      severity: 'error',
      from: {
        path: '^packages/drivers/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^(packages/drivers/src/|packages/domain/)',
      },
    },
    {
      name: 'test-utils-src-imports',
      comment:
        'packages/test-utils source files can only import within packages/test-utils/src or from packages/domain',
      severity: 'error',
      from: {
        path: '^packages/test-utils/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^(packages/test-utils/src/|packages/domain/)',
      },
    },
    {
      name: 'no-test-utils-in-production',
      comment: 'Production source files outside packages/test-utils must not import test-utils',
      severity: 'error',
      from: {
        path: '^(apps|packages)/.*/src/',
        pathNot: '(^packages/test-utils/|\\.test\\.ts$)',
      },
      to: {
        path: '^packages/test-utils/',
      },
    },
    {
      name: 'no-drivers-in-pure-packages',
      comment: 'Pure/shared packages must not depend on concrete IO adapters in packages/drivers',
      severity: 'error',
      from: {
        path: '^packages/(domain|rules|contracts|sync|db-local|db-cloud|ui|i18n)/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        path: '^packages/drivers/',
      },
    },
    {
      name: 'packages-cannot-import-apps',
      comment: 'No package in packages/* can import from apps/*',
      severity: 'error',
      from: {
        path: '^packages/',
      },
      to: {
        path: '^(apps/|@mezon/(desktop|hub|pos|android|cloud|admin|bot))',
      },
    },
    {
      name: 'apps-cannot-import-apps',
      comment: 'Apps cannot import other apps',
      severity: 'error',
      from: {
        path: '^apps/([^/]+)',
      },
      to: {
        path: '^(apps/|@mezon/(desktop|hub|pos|android|cloud|admin|bot))',
        pathNot: '^apps/$1',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: 'node_modules',
    },
    tsPreCompilationDeps: true,
    tsConfig: {
      fileName: './tsconfig.base.json',
    },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
    reporterOptions: {
      text: {
        highlightFocused: true,
      },
    },
  },
};
