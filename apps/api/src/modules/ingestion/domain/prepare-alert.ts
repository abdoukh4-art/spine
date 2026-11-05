import { RAW_PAYLOAD_MAX_BYTES, type CanonicalAlert } from '@spine/shared-schema';
import { computeFingerprint } from './fingerprint.js';
import { extractIndicators } from './indicators.js';

/**
 * The last pure step before persistence: indicators are extracted and normalized, the raw
 * payload is capped, and the fingerprint is computed from the *normalized* indicators.
 */
export interface PreparedAlert {
  alert: CanonicalAlert;
  fingerprint: string;
}

/** What replaces a raw payload that is too large to keep (ADR-0011: ≤ 64 KiB). */
export interface TruncatedRaw {
  truncated: true;
  bytes: number;
}

/**
 * Keeps `raw` when its JSON serialization fits in {@link RAW_PAYLOAD_MAX_BYTES} UTF-8 bytes,
 * otherwise replaces it with `{ truncated: true, bytes }`. We count UTF-8 bytes rather than
 * JavaScript string length, so a payload full of non-ASCII text can't sneak past the limit.
 */
export function capRawPayload(raw: unknown, maxBytes = RAW_PAYLOAD_MAX_BYTES): unknown {
  if (raw === undefined) return undefined;
  let text: string | undefined;
  try {
    text = JSON.stringify(raw) as string | undefined;
  } catch {
    // BigInt or a cycle: can't happen for parsed JSON, but a programmatic caller could pass one.
    return { truncated: true, bytes: -1 } satisfies TruncatedRaw;
  }
  if (text === undefined) return undefined; // functions/symbols serialize to nothing
  const bytes = new TextEncoder().encode(text).length;
  return bytes <= maxBytes ? raw : ({ truncated: true, bytes } satisfies TruncatedRaw);
}

/** Normalizes indicators, caps `raw`, and fingerprints the result. Pure and deterministic. */
export function prepareAlert(alert: CanonicalAlert): PreparedAlert {
  const indicators = extractIndicators(alert);
  const raw = capRawPayload(alert.raw);
  const prepared: CanonicalAlert = { ...alert, indicators };
  if (raw === undefined) delete prepared.raw;
  else prepared.raw = raw;
  return {
    alert: prepared,
    fingerprint: computeFingerprint({
      source: alert.source,
      category: alert.category,
      title: alert.title,
      indicators,
    }),
  };
}
