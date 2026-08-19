# HPA-177 Weekly Daily Challenge Leaderboard Design

## Summary

Activate HPA-177 as the next Arcturus product slice after the HPA-167 roadmap closeout.

The original evidence gate remains important: this feature should exist only when weekly comparison is explicitly wanted. The current request to continue with the next Arcturus task is the product decision to activate that deferred slice. Its technical prerequisite, HPA-553, is already shipped.

Build exactly one read-only **current UTC week** leaderboard for Blackjack Daily Challenge. Reuse the unified `blackjack_run` rows already produced by Daily mode, aggregate them directly in D1, expose one public current-week read endpoint, and render the result on the existing `/games/daily-challenge` page below the existing daily board.

No schema change, migration, snapshot table, scheduled finalization, rewards, seasons, historical week picker, generic period-leaderboard framework, or new page is required.

## Why this is the next actionable task

The Arcturus project has completed HPA-167 and every concrete architecture/game slice under it. The only remaining live Backlog child is HPA-177. HPA-174 is already closed as intentionally deferred history work, while HPA-177 has a completed technical blocker and a deliberately small future scope.

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
- Show the top results to guests and authenticated users.
- Show an authenticated user's current weekly standing even when they are outside the top result limit.
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

## Options considered

### A. Extend unified Daily Challenge with one current-week aggregate — selected

Add a current-week aggregate method to the existing Blackjack Run repository, a thin service/HTTP path, and a second leaderboard renderer on the Daily Challenge page.

This keeps the feature beside its only real data producer and uses the current `blackjack_run` schema directly.

### B. Add a generic period leaderboard service

Rejected. Arcturus currently has one concrete weekly requirement for one game mode. A generic daily/weekly/monthly abstraction would introduce configuration, period polymorphism, and cross-game contracts without a second consumer.

### C. Materialize weekly rows or snapshots

Rejected. At most seven Daily rows per participating user are relevant to the current board. A bounded D1 aggregate is simpler and avoids scheduled finalization, migration, and cache invalidation behavior.

### D. Add a separate weekly leaderboard page

Rejected. Weekly comparison is part of the Daily Challenge experience. A second page would duplicate navigation, loading, empty/error handling, and styling for one small read-only view.

## Week semantics

Use the existing UTC weekly primitives in `src/lib/missions/periods.ts` rather than inventing another week calendar:

- `getWeeklyPeriodKey(date)` provides the ISO-style week label, e.g. `2026-W34`.
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

The repository filters:

```sql
r.mode = 'daily'
AND r.status = 'completed'
AND r.periodKey >= ?
AND r.periodKey < ?
```

`periodKey` is canonical `YYYY-MM-DD`, so lexical comparison matches chronological order within the bounded range.

## Weekly scoring and ranking

### Weekly score

For each user:

```text
weeklyScore = SUM(dailyEndingBankroll)
```

Daily Challenge resets every attempt to the same 1,000-chip challenge bankroll, so summing ending bankrolls intentionally rewards both participation and performance. This is an engagement-oriented weekly comparison, not a persistent wallet balance and not a reward currency.

The UI labels this value **Weekly score**, not wallet balance.

Do not normalize to an average, best-N score, net profit, or custom point system in this slice.

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

Include the full order inside the SQL `RANK()` window so each participant receives one deterministic rank. `userId` is only the final internal tie-breaker and is stripped at the HTTP boundary.

This differs deliberately from the daily board, where equal score/round totals may share a rank. HPA-177 explicitly asks for a deterministic weekly tie-breaker.

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

Use one shared weekly aggregate/ranking CTE definition for the top-list and current-user queries so ranking semantics cannot drift. Follow the existing Daily pattern: top entries, current-user rank/details, and total eligible are bounded read queries, not cached state.

No schema/index change is planned. The existing Daily leaderboard index already starts with the range-filter columns. Only add an index if measured query evidence shows a problem later.

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

The route is implemented as the same thin adapter pattern as the existing daily route under `src/pages/api/blackjack-daily/`.

## UI design

Keep the current daily board unchanged and add a second section immediately after it on `/games/daily-challenge`.

Copy shape:

- eyebrow: `This Week`;
- heading: `Weekly Results`;
- helper text: `Monday–Sunday · UTC`;
- each row: `#<rank> <playerName> <weeklyScore> pts · <daysPlayed>/7 days`;
- authenticated current standing: `#<rank> · <weeklyScore> pts · <daysPlayed>/7 days`.

Do not add tabs, a date picker, pagination, week navigation, charts, or a new design component.

Extend `src/lib/blackjack-run/daily-ui.ts` with a separate weekly response parser and `renderWeeklyLeaderboard(...)`. The Daily and weekly payloads intentionally remain different types because they represent different scoring semantics.

On page initialization, fetch the existing daily leaderboard and current-week leaderboard independently. A weekly fetch failure should show a visible weekly-unavailable message inside the weekly section without hiding or replacing a successfully loaded daily board or gameplay status.

This is a small improvement over reusing the global Daily gameplay status for both requests: each leaderboard owns its own read failure surface.

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

### Week window unit tests

Pin UTC boundaries:

- Monday at 00:00 UTC resolves to that Monday through next Monday.
- Sunday late UTC resolves to the same week.
- the instant of next Monday resolves to the new week.
- returned `weekKey` matches `getWeeklyPeriodKey`.

### Repository integration tests

Seed completed Daily rows across two weeks and verify:

- only current-range rows aggregate;
- weekly score sums ending bankrolls;
- days and rounds sum correctly;
- non-completed Daily rows and Ranked rows are excluded;
- order follows score → days → rounds → earlier final settlement → user id;
- top limit is honored;
- authenticated current user is returned even when outside the top limit;
- total eligible counts weekly participants, not rows.

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
- weekly rows and current standing render independently of today's board;
- weekly request failure uses the weekly-local error surface;
- guests still load the public weekly board.

### E2E

Extend `e2e/daily-challenge.spec.ts` with one populated current-week board scenario. Seed at least two users with multiple completed Daily rows in the current UTC week and assert:

- weekly rows display in deterministic order;
- score is the sum of Daily ending bankrolls;
- days-played copy is correct;
- the signed-in user's weekly standing is visible even when the top list is constrained below their rank.

Keep existing Daily Challenge gameplay and today's leaderboard E2E coverage intact.

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

Because no schema change is intended, final scope validation should confirm the diff contains no `src/db/schema.ts` or migration edits.

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
- compatibility layers.

If implementation requires more than a bounded aggregate query and a second read-only UI projection, simplify before merge.
