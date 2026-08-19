# HPA-177 Weekly Daily Challenge Leaderboard Design

## Summary

Activate HPA-177 as the next Arcturus product slice after the HPA-167 roadmap closeout.

Build exactly one read-only **current UTC week** leaderboard for Blackjack Daily Challenge. Reuse the unified `blackjack_run` rows already produced by Daily mode, aggregate them directly in D1, expose one public current-week read endpoint, and render the result on the existing `/games/daily-challenge` page below the existing daily board.

No schema change, migration, snapshot table, scheduled finalization, rewards, seasons, historical week picker, generic period-leaderboard framework, or new page is required.

## Why this is the next actionable task

The concrete HPA-167 architecture/game sequence is complete. HPA-177 is the remaining live Arcturus Backlog child, its technical prerequisite HPA-553 is already shipped, and the request to continue with the next Arcturus task is the product decision to activate this previously deferred comparison slice.

HPA-553 already provides the data HPA-177 needs:

- one `blackjack_run` Daily row per user and `periodKey`;
- `status = 'completed'` for eligible terminal attempts;
- `dailyEndingBankroll`;
- `dailyRoundsCompleted`;
- `settledAt`;
- an existing Daily leaderboard repository/service/HTTP/UI path.

The current database also has `blackjack_run_daily_leaderboard_idx` beginning with `(mode, periodKey, status, ...)`, so a seven-day `periodKey` range query is a bounded extension of the existing read model rather than a reason to add storage.

## Goals

- Show one current-week Blackjack Daily leaderboard on `/games/daily-challenge`.
- Define the week as Monday 00:00 UTC through the next Monday 00:00 UTC.
- Aggregate only completed unified Daily results from the current week.
- Show top results to guests and authenticated users.
- Show an authenticated user's current weekly standing even when outside the top result limit.
- Keep weekly ranking deterministic and explainable.
- Reuse the current Blackjack Run repository/service/HTTP/UI seams.

## Non-goals

- Previous-week or arbitrary historical queries.
- Monthly boards, seasons, divisions, leagues, promotion, or archives.
- Rewards, chips, badges, missions, notifications, or settlement changes.
- Scheduled weekly finalization or immutable snapshots.
- New tables, migrations, cron jobs, Durable Objects, queues, or caches.
- Generalizing `src/lib/leaderboard/` or creating a cross-game period leaderboard framework.
- Refactoring Daily Challenge gameplay, replay, scoring, or one-attempt-per-day behavior.
- Migrating old pre-HPA-553 Daily Challenge data.
- A test-only production seed endpoint or Playwright-side D1 mutation path.

## Options considered

### A. Extend unified Daily Challenge with one current-week aggregate — selected

Add a current-week aggregate method to the existing Blackjack Run repository, a thin service/HTTP path, and a second leaderboard renderer on the Daily Challenge page.

This keeps the feature beside its only real data producer and uses the current `blackjack_run` schema directly.

### B. Add a generic period leaderboard service

Rejected. Arcturus currently has one concrete weekly requirement for one game mode. A generic daily/weekly/monthly abstraction would introduce configuration, period polymorphism, and cross-game contracts without a second consumer.

### C. Materialize weekly rows or snapshots

Rejected. At most seven Daily rows per participating user are relevant to the current board. A bounded D1 aggregate is simpler and avoids scheduled finalization, migration, and cache invalidation behavior.

### D. Add a separate weekly leaderboard page

Rejected. Weekly comparison belongs to the Daily Challenge experience. A second page would duplicate navigation, loading, empty/error handling, and styling for one small read-only view.

## Week semantics

Use the existing UTC weekly primitives in `src/lib/missions/periods.ts` rather than inventing another week calendar:

- `getWeeklyPeriodKey(date)` provides the ISO week label, e.g. `2026-W34`;
- `getNextWeeklyReset(date)` provides the next Monday at 00:00 UTC.

Add a Blackjack-Daily-owned helper in `src/lib/blackjack-run/daily.ts`:

```ts
export interface DailyWeekWindow {
  readonly weekKey: string;
  readonly startPeriodKey: string;
  readonly endPeriodKeyExclusive: string;
}

export function getDailyWeekWindow(nowSeconds: number): DailyWeekWindow;
```

Implementation derives `endPeriodKeyExclusive` from `getNextWeeklyReset(nowDate)` and subtracts seven UTC days for `startPeriodKey`. This avoids duplicating ISO-week arithmetic while keeping the concrete Daily query range close to Daily code.

`weekKey` is a display/identity label only. The repository query always filters by canonical calendar-date boundaries:

```sql
r.mode = 'daily'
AND r.status = 'completed'
AND r.periodKey >= ?
AND r.periodKey < ?
```

That distinction matters across New Year: for `2027-01-01`, `weekKey` is `2026-W53` while the date range is `2026-12-28` through `2027-01-04` exclusive. Tests must pin this so no later implementation tries to filter `blackjack_run.periodKey` with the ISO week label.

