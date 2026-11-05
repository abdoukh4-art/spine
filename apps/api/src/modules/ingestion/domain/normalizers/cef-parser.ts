import { err, normalizationError, ok, type NormalizationError, type Result } from '../result.js';

/**
 * A pure parser for ArcSight Common Event Format (CEF) lines, separate from the mapping to
 * canonical fields so each can be tested on its own (ADR-0031).
 *
 * Grammar (CEF Implementation Standard, rev. 25):
 *
 *     [syslog prefix] CEF:Version|Device Vendor|Device Product|Device Version|Signature ID|Name|Severity|Extension
 *
 * Escaping is *different* in the two parts, which is the classic source of CEF bugs:
 * - header fields: `\|` is a literal pipe and `\\` a literal backslash;
 * - extension values: `\=` is a literal equals sign, `\\` a backslash, `\n`/`\r` are line
 *   breaks. Pipes need no escaping there. Values may contain spaces: a value runs until the
 *   whitespace that precedes the next `key=`.
 */
export interface CefRecord {
  version: number;
  deviceVendor: string;
  deviceProduct: string;
  deviceVersion: string;
  signatureId: string;
  name: string;
  severity: string;
  extensions: Record<string, string>;
  /** Whatever preceded `CEF:` on the line (e.g. a syslog header), trimmed. */
  prefix: string;
}

const HEADER_FIELDS = 7;

/** Splits the header on unescaped pipes; returns the 7 header fields and the raw extension. */
function splitHeader(body: string): { fields: string[]; extension: string } | null {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body.charAt(i);
    if (ch === '\\' && (body[i + 1] === '|' || body[i + 1] === '\\')) {
      current += body.charAt(i + 1);
      i += 1;
    } else if (ch === '|') {
      fields.push(current);
      current = '';
      if (fields.length === HEADER_FIELDS) return { fields, extension: body.slice(i + 1) };
    } else {
      current += ch;
    }
  }
  // A line with exactly 7 fields and no trailing pipe has no extension at all.
  if (fields.length === HEADER_FIELDS - 1) return { fields: [...fields, current], extension: '' };
  return null;
}

const KEY_CHAR = /[A-Za-z0-9_.[\]-]/;

/** True if the `=` at `index` is escaped (preceded by an odd number of backslashes). */
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/** Finds `key=` positions: an unescaped `=` preceded by key characters, at start or after whitespace. */
function findKeys(ext: string): { key: string; start: number; eq: number }[] {
  const keys: { key: string; start: number; eq: number }[] = [];
  for (let i = 0; i < ext.length; i += 1) {
    if (ext[i] !== '=' || isEscaped(ext, i)) continue;
    let start = i;
    while (start > 0 && KEY_CHAR.test(ext[start - 1] ?? '')) start -= 1;
    const atBoundary = start === 0 || /\s/.test(ext[start - 1] ?? '');
    if (start < i && atBoundary) keys.push({ key: ext.slice(start, i), start, eq: i });
  }
  return keys;
}

/** Unescapes an extension value. Unknown escapes are kept verbatim (lenient, like most SIEMs). */
export function unescapeExtensionValue(value: string): string {
  return value.replace(/\\([\\=nr|])/g, (_m, c: string) =>
    c === 'n' ? '\n' : c === 'r' ? '\r' : c,
  );
}

/** Parses the extension part into a key → value map. Later duplicates win. */
export function parseExtensions(ext: string): Record<string, string> {
  const keys = findKeys(ext);
  const out: Record<string, string> = {};
  keys.forEach((k, idx) => {
    const end = keys[idx + 1]?.start ?? ext.length;
    out[k.key] = unescapeExtensionValue(ext.slice(k.eq + 1, end).trim());
  });
  return out;
}

/** Parses one CEF line (an optional syslog prefix before `CEF:` is tolerated). */
export function parseCef(line: string): Result<CefRecord, NormalizationError> {
  const text = line.replace(/[\r\n]+$/, '');
  const at = text.indexOf('CEF:');
  if (at < 0) return err(normalizationError('parse_error', "line does not contain 'CEF:'"));
  const header = splitHeader(text.slice(at + 4));
  if (!header) {
    return err(normalizationError('parse_error', 'CEF header must have 7 pipe-separated fields'));
  }
  const [version, vendor, product, deviceVersion, signatureId, name, severity] = header.fields as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];
  if (!/^\d+$/.test(version.trim())) {
    return err(normalizationError('parse_error', 'CEF version must be a number'));
  }
  return ok({
    version: Number(version.trim()),
    deviceVendor: vendor.trim(),
    deviceProduct: product.trim(),
    deviceVersion: deviceVersion.trim(),
    signatureId: signatureId.trim(),
    name: name.trim(),
    severity: severity.trim(),
    extensions: parseExtensions(header.extension),
    prefix: text.slice(0, at).trim(),
  });
}
