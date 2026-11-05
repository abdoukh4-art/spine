# 2026-10-28 — Infrastructure and observability: making the invisible visible

**Workstream:** infra + observability (Phase 1). **Branch:** `feat/infra-observability`.
**ADRs:** 0080–0085.

The goal for the day: a stack that starts with `make up`, exposes real metrics from both
processes, has a dashboard that will light up as soon as the modules publish their
metrics, and the operational documentation (deploy, observe, alert, recover, upgrade)
behind it. Most of the interesting lessons came from not trusting my assumptions, so this
entry is mostly a list of hypotheses that turned out to be wrong.

## 1. "Start the SDK in `main()`" — the first trap I avoided, and the one I didn't

I knew from experience that auto-instrumentation must be loaded before the libraries it
patches. Our build is an esbuild ESM bundle: every `import pg from 'pg'` is hoisted and
evaluated before `main()` runs. So `startTelemetry()` in `main()` is too late, and
because metrics still work in that setup, nothing would tell you the `pg` spans are
missing. Hence the preload, `node --import ./dist/instrument.js dist/main.js`.

**The trap I walked into.** The preload and `main.js` are separate bundles. My
`startTelemetry()` had a module-level `let running` guard to make it idempotent. The
first run printed `telemetry started` **twice**, then `EADDRINUSE :19464` and
`FST_ERR_DEC_ALREADY_PRESENT: The decorator 'Symbol(fastify otel instance)' has already
been added`.

- _Hypothesis:_ the guard variable exists once per bundle, not once per process.
- _Experiment:_ grep `dist/` — `sdk.ts` is inlined in both `instrument.js` and `main.js`.
- _Fix:_ store the handle on `globalThis[Symbol.for('spine.telemetry')]`. The OTel API
  itself uses exactly this trick for its global providers, for the same reason.

**Lesson:** "module singleton" means "singleton per copy of the module". Bundlers make
copies.

## 2. "ESM imports need the ESM loader hook" — falsified

The OpenTelemetry docs for ESM say to register `@opentelemetry/instrumentation/hook.mjs`
(import-in-the-middle). I did, and it worked. Later, reading the debug log
(`OTEL_LOG_LEVEL=debug`), I noticed every patch line said _"Applying instrumentation patch
for module **on require hook**"_. That is the CommonJS hook, not the ESM one.

- _Hypothesis:_ the ESM hook is not needed for us, because `pg` and `ioredis` are
  CommonJS, and Node loads a CommonJS package imported from ESM through the CommonJS
  loader, where `require-in-the-middle` sees it.
- _Experiment:_ run the same image twice against the compose network, once with the
  normal preload and once with a copy whose `module.register(...)` call was replaced by a
  no-op; call `/readyz` (it queries Postgres) and look for `db_client_operation_duration`
  in `/metrics`.
