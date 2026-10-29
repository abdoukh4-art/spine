import type { Normalizer } from './canonical.js';
import { normalizeCanonical } from './canonical.js';
import { normalizeCef } from './cef.js';
import { normalizeSuricataEve } from './suricata-eve.js';

export type { NormalizeContext, Normalizer } from './canonical.js';
export { normalizeCanonical, normalizeCef, normalizeSuricataEve };

/** Names of the available normalizers (also the values allowed in `WEBHOOK_SOURCES_JSON`). */
export const NORMALIZER_NAMES = ['canonical', 'suricata-eve', 'cef'] as const;
export type NormalizerName = (typeof NORMALIZER_NAMES)[number];

/** Registry: adding a source = writing one pure function and adding one line here (ADR-0030). */
export const NORMALIZERS: Readonly<Record<NormalizerName, Normalizer>> = {
  canonical: normalizeCanonical,
  'suricata-eve': normalizeSuricataEve,
  cef: normalizeCef,
};
