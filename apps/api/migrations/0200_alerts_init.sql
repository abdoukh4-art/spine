-- 0200 alerts/cases: the alert record and case grouping (ADR-0011, ADR-0012).
CREATE TABLE cases (
  id           uuid        PRIMARY KEY,
  title        text        NOT NULL,
  description  text,
  status       text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cases_status_idx ON cases (status, created_at DESC);

CREATE TABLE alerts (
  id                   uuid        PRIMARY KEY,
  fingerprint          text        NOT NULL,
  status               text        NOT NULL DEFAULT 'new'
                         CHECK (status IN ('new', 'triaged', 'in_progress', 'resolved', 'false_positive')),
  title                text        NOT NULL,
  category             text        NOT NULL,
  source_vendor        text        NOT NULL,
  source_product       text        NOT NULL,
  source_severity      text        NOT NULL,
  score                integer     CHECK (score BETWEEN 0 AND 100),
  severity             text,
  occurred_at          timestamptz NOT NULL,
  received_at          timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL,
  resolved_at          timestamptz,
  duplicate_count      integer     NOT NULL DEFAULT 0,
  assignee_id          uuid,
  case_id              uuid        REFERENCES cases (id) ON DELETE SET NULL,
  canonical            jsonb       NOT NULL,
  mitre_technique_ids  text[]      NOT NULL DEFAULT '{}',
  mitre_tactic_ids     text[]      NOT NULL DEFAULT '{}',
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- Race-safe dedup: at most one OPEN alert per fingerprint (ADR-0012).
CREATE UNIQUE INDEX alerts_open_fingerprint_uq ON alerts (fingerprint)
  WHERE status NOT IN ('resolved', 'false_positive');
CREATE INDEX alerts_fingerprint_idx ON alerts (fingerprint);
CREATE INDEX alerts_received_idx ON alerts (received_at DESC, id DESC);
CREATE INDEX alerts_score_idx ON alerts (score DESC NULLS LAST, id DESC);
CREATE INDEX alerts_open_status_idx ON alerts (status, received_at DESC)
  WHERE status IN ('new', 'triaged', 'in_progress');
CREATE INDEX alerts_severity_idx ON alerts (severity);
CREATE INDEX alerts_case_idx ON alerts (case_id) WHERE case_id IS NOT NULL;
CREATE INDEX alerts_title_trgm_idx ON alerts USING gin (title gin_trgm_ops);
CREATE INDEX alerts_mitre_technique_idx ON alerts USING gin (mitre_technique_ids);
