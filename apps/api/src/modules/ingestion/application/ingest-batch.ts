import type { BatchFormat, BatchResult } from '@spine/shared-schema';
import { AppError } from '../../../platform/errors.js';
import { NORMALIZERS, type NormalizerName } from '../domain/normalizers/index.js';
import type { NormalizationError } from '../domain/result.js';
import type { IngestAlert } from './ingest-alert.js';

/** Batch formats → normalizers. `ndjson` lines are canonical JSON. */
const NORMALIZER_FOR_FORMAT: Readonly<Record<BatchFormat, NormalizerName>> = {
  ndjson: 'canonical',
  cef: 'cef',
  'suricata-eve': 'suricata-eve',
};

/** At most this many per-line errors are reported (the counts stay exact). */
export const MAX_REPORTED_ERRORS = 100;
/** Lines ingested in parallel: enough to overlap DB round trips, small enough to leave pool connections for other requests. */
const CONCURRENCY = 4;

type LineOutcome =
  | { kind: 'created' | 'deduplicated' | 'skipped' }
  | { kind: 'rejected'; message: string };

/** Formats a normalization error as one readable line for the batch report. */
export function describeNormalizationError(error: NormalizationError): string {
  const details = (error.issues ?? [])
    .slice(0, 3)
    .map((i) => `${i.path}: ${i.message}`)
    .join('; ');
  return (details ? `${error.message} (${details})` : error.message).slice(0, 500);
}

/**
 * Bulk import (`POST /ingest/batch`). Every line is its own unit of work, so the batch is
 * **partially successful** by design: a malformed line is reported with its 1-based line
 * number and the others still go in. Blank lines are ignored; well-formed records that are not
 * alerts (Suricata `flow`, `dns`… events) are counted as `skipped`, not as errors.
 */
export class IngestBatch {
  constructor(private readonly ingest: IngestAlert) {}

  /** Processes the body. `receivedAt` is the fallback event time for formats that allow one. */
  async execute(body: string, format: BatchFormat, receivedAt: string): Promise<BatchResult> {
    const normalize = NORMALIZERS[NORMALIZER_FOR_FORMAT[format]];
    const lines = body.split(/\r?\n/);
    const work = lines
      .map((text, index) => ({ text, line: index + 1 }))
      .filter((l) => l.text.trim().length > 0);
    const outcomes = new Array<LineOutcome>(work.length);

    const processLine = async (i: number): Promise<void> => {
      const item = work[i];
      if (!item) return;
      const normalized = normalize(item.text, { receivedAt });
      if (!normalized.ok) {
        outcomes[i] =
          normalized.error.code === 'not_an_alert'
            ? { kind: 'skipped' }
            : { kind: 'rejected', message: describeNormalizationError(normalized.error) };
        return;
      }
      try {
        const outcome = await this.ingest.execute({ alert: normalized.value });
        outcomes[i] = { kind: outcome.result.status };
      } catch (error) {
        // Expected business errors are per-line; infrastructure errors fail the request.
        if (!(error instanceof AppError)) throw error;
        outcomes[i] = { kind: 'rejected', message: error.message };
      }
    };

    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < work.length) {
        const i = next;
        next += 1;
        await processLine(i);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, work.length) }, worker));
    return summarize(
      work.map((w) => w.line),
      outcomes,
    );
  }
}

function summarize(lineNumbers: number[], outcomes: LineOutcome[]): BatchResult {
  const result: BatchResult = { accepted: 0, deduplicated: 0, rejected: 0, skipped: 0, errors: [] };
  outcomes.forEach((o, i) => {
    if (o.kind === 'rejected') {
      result.rejected += 1;
      if (result.errors.length < MAX_REPORTED_ERRORS) {
        result.errors.push({ line: lineNumbers[i] ?? 0, message: o.message });
      }
    } else if (o.kind === 'created') result.accepted += 1;
    else if (o.kind === 'deduplicated') result.deduplicated += 1;
    else result.skipped += 1;
  });
  return result;
}
