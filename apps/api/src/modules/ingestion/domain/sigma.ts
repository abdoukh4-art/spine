import type { CanonicalAlert, MitreMapping, SigmaRule } from '@spine/shared-schema';

/**
 * Sigma rule catalog enrichment at ingestion (ADR-0098). Pure.
 *
 * A sensor that raised an alert from a Sigma rule puts the rule's id in the label
 * `sigma_rule_id`. If the catalog knows the rule, Spine merges the rule's ATT&CK tags into the
 * alert's mapping and adds the rule's metadata as `sigma_*` labels (title, level, status, false
 * positives, references), where the console, scoring rules and the AI analyst can see them.
 *
 * **Anti-spoofing:** every incoming `sigma_*` label except `sigma_rule_id` is removed first. Only
 * the catalog writes them, so a sender can't label its own alert `sigma_level: informational`.
 */

/** The label a sender uses to say which Sigma rule raised the alert. */
export const SIGMA_RULE_ID_LABEL = 'sigma_rule_id';

/** The Sigma rules Spine knows, by id. */
export type SigmaCatalog = ReadonlyMap<string, SigmaRule>;

/**
 * Sigma's `attack.<tactic>` tags → ATT&CK tactic ids. The 12 from the Sigma tags appendix, plus
 * Reconnaissance and Resource Development, which ATT&CK added later and SigmaHQ rules use.
 */
export const SIGMA_TACTICS: Readonly<Record<string, { id: string; name: string }>> = {
  reconnaissance: { id: 'TA0043', name: 'Reconnaissance' },
  'resource-development': { id: 'TA0042', name: 'Resource Development' },
  'initial-access': { id: 'TA0001', name: 'Initial Access' },
  execution: { id: 'TA0002', name: 'Execution' },
  persistence: { id: 'TA0003', name: 'Persistence' },
  'privilege-escalation': { id: 'TA0004', name: 'Privilege Escalation' },
  'defense-evasion': { id: 'TA0005', name: 'Defense Evasion' },
  'credential-access': { id: 'TA0006', name: 'Credential Access' },
  discovery: { id: 'TA0007', name: 'Discovery' },
  'lateral-movement': { id: 'TA0008', name: 'Lateral Movement' },
  collection: { id: 'TA0009', name: 'Collection' },
  exfiltration: { id: 'TA0010', name: 'Exfiltration' },
  'command-and-control': { id: 'TA0011', name: 'Command and Control' },
  impact: { id: 'TA0040', name: 'Impact' },
};

const TECHNIQUE_TAG = /^attack\.t(\d{4})(?:\.(\d{3}))?$/;
const MAX_MITRE = 64; // CanonicalAlertInputSchema's limit
const LABEL_MAX = 1024;

/**
 * ATT&CK mappings from Sigma tags. A technique gets a tactic only when the rule names exactly one
 * tactic: with several, which tactic a technique belongs to is ambiguous, so none is guessed.
 */
export function attackFromSigmaTags(tags: readonly string[]): MitreMapping[] {
  const tactics = tags.flatMap((t) => {
    const tactic = t.startsWith('attack.') ? SIGMA_TACTICS[t.slice('attack.'.length)] : undefined;
    return tactic ? [tactic] : [];
  });
  const only = tactics.length === 1 ? tactics[0] : undefined;
  const seen = new Set<string>();
  const mappings: MitreMapping[] = [];
  for (const tag of tags) {
    const m = TECHNIQUE_TAG.exec(tag);
    if (!m) continue;
    const techniqueId = `T${m[1]}${m[2] ? `.${m[2]}` : ''}`;
    if (seen.has(techniqueId)) continue;
    seen.add(techniqueId);
    mappings.push(
      only ? { techniqueId, tacticId: only.id, tacticName: only.name } : { techniqueId },
    );
  }
  return mappings;
}

/** Applies the catalog to one alert; see the module comment. Returns a new alert. */
export function applySigmaRule(alert: CanonicalAlert, catalog: SigmaCatalog): CanonicalAlert {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(alert.labels)) {
    if (!key.startsWith('sigma_') || key === SIGMA_RULE_ID_LABEL) labels[key] = value;
  }
  const ruleId = labels[SIGMA_RULE_ID_LABEL];
  const rule = ruleId === undefined ? undefined : catalog.get(ruleId.toLowerCase());
  if (!rule) return { ...alert, labels };

  const known = new Set(alert.mitre.map((m) => m.techniqueId));
  const added = attackFromSigmaTags(rule.tags ?? []).filter((m) => !known.has(m.techniqueId));
  const mitre = [...alert.mitre, ...added].slice(0, MAX_MITRE);

  labels.sigma_title = clip(rule.title);
  if (rule.level) labels.sigma_level = rule.level;
  if (rule.status) labels.sigma_status = rule.status;
  if (rule.falsepositives?.length)
    labels.sigma_falsepositives = clip(rule.falsepositives.join('; '));
  if (rule.references?.length)
    labels.sigma_references = clip(rule.references.slice(0, 5).join(' '));
  return { ...alert, mitre, labels };
}

function clip(s: string): string {
  return s.length <= LABEL_MAX ? s : `${s.slice(0, LABEL_MAX - 1)}…`;
}
