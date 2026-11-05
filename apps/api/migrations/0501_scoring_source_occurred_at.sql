-- 0501 scoring: remember when the enrichment snapshot behind a score was produced (ADR-0042).
-- The upsert only replaces a score with one computed from an equal-or-newer snapshot, so an
-- old alert.enriched delivered late (at-least-once, out of order) can't overwrite a newer score.
ALTER TABLE alert_scores
  ADD COLUMN source_occurred_at timestamptz NOT NULL DEFAULT '-infinity';
