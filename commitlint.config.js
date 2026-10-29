// Conventional Commits (ADR-0025). Scopes are optional but, when used, should name a module or area.
export default {
  extends: ['@commitlint/config-conventional'],
  // Merge commits aren't Conventional Commits. commitlint already ignores Git's own wording
  // ("Merge pull request …", "Merge branch …"); the seven Phase 1 merges were written by hand as
  // "Merge PR #N: …" and live in shared history, which we don't rewrite (ADR-0025).
  ignores: [(message) => /^Merge PR #\d+: /.test(message)],
  rules: {
    'scope-enum': [
      1,
      'always',
      [
        'api',
        'console',
        'shared-schema',
        'playbook-engine',
        'enrichers',
        'ingestion',
        'enrichment',
        'scoring',
        'playbooks',
        'alerts',
        'cases',
        'auth',
        'audit',
        'metrics',
        'platform',
        'infra',
        'observability',
        'ci',
        'docs',
        'deps',
        'security',
        'e2e',
        'demo',
        'release',
      ],
    ],
    'body-max-line-length': [0],
  },
};
