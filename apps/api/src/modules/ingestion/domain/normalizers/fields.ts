import type { AlertCategory, MitreMapping } from '@spine/shared-schema';

/**
 * Small, pure helpers shared by the source-specific normalizers. They never throw: a value
 * that can't be interpreted comes back as `undefined`, and the caller decides whether that
 * field was required.
 */

const MONTHS: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Epoch values below this are read as seconds, above as milliseconds (≈ year 2286 in s). */
const EPOCH_SECONDS_LIMIT = 10_000_000_000;

function fromEpoch(n: number): string | undefined {
  const ms = n < EPOCH_SECONDS_LIMIT ? n * 1000 : n;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** `Oct 28 2026 09:12:44(.123)( UTC)` — the ArcSight/CEF date format. Read as UTC. */
const CEF_DATE =
  /^([A-Za-z]{3}) (\d{1,2}) (\d{4}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(?: (?:UTC|GMT|Z))?$/;

function fromCefDate(value: string): string | undefined {
  const m = CEF_DATE.exec(value);
  if (!m) return undefined;
  const [, mon, day, year, hh, mm, ss, ms] = m;
  const month = MONTHS[(mon ?? '').toLowerCase()];
  if (month === undefined) return undefined;
  const d = new Date(
    Date.UTC(
      Number(year),
      month,
      Number(day),
      Number(hh),
      Number(mm),
      Number(ss),
      Number((ms ?? '0').padEnd(3, '0')),
    ),
  );
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Turns the timestamp shapes found in security tooling into ISO-8601 UTC:
 * ISO with or without a colon in the offset (`+0000`, Suricata's style), epoch seconds or
 * milliseconds (number or digit string), and the CEF `MMM dd yyyy HH:mm:ss` format.
 */
export function toIsoTimestamp(value: unknown): string | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? fromEpoch(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const s = value.trim();
  if (s.length === 0 || s.length > 64) return undefined;
  if (/^\d{9,13}$/.test(s)) return fromEpoch(Number(s));
  const cef = fromCefDate(s);
  if (cef) return cef;
  // ISO-8601: require a date and time and an explicit zone, normalise `+hhmm` → `+hh:mm`.
  const iso = /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})$/i.exec(
    s,
  );
  if (!iso) return undefined;
  const zone = (iso[2] ?? 'Z').toUpperCase();
  const normalizedZone = zone === 'Z' ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(-2)}`;
  const d = new Date(`${(iso[1] ?? '').replace(' ', 'T')}${normalizedZone}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/**
 * Keyword rules mapping free-text classifications (Suricata `alert.category`, rule names, CEF
 * `cat` and `name`) to Spine's category enum. First match wins, so the order goes from the most
 * specific to the most generic. The rules are deliberately simple and listed in one place, so a
 * learner can read *why* an alert got its category (ADR-0031).
 */
const CATEGORY_RULES: readonly (readonly [RegExp, AlertCategory])[] = [
  [/phish/i, 'phishing'],
  [/\b(c2|cnc|c&c|command[ _-]?and[ _-]?control|beacon)/i, 'command_and_control'],
  [
    /(credential|password|brute[ _-]?force|kerberoast|lsass|mimikatz|login fail|failed login)/i,
    'credential_access',
  ],
  [/(lateral|psexec|smb exec|wmi exec|remote service|pass[ _-]the[ _-]hash)/i, 'lateral_movement'],
  [/(exfil|data leak|information leak|large upload|dns tunnel)/i, 'exfiltration'],
  [
    /(malware|trojan|ransom|virus|worm|backdoor|coinminer|crypto ?currency mining|executable code)/i,
    'malware',
  ],
  [/(\bscan|recon|discovery|enumerat|network scan|sweep)/i, 'reconnaissance'],
  [
    /(exploit|attack|privilege gain|intrusion|injection|web application attack|denial of service|shellcode)/i,
    'intrusion',
  ],
  [/(\bcve-|vulnerab)/i, 'vulnerability'],
  [/(policy|privacy violation|unwanted|\bpup\b|inappropriate)/i, 'policy_violation'],
];

/** Classifies the first text that matches a rule; `other` when none do. */
export function classifyCategory(texts: readonly (string | undefined)[]): AlertCategory {
  for (const text of texts) {
    if (!text) continue;
    for (const [pattern, category] of CATEGORY_RULES) {
      if (pattern.test(text)) return category;
    }
  }
  return 'other';
}

const TACTIC_ID = /^TA\d{4}$/;
const TECHNIQUE_ID = /^T\d{4}(\.\d{3})?$/;

/** Turns `Command_And_Control` into `Command And Control` (Suricata metadata style). */
function humanize(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const text = name.replace(/_/g, ' ').trim();
  return text.length > 0 ? text.slice(0, 100) : undefined;
}

/**
 * Zips parallel lists of ATT&CK ids and names (the shape of Suricata/ET rule metadata) into
 * mappings. Invalid technique ids are dropped; an invalid tactic id is omitted.
 */
export function zipMitre(lists: {
  tacticIds?: readonly string[];
  tacticNames?: readonly string[];
  techniqueIds?: readonly string[];
  techniqueNames?: readonly string[];
}): MitreMapping[] {
  const techniqueIds = lists.techniqueIds ?? [];
  const out: MitreMapping[] = [];
  techniqueIds.forEach((rawTechnique, i) => {
    const techniqueId = rawTechnique.trim().toUpperCase();
    if (!TECHNIQUE_ID.test(techniqueId)) return;
    const tacticId = (lists.tacticIds?.[i] ?? lists.tacticIds?.[0])?.trim().toUpperCase();
    const tacticName = humanize(lists.tacticNames?.[i] ?? lists.tacticNames?.[0]);
    const techniqueName = humanize(lists.techniqueNames?.[i]);
    out.push({
      techniqueId,
      ...(tacticId && TACTIC_ID.test(tacticId) ? { tacticId } : {}),
      ...(tacticName ? { tacticName } : {}),
      ...(techniqueName ? { techniqueName: techniqueName.slice(0, 200) } : {}),
    });
  });
  return out.slice(0, 64);
}

/** Returns the value if it is a non-empty string (trimmed, capped), else undefined. */
export function str(value: unknown, max = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  return t.length > 0 ? t.slice(0, max) : undefined;
}

/** Returns a TCP/UDP port number if the value is one (number or digit string). */
export function port(value: unknown): number | undefined {
  const n = typeof value === 'string' && /^\d{1,5}$/.test(value.trim()) ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 65535 ? n : undefined;
}

/** Narrows `unknown` to a plain object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Returns the array of strings at `value` (a lone string becomes a 1-element array). */
export function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Drops keys whose value is `undefined`, so optional schema fields stay truly absent. */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}
