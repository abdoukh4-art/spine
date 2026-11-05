-- 0001 platform: extensions, domain event outbox (ADR-0009).
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;

CREATE TABLE domain_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id       uuid        NOT NULL UNIQUE,
  type           text        NOT NULL,
  version        integer     NOT NULL DEFAULT 1,
  aggregate_id   text        NOT NULL,
  payload        jsonb       NOT NULL,
  traceparent    text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  dispatched_at  timestamptz,
  attempts       integer     NOT NULL DEFAULT 0
);
-- The relay only ever scans undispatched rows; keep that index tiny.
CREATE INDEX domain_events_undispatched_idx ON domain_events (id) WHERE dispatched_at IS NULL;
CREATE INDEX domain_events_dispatched_at_idx ON domain_events (dispatched_at) WHERE dispatched_at IS NOT NULL;
