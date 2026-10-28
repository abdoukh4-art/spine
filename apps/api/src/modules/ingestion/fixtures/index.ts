import { readFileSync } from 'node:fs';

/**
 * Synthetic fixtures for tests, docs and the demo (ADR-0021). They use only documentation
 * address ranges (RFC 5737 / RFC 3849), private ranges, and `example.*`/`.test` domains.
 */
function lines(file: string): string[] {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.trim().length > 0);
}

/** Suricata EVE lines: 4 alerts plus a `flow` and a `dns` event (lines 2 and 5). */
export function suricataEveLines(): string[] {
  return lines('./suricata-eve.ndjson');
}

/** CEF lines, some with syslog prefixes (RFC 3164 and RFC 5424). */
export function cefLines(): string[] {
  return lines('./cef.log');
}

/** Canonical alert JSON lines. */
export function canonicalLines(): string[] {
  return lines('./canonical.ndjson');
}