- _Result:_ `hook db metrics: true`, `nohook db metrics: true`. The hook version even
  logged one extra patch line (the same module patched by both hooks; the instrumentation
  guards against double-wrapping, but it's wasted work).
- _Decision:_ removed the hook. Fewer moving parts, one less loader thread. The preload's
  comment says when to add it back (a pure-ESM library).

**Lesson:** read the debug output of a thing that "works"; it often tells you that it
works for a different reason than you think.

## 3. The metric names were not what the shared brief assumed (partly)

The brief said "counters without `_total` (the exporter appends it), histograms named
`_seconds` with no unit option". I wrote a probe script that created one of each
instrument kind and printed `/metrics`. Confirmed: `_total` is appended (and not doubled
if you already wrote it, but then two instruments collide on one name). Confirmed: the
exporter **never** appends unit suffixes, so `unit: 's'` would only produce a `# UNIT`
comment line.

The surprise was elsewhere: **the default histogram buckets are `0, 5, 10, 25 … 10000`**.
Those are milliseconds. A seconds histogram with those buckets puts every observation
below 5 s into a single bucket, and `histogram_quantile(0.95, …)` returns garbage (it
interpolates linearly inside the bucket). Every module was about to record
`*_duration_seconds` histograms. Fix: a View in `startTelemetry` that gives every
`spine_*_seconds` histogram second-scale buckets from 5 ms to 1 h. I added `2` to the
list on purpose: SLO 2 is "scored within 2 s", and a burn-rate rule can only count
`le="2"` if a bucket boundary sits exactly there.

Also verified on the real output: the HTTP histogram is `http_server_request_duration`
(stable semantic conventions), not `http_server_duration` and not `…_seconds`. The
dashboard queries were written against that output, not against memory.

## 4. Docker builds in a sandbox: three walls

1. `npm install -g pnpm` inside the build failed with `SELF_SIGNED_CERT_IN_CHAIN`: this
   environment re-terminates TLS. Baking the CA into the image would ship an environment
   detail to everyone. Instead: a **BuildKit secret** (`--secret id=build_ca`) plus
   `NODE_EXTRA_CA_CERTS=/run/secrets/build_ca`. Without the secret, the file doesn't exist
   and Node ignores the variable (tested: no warning).
2. Compose's builder (bake) then refused: _"additional privileges requested:
   --allow=fs.read=/root/.ccr/ca-bundle.crt"_. Secret files outside the project need an
   entitlement. Copying the CA into the git-ignored `infra/tls/` solved it without
   weakening the check globally.
3. `pnpm deploy --offline` failed with `ERR_PNPM_NO_OFFLINE_META`: legacy deploy
   re-resolves metadata. It now runs online (with the secret), still pinned by the lockfile.

## 5. nginx: two config errors and a 502 that only appears on the second deploy

- `"keepalive_timeout" directive is duplicate`: the base image's `nginx.conf` already sets
  it, and our conf.d file is included into the same `http {}`. Same story for a default
  access log that would have logged every request twice. I now ship our own `nginx.conf`.
- `"proxy_read_timeout" directive is duplicate`: a snippet set it and the batch location
  overrode it in the same block. Timeouts moved to `http {}` so locations can override.
- **The 502.** After rebuilding the API container, every proxied request returned 502
  while the API was healthy. _Hypothesis:_ nginx resolved `api` once at start and kept the
  old container IP. _Experiment:_ `docker compose up -d --force-recreate api`, then curl
  through nginx. _Fix:_ nginx ≥ 1.27.3 supports `server api:3000 resolve` in an upstream
  (with a `zone` and a `resolver`); the resolver address comes from the image's own
  `15-local-resolvers` entrypoint script. After the fix, the same experiment gave 200
  within 2 s of the recreate.

A smaller one: the API echoes `X-Request-ID` and nginx added it too, so responses carried
it twice. `proxy_hide_header X-Request-ID` + nginx's own `add_header` keeps one copy that
is also present on nginx's own 413/429/502 responses.

## 6. Trivy found nothing in our code and plenty in our bases

`pnpm audit` was clean, and the node-pkg part of the Trivy scan was clean. The OS layers
weren't:

| Image (first build)                                 | Fixable HIGH/CRITICAL |
| --------------------------------------------------- | --------------------- |
| `spine-api` on `distroless/nodejs22-debian12`       | 7 (OpenSSL)           |
| `spine-console` on `nginx-unprivileged:1.28-alpine` | 72                    |

The nginx image from the mirror was eight months old. Moving to
`distroless/nodejs22-debian13` gave **0** findings; `nginx-unprivileged:1.30-alpine` (Oct 2026) gave 3 (curl, libcurl, brotli). curl is not needed (the healthcheck uses busybox
`wget`), so it is removed; `apk upgrade` fixes brotli in CI. Locally the Alpine CDN is
unreachable, so the local console image still reports 1 HIGH (brotli, fixed upstream in
1.2.1-r0). That's documented in the PR, not hidden with a `.trivyignore`.

**Lesson:** the dependency you didn't choose (the base image) is the one that ages fastest.
Scan images, not just lockfiles, and scan on a schedule.

## 7. Smaller decisions worth remembering

- **`X-Forwarded-For` is overwritten, not appended.** With `TRUST_PROXY=true`, Fastify
  takes the left-most address. Appending would let any client choose its IP and walk
  around per-IP rate limits.
- **HSTS on `localhost` is a footgun:** HSTS ignores ports, so a `max-age` set by
  `https://localhost:8443` would force HTTPS on every other local dev server. The max-age
  is a variable, `0` locally.
- **No gzip on API responses** (BREACH), gzip on static assets.
- **`requireParentSpan` for pg and ioredis.** The outbox relay polls every 200 ms and
  BullMQ blocks on Redis continuously; without it, thousands of orphan spans per minute.
- **@fastify/otel per-hook spans** (helmet, cors, …) turned a 4-span trace into 9 spans of
  noise; `instrumentHooks: false`.
- **The OTLP exporter's own HTTP calls** showed up as `http_client_request_duration`;
  `ignoreOutgoingRequestHook` filters them.
- **OTel versions:** the `0.300`/`3.0` line was 8 days old, so I used `0.222`/`2.11` per
  ADR-0022. `@fastify/otel 0.21.2` is the newest release built against that line.

## What is not done (honestly)

- The load test was validated with `k6 inspect` but not run: there is no ingestion route
  in this branch yet. Phase 3.
- `spine_alert_time_to_score_seconds` is a proposal to the scoring module; SLO 2's rules
  return no data until it exists.
- The demo script is a placeholder that waits for readiness and prints URLs.
- The CI image scan will run on GitHub for the first time with this PR.

## Reading that helped

- Google SRE Workbook, ch. 5 "Alerting on SLOs" (the burn-rate table is lifted from there).
- Mozilla Server Side TLS guidelines; OWASP HTTP Headers Cheat Sheet.
- OpenTelemetry JS docs on ESM, and the debug log, which was more honest than the docs.
