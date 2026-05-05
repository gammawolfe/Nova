/**
 * Boundary rules for the Nova monorepo.
 *
 * Encodes the package-public-API decisions from #39 / #42 / #43 / #44:
 *
 *   - Cross-package imports must go through a package's public entry
 *     (`@nova/<pkg>`), never through `@nova/<pkg>/src/*` or `dist/*`.
 *   - App packages (a2a-server, admin-api, agent-connector, mcp-server,
 *     broker-receiver, operator-mock) may not depend on each other.
 *
 * Run via `npm run lint:boundaries`. Wire into CI as a required check.
 */
const APP_PACKAGES = [
  'a2a-server',
  'admin-api',
  'agent-connector',
  'mcp-server',
  'broker-receiver',
  'operator-mock',
];

const appCrossImportRules = APP_PACKAGES.flatMap((pkg) =>
  APP_PACKAGES.filter((other) => other !== pkg).map((other) => ({
    name: `no-app-${pkg}-imports-app-${other}`,
    severity: 'error',
    comment:
      'App packages must not import each other. Extract shared logic into @nova/shared or another library package.',
    from: { path: `^packages/${pkg}/` },
    to: { path: `^@nova/${other}(/|$)` },
  })),
);

module.exports = {
  forbidden: [
    {
      name: 'no-cross-package-src-imports',
      severity: 'error',
      comment:
        'Cross-package imports must go through the public entry (@nova/<pkg>), not @nova/<pkg>/src/*. Internal source files are not part of the public API.',
      from: { path: '^packages/' },
      to: { path: '^@nova/[^/]+/src/' },
    },
    {
      name: 'no-cross-package-dist-imports',
      severity: 'error',
      comment:
        'Cross-package imports must go through the public entry (@nova/<pkg>), not @nova/<pkg>/dist/*. The dist tree is a build artifact, not a public API.',
      from: { path: '^packages/' },
      to: { path: '^@nova/[^/]+/dist/' },
    },
    ...appCrossImportRules,
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist|test|tests)/' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['types', 'import', 'require', 'node', 'default'],
    },
  },
};