## Weekly scoring and ranking

### Weekly score

For each user:

```text
weeklyScore = SUM(dailyEndingBankroll)
```

Daily Challenge resets every attempt to the same 1,000-chip challenge bankroll, so summing ending bankrolls intentionally rewards both participation and performance. This is an engagement-oriented weekly comparison, not a persistent wallet balance and not a reward currency.

The UI labels this value **Weekly score**. Do not normalize to an average, best-N score, net profit, or configurable point system in this slice.

### Supporting values

Aggregate:

- `daysPlayed = COUNT(*)`;
- `totalRounds = SUM(dailyRoundsCompleted)`;
- `lastSettledAt = MAX(settledAt)`.

Because unified Daily mode has one row per `(userId, mode, periodKey)`, `COUNT(*)` is the number of completed Daily attempts in the current week.

### Deterministic order

Rank every weekly participant by:

1. `weeklyScore DESC`;
2. `daysPlayed DESC`;
3. `totalRounds DESC`;
4. `lastSettledAt ASC`;
5. `userId ASC`.

Include the full order inside the SQL `RANK()` window and use the exact same order for the displayed top rows. With `userId` as the final key, weekly ranks are unique and deterministic. This intentionally differs from the existing Daily board, where equal score/round totals may share a rank.

## Repository design

Keep the weekly read inside `src/server/blackjack-run/repository.ts` because it reads the same Daily projection columns as `listDailyLeaderboard`.

Add focused types:

```ts
export interface WeeklyLeaderboardEntry {
  readonly rank: number;
  readonly userId: string;
  readonly playerName: string;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
  readonly totalRounds: number;
  readonly lastSettledAt: number;
}

export interface WeeklyCurrentUserStanding {
  readonly rank: number;
  readonly totalEligible: number;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
  readonly totalRounds: number;
}

export interface WeeklyLeaderboardRead {
  readonly entries: readonly WeeklyLeaderboardEntry[];
  readonly currentUser: WeeklyCurrentUserStanding | null;
}
```

Extend the repository interface with:

```ts
listWeeklyLeaderboard(
  startPeriodKey: string,
  endPeriodKeyExclusive: string,
  limit: number,
  userId?: string | null,
): Promise<WeeklyLeaderboardRead>;
```

Use one shared weekly aggregate/ranking CTE definition for the top-list and current-user reads so ranking semantics cannot drift from display order. Follow the existing Daily pattern for returning top entries, current-user standing, and total eligible, but do not copy Daily's separate rank-window definitions.

No schema/index change is planned. The existing Daily leaderboard index already starts with the range-filter columns. Only add an index if later measured query evidence shows a problem.

## Service and HTTP design

The service owns “current week” resolution so clients cannot request arbitrary historical weeks.

Add:

```ts
weeklyLeaderboard(userId: string | null, limit: number): Promise<WeeklyLeaderboardRead>;
```

`BlackjackRunServiceImpl.weeklyLeaderboard` calls `getDailyWeekWindow(this.nowSeconds())`, then delegates the resulting date-key range to `repository.listWeeklyLeaderboard(...)`.

Add one public route:

```text
GET /api/blackjack-daily/weekly-leaderboard?limit=50
```

The HTTP handler:

- allows guests;
- reuses the existing leaderboard limit bounds `1..50`, default `50`;
- takes no week/date parameter;
- strips `userId` and `lastSettledAt` from public entries;
- returns `currentUser` only for authenticated users whose completed Daily rows exist this week;
- returns `cache-control: no-store`, matching the existing Daily leaderboard response.

Public projection:

```ts
export interface WeeklyLeaderboardPublicEntry {
  readonly rank: number;
  readonly playerName: string;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
  readonly totalRounds: number;
}

export interface WeeklyLeaderboardPublicView {
  readonly entries: readonly WeeklyLeaderboardPublicEntry[];
  readonly currentUser: WeeklyCurrentUserStanding | null;
}
```

The route remains a thin adapter under `src/pages/api/blackjack-daily/`.

## UI design

Keep the current daily board unchanged and add a second section immediately after it on `/games/daily-challenge`.

Copy shape:

- eyebrow: `This Week`;
- heading: `Weekly Results`;
- helper text: `Monday–Sunday · UTC`;
- each row: `#<rank> <playerName> <weeklyScore> pts · <daysPlayed>/7 days`;
- authenticated current standing: `#<rank> · <weeklyScore> pts · <daysPlayed>/7 days`.

Do not add tabs, a date picker, pagination, week navigation, charts, or a new design component.

Extend `src/lib/blackjack-run/daily-ui.ts` with a separate weekly response parser, `renderWeeklyLeaderboard(...)`, and a weekly-local error renderer. Weekly rows use their own `data-testid="daily-challenge-weekly-leaderboard-row"`, mirroring the existing Daily row test seam.

