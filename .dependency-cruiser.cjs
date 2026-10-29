/**
 * Executable architecture rules (ADR-0002, ADR-0020).
 * Every rule's `comment` is printed on violation — it explains *why* the rule exists.
 * @type {import('dependency-cruiser').IConfiguration}
 */
const FRAMEWORK_PACKAGES =
  '^(fastify|@fastify|kysely|pg|bullmq|ioredis|@opentelemetry|pino|jose|@node-rs)(/|$)';

module.exports = {
  forbidden: [
    {
      name: 'domain-is-pure',
      severity: 'error',
      comment:
        'Domain code must not depend on frameworks or I/O libraries. Put I/O behind a port ' +
        'in application/ and implement it in adapters/ (ADR-0002, hexagonal architecture).',
      from: { path: ['^apps/api/src/modules/[^/]+/domain/', '^packages/playbook-engine/src/'] },
      to: {
        dependencyTypes: ['npm', 'npm-dev', 'npm-peer', 'npm-optional', 'core'],
        path: [
          FRAMEWORK_PACKAGES,
          '^(fs|net|http|https|child_process|node:fs|node:net|node:http|node:https|node:child_process)$',
        ],
      },
    },
    {
      name: 'domain-no-outward',
      severity: 'error',
      comment:
        'domain/ is the innermost ring: it may not import application/ or adapters/ (dependency rule).',
      from: { path: '^apps/api/src/modules/([^/]+)/domain/' },
      to: { path: '^apps/api/src/modules/[^/]+/(application|adapters)/' },
    },
    {
      name: 'application-no-adapters',
      severity: 'error',
      comment:
        'Use cases depend on port interfaces, never on concrete adapters. Wire adapters in the module index.ts.',
      from: { path: '^apps/api/src/modules/([^/]+)/application/' },
      to: { path: '^apps/api/src/modules/[^/]+/adapters/' },
    },
    {
      name: 'module-public-api-only',
      severity: 'error',
      comment:
        'A module may use another module only through its public-api.ts. Reaching into its ' +
        'internals couples you to implementation details (ADR-0002).',
      from: { path: '^apps/api/src/modules/([^/]+)/' },
      to: {
        path: '^apps/api/src/modules/([^/]+)/',
        pathNot: ['^apps/api/src/modules/$1/', '^apps/api/src/modules/[^/]+/public-api\\.ts$'],
      },
    },
    {
      name: 'platform-no-modules',
      severity: 'error',
      comment: 'platform/ is the shared kernel and must not know about business modules.',
      from: { path: '^apps/api/src/platform/' },
      to: { path: '^apps/api/src/modules/' },
    },
    {
      name: 'packages-no-apps',
      severity: 'error',
      comment: 'Reusable packages must not depend on applications.',
      from: { path: '^packages/' },
      to: { path: '^apps/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular dependencies make modules impossible to reason about or extract.',
      from: {},
      to: { circular: true, dependencyTypesNot: ['type-only'] },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: ['\\.test\\.ts$', '/test/', '/dist/'] },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.depcruise.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'types', 'default'],
    },
    reporterOptions: { dot: { collapsePattern: 'node_modules/[^/]+' } },
  },
};
