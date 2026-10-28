import { summarizeEnrichment, type RunSnapshot } from '@spine/playbook-engine';
import { evaluateCondition, type PlaybookDefinition } from '@spine/shared-schema';

/**
 * Trigger matching (ADR-0013): a playbook with `trigger.event: alert.scored` runs
 * automatically for every scored alert whose snapshot satisfies `trigger.when`.
 *
 * The context is the same shape as a run's evaluation context (`alert`, `score`,
 * `enrichment`), so authors write trigger and branch conditions the same way, e.g.
 * `{ field: score.score, op: gte, value: 60 }`.
 */
export function triggerContext(snapshot: RunSnapshot): Record<string, unknown> {
  return {
    alert: snapshot.alert,
    score: snapshot.score,
    enrichment: summarizeEnrichment(snapshot.enrichments),
  };
}

/** True if the playbook should start automatically for this scored alert. */
export function matchesTrigger(definition: PlaybookDefinition, snapshot: RunSnapshot): boolean {
  const trigger = definition.trigger;
  if (trigger?.event !== 'alert.scored') return false;
  if (!trigger.when) return true;
  try {
    return evaluateCondition(trigger.when, triggerContext(snapshot));
  } catch {
    // Validated at load time; a condition that still throws simply does not match.
    return false;
  }
}