On page initialization, fetch the existing daily leaderboard and current-week leaderboard independently. A weekly fetch failure shows a visible weekly-unavailable message inside the weekly section without hiding or replacing a successfully loaded daily board or gameplay status.

## Error and empty-state behavior

- Empty week: render no rows and hide authenticated standing if the user has no completed result.
- Guest: render top weekly rows only.
- Malformed weekly payload: render `Weekly leaderboard is unavailable — refresh to retry.` in the weekly section.
- Weekly request failure: same weekly-local message; Daily gameplay and today's board remain usable.
- No retries, backoff, persistence, or offline cache.

## Files

Expected implementation surface:

- `src/lib/blackjack-run/daily.ts`
- `src/lib/blackjack-run/daily.test.ts`
- `src/server/blackjack-run/repository.ts`
- `src/server/blackjack-run/repository.integration.test.ts`
- `src/server/blackjack-run/service.ts`
- `src/server/blackjack-run/service.test.ts`
- `src/server/blackjack-run/http.ts`
- `src/server/blackjack-run/http.test.ts`
- `src/pages/api/blackjack-daily/weekly-leaderboard.ts` (new)
- `src/lib/blackjack-run/daily-ui.ts`
- `src/lib/blackjack-run/daily-ui.test.ts`
- `src/pages/games/daily-challenge.astro`
- `e2e/daily-challenge.spec.ts`

No database schema or migration file should change.

## Testing strategy

The proof is deliberately split at the seams the repository already has. Do not invent a Playwright database seed backdoor merely to make one E2E cover SQL aggregation.

### Week window unit tests

Pin UTC boundaries:

- Monday at 00:00 UTC resolves to that Monday through next Monday;
- Sunday late UTC resolves to the same week;
- the instant of next Monday resolves to the new week;
- `2027-01-01` resolves to `weekKey: '2026-W53'` with calendar range `2026-12-28` through `2027-01-04` exclusive;
- invalid time values follow `getDailyWindow` validation.

### Repository integration tests — authoritative multi-day ranking proof

Use `src/server/blackjack-run/test-d1.ts` helpers to seed completed Daily rows across two weeks and verify:

- only current-range rows aggregate;
- weekly score sums ending bankrolls;
- days and rounds sum correctly;
- non-completed Daily rows and Ranked rows are excluded;
- order follows score → days → rounds → earlier final settlement → user id;
- exact final ties are deterministic and ranks remain unique;
- top limit is honored;
- authenticated current user is returned even when outside the top limit;
- total eligible counts weekly participants, not source rows.

Multi-user, multi-day ordering and out-of-top standing stop here; these are repository contracts and do not need a second test-only data path through Playwright.

### Service/HTTP tests

Verify:

- service derives the current range from its injected clock;
- the public endpoint allows guests;
- `limit` uses existing `1..50` validation;
- no historical week parameter exists;
- internal `userId`/`lastSettledAt` do not cross the HTTP boundary;
- authenticated current standing is present when eligible.

### Daily UI tests

Verify:

- strict parsing of weekly score/day/round fields;
- weekly rows use `daily-challenge-weekly-leaderboard-row` and render independently of today's board;
- weekly current standing renders independently;
- weekly request failure uses only the weekly-local error surface;
- guests still issue the public weekly request.

### E2E — real product wiring only

Extend the existing `e2e/daily-challenge.spec.ts` journey without adding D1 seeding, a seed endpoint, or a `page.route` weekly JSON fake.

Verify:

- guest page load issues `GET /api/blackjack-daily/weekly-leaderboard` and renders the weekly section without a weekly error;
- existing Practice/Ranked/Daily-board behavior remains intact;
- after the signed-in user completes today's real Daily attempt and reloads, the weekly endpoint returns that user with `daysPlayed = 1`, `weeklyScore` equal to today's ending bankroll, and `totalRounds = 10`;
- the weekly current-standing DOM displays that score and `1/7 days`;
- at least one weekly row displays that score and `1/7 days`.

The repository integration test, not Playwright, proves multi-day ranking, previous-week exclusion, and current-user standing outside the top limit.

## Validation

Focused checks during implementation:

```bash
bun test src/lib/blackjack-run/daily.test.ts
bun test src/server/blackjack-run/repository.integration.test.ts
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
bun test src/lib/blackjack-run/daily-ui.test.ts
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Final checks:

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Because no schema change is intended, final scope validation must confirm the diff contains no `src/db/schema.ts` or migration edits and no test-only production seed path.

## Scope guardrails

Do not add:

- a generic period/competition/season abstraction;
- another leaderboard table or snapshot model;
- scheduled jobs or finalization;
- historical week APIs or UI;
- a new route page;
- rewards or wallet writes;
- old Daily adapters;
- monthly periods;
- new caching/retry infrastructure;
- compatibility layers;
- a production E2E seed endpoint, direct Playwright D1 writer, or weekly response stub used to claim SQL aggregation coverage.

If implementation requires more than a bounded aggregate query and a second read-only UI projection, simplify before merge.