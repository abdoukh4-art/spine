/**
 * TanStack Query keys in one place, so invalidation after a mutation can't drift from the
 * key a query was cached under. Keys are hierarchical: invalidating `['alerts']` refreshes
 * the list and every detail.
 */
export const queryKeys = {
  alerts: ['alerts'] as const,
  alertList: (filters: unknown) => ['alerts', 'list', filters] as const,
  alert: (id: string) => ['alerts', 'detail', id] as const,
  runs: ['runs'] as const,
  runList: (filters: unknown) => ['runs', 'list', filters] as const,
  run: (id: string) => ['runs', 'detail', id] as const,
  approvals: ['approvals'] as const,
  approvalList: (status: string) => ['approvals', 'list', status] as const,
  playbooks: ['playbooks'] as const,
  playbook: (id: string) => ['playbooks', 'detail', id] as const,
  metrics: (window: string) => ['metrics', window] as const,
  simulatedActions: (kind: string) => ['simulated-actions', kind] as const,
  users: ['users'] as const,
  audit: (filters: unknown) => ['audit-log', filters] as const,
};
