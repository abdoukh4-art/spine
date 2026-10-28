-- 0401 enrichment: idempotent receiver ("inbox") for alert.ingested deliveries (ADR-0040).
-- The handler inserts the delivered event's id in the same transaction that upserts
-- alert_enrichments and publishes alert.enriched. A redelivery hits the primary key,
-- so it neither writes nor publishes twice.
CREATE TABLE enrichment_processed_events (
  event_id      uuid        PRIMARY KEY,
  alert_id      uuid        NOT NULL,
  processed_at  timestamptz NOT NULL
);
CREATE INDEX enrichment_processed_events_alert_idx ON enrichment_processed_events (alert_id);
