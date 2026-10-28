/**
 * IP address validation and canonical formatting, written by hand so the domain layer stays
 * free of `node:net` (ADR-0002). Canonical forms matter for deduplication: `2001:DB8:0:0::1`
 * and `2001:db8::1` are the same address and must produce the same indicator and fingerprint.
 */

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** True for a dotted-quad IPv4 address without leading zeros (`010.0.0.1` is ambiguous: rejected). */
export function isIpv4(value: string): boolean {
  return IPV4.test(value);
}

function parseHextets(part: string): number[] | null {
  if (part === '') return [];
  const groups = part.split(':');
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** Splits a trailing embedded IPv4 (`::ffff:192.0.2.1`) into two hextets. */
function expandEmbeddedIpv4(value: string): string | null {
  const lastColon = value.lastIndexOf(':');
  const tail = value.slice(lastColon + 1);
  if (!tail.includes('.')) return value;
  if (!isIpv4(tail)) return null;
  const [a, b, c, d] = tail.split('.').map(Number) as [number, number, number, number];
  const hi = ((a << 8) | b).toString(16);
  const lo = ((c << 8) | d).toString(16);
  return `${value.slice(0, lastColon + 1)}${hi}:${lo}`;
}

/** Parses an IPv6 address into its 8 hextets, or null when invalid. Zone ids are rejected. */
export function parseIpv6(input: string): number[] | null {
  if (input.length < 2 || input.length > 45 || input.includes('%')) return null;
  const value = expandEmbeddedIpv4(input);
  if (value === null) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  if (halves.length === 2) {
    const head = parseHextets(halves[0] ?? '');
    const tail = parseHextets(halves[1] ?? '');
    if (!head || !tail || head.length + tail.length > 7) return null;
    return [...head, ...new Array<number>(8 - head.length - tail.length).fill(0), ...tail];
  }
  const all = parseHextets(value);
  return all?.length === 8 ? all : null;
}

/** Formats 8 hextets per RFC 5952: lower-case, no leading zeros, longest zero run (≥ 2) as `::`. */
export function formatIpv6(hextets: readonly number[]): string {
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (hextets[i] !== 0) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < 8 && hextets[j] === 0) j += 1;
    if (j - i > bestLen) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = hextets.map((h) => h.toString(16));
  if (bestLen < 2) return hex.join(':');
  const head = hex.slice(0, bestStart).join(':');
  const tail = hex.slice(bestStart + bestLen).join(':');
  return `${head}::${tail}`;
}

/** Returns the canonical text of an IP address and its family, or null if it isn't one. */
export function canonicalIp(value: string): { family: 'ipv4' | 'ipv6'; value: string } | null {
  const v = value.trim();
  if (isIpv4(v)) return { family: 'ipv4', value: v };
  const unbracketed = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
  const hextets = parseIpv6(unbracketed);
  return hextets ? { family: 'ipv6', value: formatIpv6(hextets) } : null;
}
