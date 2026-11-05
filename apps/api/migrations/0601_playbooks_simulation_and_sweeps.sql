-- 0601 playbooks: support objects for the simulated adapters (ADR-0018) and the background
-- sweeps of the playbook worker (ADR-0051).

-- Simulated ticketing hands out human-friendly SIM-<n> ticket numbers, like a real tracker.
CREATE SEQUENCE simulated_ticket_seq START 1000;

-- GET /simulated-actions?kind=… lists one kind newest-first.
CREATE INDEX simulated_actions_kind_idx ON simulated_actions (kind, created_at DESC, id DESC);

-- The approval-expiry sweeper scans only pending approvals, by deadline.
CREATE INDEX approvals_pending_expiry_idx ON approvals (expires_at) WHERE status = 'pending';

-- GET /approvals keyset pagination (requested_at DESC, id DESC), optionally by status.
CREATE INDEX approvals_requested_idx ON approvals (requested_at DESC, id DESC);
