# ADR-0074: Console data freshness: polling, URL-held filters, and optimistic approvals with rollback

- **Status:** accepted
- **Date:** 2026-10-28
- **Deciders:** console workstream
- **Tags:** frontend, architecture

## Context and problem statement

A SOC console is a live view: new alerts arrive constantly, runs move while you watch, and
approvals expire. Several analysts act on the same data, so conflicts (two people approving
the same gate) are normal, not exceptional. We needed one consistent policy for how fresh each
view is, how failures of background refreshes look, and how a click should feel.

## Decision drivers

- New alerts visible within seconds; low load when nobody is looking.
- A network blip must not wipe the queue an analyst is reading.
- Approving should feel instant, but a conflict must be explained, never hidden.
- Views must be shareable and survive reloads (URL state, ADR-0023).

## Considered options

1. **Per-view polling with TanStack Query, paused when the tab is hidden; keep last good data on
   refresh errors; optimistic update with rollback for approvals only; filters in the URL.**
2. Server push (SSE/WebSocket) for every view.
3. No optimistic updates; wait for the server on every action.

## Decision outcome

**Chosen option 1.**

| View                 | Refresh                                                |
| -------------------- | ------------------------------------------------------ |
| Alert queue          | every 15 s (`refetchInterval`), not in background tabs |
| Alert detail         | every 5 s **only while** the alert is not scored yet   |
| Run detail           | every 3 s **until** the run is terminal                |
| Approvals (pending)  | every 10 s; countdowns tick every second locally       |
| Runs, simulated list | every 15 s                                             |
| Metrics              | every 60 s                                             |

- `refetchIntervalInBackground: false` (the default) pauses polling while the tab is hidden.
- `QueryView` shows the error state only when there is **no** data; a failed background
  refresh keeps the last data and shows "Could not refresh; showing the last data received".
- Retries skip 4xx errors (a 403 or 404 won't fix itself).
- Approve/reject removes the card immediately (`onMutate`), restores it on error (`onError`
  rollback), explains a 409 ("already decided or has expired"), then refetches (`onSettled`).
  Other mutations wait for the server and invalidate affected queries.
- Alert-queue filters, sort, run/simulated filters, approval tab, metrics window and audit
  filters live in URL search params.

### Consequences

- 👍 Predictable load: ~4 requests/min for an open queue tab, zero for hidden tabs.
- 👍 Proven by tests: rollback (`ApprovalsPage.test.tsx`, verified to fail when the rollback
  line is removed), polling stops at terminal state (`RunsPages.test.tsx`), filters ↔ URL.
- 👎 Up to 15 s latency for new alerts. Acceptable for triage; SSE is the upgrade path.
- 👎 Infinite queries refetch every loaded page on each poll; with "Load more" used heavily
  this grows. Acceptable at 25 alerts per page.

## Pros and cons of the options

### Server push

- 👍 Instant updates, less polling.
- 👎 Needs an SSE endpoint, sticky connections through nginx, and reconnection logic; not in
  the v1 contract. Polling is the honest Phase 1 answer.

### No optimistic updates

- 👍 Simpler.
- 👎 Approvals are the one action analysts repeat many times in a row; the delay matters there.

## What would make us revisit this

- The API gains an SSE stream of domain events (the outbox already has them).
- Load tests show polling is a significant share of API traffic.

## Further reading

- TanStack Query docs, _Optimistic Updates_ and _Important Defaults_
- Nielsen Norman Group, _Response Times: The 3 Important Limits_
