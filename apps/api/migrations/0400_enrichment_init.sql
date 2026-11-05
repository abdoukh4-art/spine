-- 0400 enrichment: one row per (alert, provider, indicator). Upserts make handlers idempotent.
CREATE TABLE alert_enrichments (
  alert_id         uuid        NOT NULL,
  provider         text        NOT NULL,
  indicator_type   text        NOT NULL,
  indicator_value  text        NOT NULL,
  status           text        NOT NULL,
  verdict          text,
  data             jsonb,
  error            text,
  duration_ms      integer     NOT NULL,
  fetched_at       timestamptz NOT NULL,
  PRIMARY KEY (alert_id, provider, indicator_type, indicator_value)
);
