import type { MitreMapping } from '@spine/shared-schema';

/**
 * What goes into the `mitre_technique_ids` / `mitre_tactic_ids` filter columns (ADR-0037).
 *
 * A sub-technique also indexes its parent: an alert mapped to `T1059.001` (PowerShell) is
 * stored with `{T1059, T1059.001}`. Filtering by `T1059` then finds every Command and
 * Scripting Interpreter alert with a plain GIN `@>` lookup, while `T1059.001` stays precise.
 * The exact mapping is still kept, untouched, in the canonical JSON.
 */
export function techniqueFilterIds(mitre: readonly MitreMapping[]): string[] {
  const ids = new Set<string>();
  for (const m of mitre) {
    ids.add(m.techniqueId);
    const dot = m.techniqueId.indexOf('.');
    if (dot > 0) ids.add(m.techniqueId.slice(0, dot));
  }
  return [...ids].sort();
}

/** Distinct tactic ids, sorted. */
export function tacticFilterIds(mitre: readonly MitreMapping[]): string[] {
  return [...new Set(mitre.flatMap((m) => (m.tacticId ? [m.tacticId] : [])))].sort();
}

/** Escapes `%`, `_` and `\` so user text is matched literally inside an ILIKE pattern. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}
