/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'domain-imports-nothing',
      comment:
        'packages/domain must not import anything (no node builtins, no npm packages, no other workspace packages)',
      severity: 'error',
      from: {
        path: '^packages/domain',
      },
      to: {
        pathNot: '^packages/domain',
      },
    },
    {
      name: 'rules-imports-only-domain',
      comment: 'packages/rules can only import from packages/domain or within packages/rules',
      severity: 'error',
      from: {
        path: '^packages/rules',
      },
      to: {
        pathNot: '^(packages/rules|packages/domain)',
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
        path: '^apps/',
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
        path: '^apps/',
        pathNot: '^apps/$1',
      },
    },
  ],
  options: {
    doNotFollow: {
      path: ['node_modules', 'dist'],
    },
    exclude: {
      path: ['(^|/)dist/'],
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
