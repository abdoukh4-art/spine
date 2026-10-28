-- 0500 scoring: explainable scores, one per (alert, ruleset version) (ADR-0015).
CREATE TABLE alert_scores (
  alert_id         uuid        NOT NULL,
  ruleset_version  integer     NOT NULL,
  score            integer     NOT NULL CHECK (score BETWEEN 0 AND 100),
  severity         text        NOT NULL,
  explanation      jsonb       NOT NULL,
  computed_at      timestamptz NOT NULL,
  PRIMARY KEY (alert_id, ruleset_version)
);
CREATE INDEX alert_scores_alert_idx ON alert_scores (alert_id, computed_at DESC);
