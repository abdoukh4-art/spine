-- 0201 alerts: remember which score the projection last applied (ADR-0038).
-- `alert.scored` is delivered at least once and BullMQ retries can reorder deliveries, so the
-- `alerts.project-score` subscriber only applies a score whose computedAt is not older than the
-- one already projected. NULL = never scored.
ALTER TABLE alerts ADD COLUMN scored_at timestamptz;
