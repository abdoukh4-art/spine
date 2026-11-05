-- 0300 ingestion: idempotency records for safe client retries (ADR-0012).
CREATE TABLE idempotency_keys (
  scope            text        NOT NULL,
  key              text        NOT NULL,
  request_hash     bytea       NOT NULL,
  response_status  integer     NOT NULL,
  response_body    jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);
