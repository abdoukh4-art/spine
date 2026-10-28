# Console exercises: solutions

Try the exercises in [the console module guide](../console.md) first. These are sketches, not
the only right answers.

## 1. Off-by-one refresh

The test already exists as `http.test.ts` "reuses a token refreshed by another request instead
of refreshing again". The shape:

```ts
backend.releaseRefresh(); // refreshes answer immediately
await client.login('sam@spine.local', 'pw'); // token-1
backend.expire();
await client.request({ path: '/things', schema: Thing }); // 401 → refresh #1 → token-2
const late = client.request({ path: '/things', schema: Thing });
await expect(late).resolves.toEqual({ ok: true });
expect(backend.refreshCount()).toBe(1);
```

To make it a _true_ late 401, the request must have been **sent** with `token-1` before the
refresh finished. The line that handles it is in `recoverFromUnauthorized`:

```ts
if (current && current.accessToken !== usedToken) return current;
```

Each request remembers the token it was sent with (`usedToken`). If the session's token has
changed since, someone else already refreshed: just retry with the new one. Without this check,
a slow request would start a second refresh with an already-rotated cookie, and reuse detection
([ADR-0016](../../adr/0016-authentication-jwt-refresh-rotation.md)) would revoke the session.

## 2. Shareable sort by last seen

- `filters.ts`: widen `sort` to `'receivedAt' | 'score' | 'lastSeenAt'`; parse it from the URL.
- `AlertQueuePage.tsx`: add a `<SortableHeader label="Last seen" direction={sortDirection('lastSeenAt')} onSort={sortBy('lastSeenAt')} />` and a cell.
- Test: click the header, assert `currentLocation()` is `/alerts?sort=lastSeenAt` and the `<th>` has `aria-sort="descending"`.
- Backend: `AlertListQuerySchema.sort` only allows `receivedAt|score`, so this is an **additive
  contract change** in `@spine/shared-schema` plus an index on `(last_seen_at, id)` for keyset
  pagination. Until then the server answers 400, and the console shows the error state.

## 3. Pending count in the nav

Reuse the approvals query instead of adding a new poll:

```tsx
const pending = useQuery({
  queryKey: queryKeys.approvalList('pending'),
  queryFn: () => api.approvals.list({ status: 'pending', limit: 100 }),
  refetchInterval: 10_000,
});
const count = pending.data?.items.length ?? 0;
<NavLink to="/approvals">Approvals{count > 0 ? ` (${count})` : ''}</NavLink>;
```

Same key and options as the approvals page, so TanStack Query dedupes them: one request per
10 s whether or not the page is open. The count is plain text inside the link, so the link's
accessible name is "Approvals (2)". Don't make it a live region: announcing every change while
the analyst works elsewhere is noise. Tests must now expect `GET /approvals` from the shell.

## 4. Expired while the dialog is open

Today: the analyst confirms, the card disappears optimistically, the server answers 409
(`expired`), the card comes back (rollback), the refetch removes it (it's no longer pending)
and the toast says "already decided or has expired". Correct, but late.

Test with a movable clock in the fake server:

```ts
let now = TEST_NOW;
const app = renderApp('/approvals', 'analyst', { now: () => now });
// open the dialog on the 3-minute approval, then:
now += 4 * 60_000;
// confirm → expect the 409 toast
```

Improvement: pass `now` (from `useNow(1000)`) into the dialog and disable the confirm button
with a visible message ("This approval expired at 12:03 UTC") once `expiresAt` has passed.

## 5. Keyboard trap check in a real browser

```js
await page.getByRole('button', { name: 'Approve' }).first().click();
const dialog = page.getByRole('dialog');
for (let i = 0; i < 10; i++) {
  await page.keyboard.press('Tab');
  const inside = await dialog.evaluate((d) => d.contains(document.activeElement));
  expect(inside).toBe(true);
}
await page.keyboard.press('Escape');
await expect(page.getByRole('button', { name: 'Approve' }).first()).toBeFocused();
```

`showModal()` makes everything outside the dialog inert, so this passes without any JavaScript
focus-trap code: that is the main reason [ADR-0023](../../adr/0023-console-react-vite-no-ui-kit.md)
chose the native `<dialog>`. (In Chromium, Tab may move focus to the browser UI after the last
element; the check is that it never lands on page content behind the dialog.)
