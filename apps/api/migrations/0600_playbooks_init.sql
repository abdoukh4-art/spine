-- 0600 playbooks: immutable versioned definitions, event-sourced runs (ADR-0010), approvals,
-- and the effects of simulated response adapters (ADR-0018).
CREATE TABLE playbooks (
  id          text        NOT NULL,
  version     integer     NOT NULL,
  name        text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  definition  jsonb       NOT NULL,
  source      text        NOT NULL,
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, version)
);

CREATE TABLE playbook_runs (
  id                uuid        PRIMARY KEY,
  playbook_id       text        NOT NULL,
  playbook_version  integer     NOT NULL,
  alert_id          uuid        NOT NULL,
  dry_run           boolean     NOT NULL DEFAULT false,
  status            text        NOT NULL,
  current_step_id   text,
  trigger           text        NOT NULL CHECK (trigger IN ('auto', 'manual')),
  started_by        uuid,
  last_seq          integer     NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  approval_wait_ms  bigint      NOT NULL DEFAULT 0,
  FOREIGN KEY (playbook_id, playbook_version) REFERENCES playbooks (id, version)
);
CREATE INDEX playbook_runs_alert_idx ON playbook_runs (alert_id, created_at DESC);
CREATE INDEX playbook_runs_created_idx ON playbook_runs (created_at DESC, id DESC);
CREATE INDEX playbook_runs_active_idx ON playbook_runs (status)
  WHERE status NOT IN ('succeeded', 'failed', 'compensated', 'cancelled');
-- At most one automatic run per (playbook, alert): makes trigger handling idempotent.
CREATE UNIQUE INDEX playbook_runs_auto_once_uq ON playbook_runs (playbook_id, alert_id)
  WHERE trigger = 'auto';

CREATE TABLE playbook_run_events (
  run_id       uuid        NOT NULL REFERENCES playbook_runs (id) ON DELETE CASCADE,
  seq          integer     NOT NULL,
  type         text        NOT NULL,
  step_id      text,
  payload      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq)
);

CREATE TABLE approvals (
  id             uuid        PRIMARY KEY,
  run_id         uuid        NOT NULL REFERENCES playbook_runs (id) ON DELETE CASCADE,
  step_id        text        NOT NULL,
  alert_id       uuid        NOT NULL,
  playbook_id    text        NOT NULL,
  status         text        NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'approved', 'rejected', 'expired')),
  approver_role  text        NOT NULL,
  prompt         text        NOT NULL,
  decided_by     uuid,
  comment        text,
  requested_at   timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  decided_at     timestamptz,
  UNIQUE (run_id, step_id)
);
CREATE INDEX approvals_status_idx ON approvals (status, requested_at DESC);

CREATE TABLE simulated_actions (
  id               uuid        PRIMARY KEY,
  kind             text        NOT NULL,
  idempotency_key  text        NOT NULL UNIQUE,
  run_id           uuid,
  step_id          text,
  request          jsonb       NOT NULL,
  response         jsonb       NOT NULL,
  dry_run          boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX simulated_actions_created_idx ON simulated_actions (created_at DESC, id DESC);
CREATE INDEX simulated_actions_run_idx ON simulated_actions (run_id);
