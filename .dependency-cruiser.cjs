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
        'Pure packages/drivers source files outside src/node/ can only import non-node drivers or packages/domain',
      severity: 'error',
      from: {
        path: '^packages/drivers/src/(?!node/)',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^(packages/drivers/src/(?!node/)|packages/domain/)',
      },
    },
    {
      name: 'drivers-node-src-imports',
      comment:
        'packages/drivers/src/node source files can only import within packages/drivers/src, packages/domain, node:fs, and node:path',
      severity: 'error',
      from: {
        path: '^packages/drivers/src/node/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^(packages/drivers/src/|packages/domain/|(node:)?(fs|path)$)',
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
      name: 'db-local-src-imports',
      comment:
        'packages/db-local source files can only import internal files, packages/domain, drizzle-orm, better-sqlite3, node:async_hooks, node:crypto, node:fs, and node:path',
      severity: 'error',
      from: {
        path: '^packages/db-local/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot:
          '^(packages/db-local/src/|packages/domain/|node_modules/(\\.pnpm/)?(drizzle-orm|better-sqlite3)@|(node:)?(async_hooks|crypto|fs|path)$)',
      },
    },
    {
      name: 'db-cloud-src-imports',
      comment:
        'packages/db-cloud source files can only import internal files, packages/domain, drizzle-orm, pg, and node:fs/node:path (no db-local, drivers, test-utils, or testcontainers)',
      severity: 'error',
      from: {
        path: '^packages/db-cloud/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot:
          '^(packages/db-cloud/src/|packages/domain/|node_modules/(\\.pnpm/)?(drizzle-orm|pg)@|(node:)?(fs|path)$)',
      },
    },
    {
      name: 'contracts-src-imports',
      comment:
        'packages/contracts source files can only import internal files, packages/domain, and zod',
      severity: 'error',
      from: {
        path: '^packages/contracts/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^(packages/contracts/src/|packages/domain/|node_modules/(\\.pnpm/)?zod@)',
      },
    },
    {
      name: 'hub-src-imports',
      comment:
        'apps/hub source files can only import internal files, domain, contracts, db-local, drivers, fastify, pino, @node-rs/argon2, zod, and node builtins (never db-cloud)',
      severity: 'error',
      from: {
        path: '^apps/hub/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot:
          '^(apps/hub/src/|packages/(domain|contracts|db-local|drivers)/|node_modules/(\\.pnpm/)?(fastify|pino|@node-rs/argon2|@node-rs\\+argon2|zod)@|(node:)?(crypto|fs|path|stream)$)',
      },
    },
    {
      name: 'desktop-src-imports',
      comment:
        'apps/desktop source files can only import internal files, domain, contracts, drivers, electron, pino, koffi, and safe node builtins (never db-local, db-cloud, hub, or pos)',
      severity: 'error',
      from: {
        path: '^apps/desktop/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot:
          '^(apps/desktop/src/|packages/(domain|contracts|drivers)/|electron$|node_modules/(\\.pnpm/)?(electron|pino|koffi)@|(node:)?(events|fs|fs/promises|os|path)$)',
      },
    },
    {
      name: 'pos-src-imports',
      comment:
        'apps/pos browser UI source files can only import internal files, domain, contracts, i18n, ui, react, react-dom, zod, and zustand (no node builtins, electron, db-local, db-cloud, drivers, or hub)',
      severity: 'error',
      from: {
        path: '^apps/pos/src/',
        pathNot: '\\.test\\.(ts|tsx)$',
      },
      to: {
        pathNot:
          '^(apps/pos/src/|packages/(domain|contracts|i18n|ui)/|node_modules/(\\.pnpm/)?(react|react-dom|zod|zustand)@)',
      },
    },
    {
      name: 'ui-src-imports',
      comment: 'packages/ui source files can only import internal files and packages/domain',
      severity: 'error',
      from: {
        path: '^packages/ui/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^(packages/ui/src/|packages/domain/)',
      },
    },
    {
      name: 'i18n-src-imports',
      comment: 'packages/i18n source files can only import internal files',
      severity: 'error',
      from: {
        path: '^packages/i18n/src/',
        pathNot: '\\.test\\.ts$',
      },
      to: {
        pathNot: '^packages/i18n/src/',
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
