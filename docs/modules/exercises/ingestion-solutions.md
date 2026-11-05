# Ingestion: exercise solutions

Exercises are in the [ingestion module guide](../ingestion.md#exercises). Try them first.

## 1. Defang in the title

Indicators are refanged, titles are not: `normalizeTitle` only applies NFKC, lower-casing and
whitespace collapsing. So for a source **without** `sourceAlertId`, `"Callback to evil[.]example"`
and `"Callback to evil.example"` produce **different** fingerprints.

Should they? Arguments for leaving it: titles come from detection rules, which are stable
strings, so a rule never alternates between the two spellings; and refanging free text could
turn a harmless `[.]` in a title into something different. A pinning test:

```ts
it('does not refang titles', () => {
  const a = fingerprintMaterial({
    source: { vendor: 'V', product: 'P' },
    category: 'other',
    title: 'evil[.]example',
    indicators: [],
  });
  expect(a).toContain('evil[.]example');
});
```

If you chose the other behaviour, apply `refang` inside `normalizeTitle` and update ADR-0032.

## 2. Beacon floods

```ts
it('fallback fingerprint merges beacons between the same hosts', () => {
  const beacon = (port: number) => ({
    source: { vendor: 'OISF', product: 'Suricata' },
    category: 'command_and_control',
    title: 'ET MALWARE Cobalt Strike Beacon Observed',
    indicators: normalizeIndicators([
      { type: 'ipv4', value: '10.20.30.40' },
      { type: 'ipv4', value: '203.0.113.66' },
    ]),
    port, // not part of the fingerprint
  });
  expect(computeFingerprint(beacon(49812))).toBe(computeFingerprint(beacon(50110)));
});
```

Ports are not indicators, so every beacon on a new ephemeral port has the same fingerprint.
What else would merge: a _second, separate_ infection between the same two hosts detected
while the first alert is still open. ADR-0031 kept `flow_id:signature_id` because its priority
is "never merge distinct detections"; beacon collapsing is listed as a revisit trigger.

## 3. A new normalizer

```ts
export const normalizeZeekNotice: Normalizer = (raw) => {
  const json = parseJsonInput(raw);
  if (!json.ok) return json;
  const e = json.value;
  if (!isRecord(e)) return err(normalizationError('parse_error', 'notice must be an object'));
  const title = str(e.note);
  const occurredAt = toIsoTimestamp(typeof e.ts === 'number' ? Math.round(e.ts * 1000) : e.ts);
  if (!title || !occurredAt)
    return err(normalizationError('missing_field', 'note and ts are required'));
  return validateCanonical(
    compact({
      source: { vendor: 'Zeek', product: 'notice' },
      title,
      description: str(e.msg),
      category: classifyCategory([title.replace('::', ' '), str(e.msg)]),
      severity: 'medium',
      occurredAt,
      network: compact({
        sourceIp: canonicalIp(String(e['id.orig_h']))?.value,
        destinationIp: canonicalIp(String(e['id.resp_h']))?.value,
        destinationPort: port(e['id.resp_p']),
      }),
      raw: e,
    }),
  );
};
```

`Scan::Port_Scan` becomes `Scan Port_Scan` and matches the `\bscan` rule → `reconnaissance`.
Note Zeek's `ts` is fractional epoch **seconds**; `toIsoTimestamp` treats integers below 10^10
as seconds, so convert to milliseconds first to keep the fraction. Then register it (step 3 of
"How to extend it").

## 4. Break the race

With `maxAttempts = 1`, `collapses 20 concurrent ingests…` fails: the barrier lets 4
transactions INSERT at once; 3 lose with `OpenAlertExistsError`, the use case gives up and
throws `ConflictError`, so those requests get **409** instead of 202 (the test compares all 20
status codes with 202).

`serializes concurrent requests with one key…` fails too: 5 requests with the same key race to
store the idempotency record; the losers' `save` returns false (`LostRace`), which is retried
by the same loop. With one attempt they also get 409 instead of a replay, so the test sees 0
replays instead of 4.

## 5. Clock skew

The sender gets `401 unauthenticated` ("invalid webhook signature"). The API logs
`webhook signature rejected` with `reason: "stale_timestamp"` and the `sourceId` (never the
secret). Options, best first: fix the sender's NTP; or make the window configurable per source
(e.g. `maxSkewSeconds` in `WEBHOOK_SOURCES_JSON`), accepting a longer replay window for that
source only. Don't widen it globally: the window bounds how long a captured request can be replayed.
