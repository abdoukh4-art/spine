# ADR-0098: A Sigma rule catalog enriches alerts from Sigma-based detections (Spine never evaluates Sigma)

- **Status:** accepted
- **Date:** 2026-11-05
- **Deciders:** maintainers
- **Tags:** interoperability, ingestion, detection-engineering

## Context and problem statement

[Sigma](https://github.com/SigmaHQ/sigma-specification) is the open format for detection rules:
detection engineers write a rule once, and tools convert it to Splunk, Elastic, Sentinel and other
queries. Many alerts that reach a SOAR were raised by a Sigma rule, and the rule knows things the
alert usually doesn't carry: its ATT&CK mapping, how severe its author judged it, how mature it is,
and its known **false positives**, which is exactly what an analyst (or an AI analyst) needs at
triage time.

"Support Sigma" could mean two very different things. Which one belongs in Spine?

## Decision drivers

- Stay a SOAR: the vision's first non-goal is "Not a SIEM" ([vision](../00-vision.md) §5).
- Use the specification as published, and validate rules strictly at startup (like the scoring
  ruleset, ADR-0046).
- Don't let a sender forge detection metadata.

## Considered options

1. **A rule catalog**: load Sigma rules from `config/sigma/`, and enrich alerts that name a rule
   (`sigma_rule_id` label) with its ATT&CK tags and metadata. Never evaluate `detection`.
2. **A Sigma engine**: evaluate `detection` against incoming raw events to create alerts.
3. Convert Sigma rules into Spine scoring rules.

## Decision outcome

**Option 1.** Reference: the SigmaHQ specification repository at commit
`ba9251aa834b11a70dbf80836b453dba99c5159e` (rules specification **2.1.0**; note its JSON schema
file is still titled 2.0.0). The specification is public domain; its own example rules are test
fixtures here.

- **Loading** (`adapters/sigma-loader.ts`): every `*.yml`/`*.yaml` file in `CONFIG_DIR/sigma`.
  Each must validate against `SigmaRuleSchema` (title, **id required** (the spec only recommends it,
  but the catalog is keyed by it), logsource, detection present, level/status enums, tag pattern).
  Correlation rules and filters are skipped and logged. Invalid rules, duplicate ids or YAML aliases
  **fail startup** with every problem listed.
- **Linking**: a sender sets the label `sigma_rule_id` (Sigma-based tools carry the rule id).
  Underscore, not dot, so scoring predicates can read `alert.labels.sigma_level`.
- **Enrichment** (`domain/sigma.ts`, pure, before fingerprinting): ATT&CK techniques from `attack.tNNNN[.NNN]`
  tags are merged (deduplicated, capped at 64). A technique gets a tactic only when the rule names
  exactly **one** tactic; with several, the pairing is ambiguous and isn't guessed. Metadata becomes
  labels: `sigma_title`, `sigma_level`, `sigma_status`, `sigma_falsepositives`, `sigma_references`.
- **Anti-spoofing**: all incoming `sigma_*` labels except `sigma_rule_id` are removed first. Only the
  catalog writes them, so an attacker's sensor can't label its alert `sigma_level: informational`.
- Tactic tags: the 12 in the specification's tag appendix, plus `reconnaissance` (TA0043) and
  `resource-development` (TA0042), which ATT&CK added later and SigmaHQ rules use.

Option 2 makes Spine a SIEM: event storage, field taxonomies, the full modifier and condition
grammar, correlation. That's a different product, with mature tools already doing it. Option 3 loses
the rule's identity and its analyst guidance.

### Consequences

- 👍 Alerts from Sigma detections arrive with ATT&CK, the rule's severity and its known false
  positives, visible in the console and to the AI analyst (as labels, fenced like all alert text).
- 👍 Scoring rules can use them, e.g. `alert.labels.sigma_status eq experimental` → fewer points.
- 👎 Only alerts whose sender includes the rule id are enriched; title matching was rejected
  (titles aren't unique).
- 👎 The catalog loads at startup; adding rules means a restart (as for the scoring ruleset).
- ⚖️ Sigma metadata is stored as labels (strings): simple and visible everywhere, but long lists are
  joined and clipped at 1024 characters.

## What would make us revisit this

- Thousands of rules or frequent updates → a catalog table with an admin API and reload.
- Senders that only know the rule title → an explicit, unique title index with collision errors.
- Sigma 3.x changes the rule format → re-check `SigmaRuleSchema` against the new spec.

## Further reading

- Sigma rules specification 2.1.0 and its tags appendix (SigmaHQ/sigma-specification)
- pySigma documentation (rule conversion), for what an engine would involve
