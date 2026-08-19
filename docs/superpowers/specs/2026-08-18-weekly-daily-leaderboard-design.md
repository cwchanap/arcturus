# HPA-177 Weekly Daily Challenge Leaderboard Design

## Summary

Build one read-only **current UTC week** leaderboard for Blackjack Daily Challenge.

Keep the feature inside the unified `blackjack-run` read model and the existing `/games/daily-challenge` page. Reuse the current Daily result rows, existing Monday-UTC reset helper, HTTP limit/error helpers, and Daily UI renderer patterns.

No schema change, migration, index, snapshot table, cron job, cache, reward flow, historical period API, new page, or generic period-leaderboard framework is required.

## Goals

- Show one current-week Blackjack Daily leaderboard on `/games/daily-challenge`.
- Define the week as Monday 00:00 UTC through the next Monday 00:00 UTC.
- Aggregate only completed unified Daily results from the current week.
- Show top results to guests and authenticated users.
- Show an authenticated user's standing even when outside the top result limit.
- Keep ranking deterministic and explainable.
- Keep Daily gameplay and today's leaderboard behavior unchanged.

## Non-goals

- Previous-week or arbitrary historical queries.
- Monthly boards, seasons, divisions, leagues, promotion, or archives.
- Rewards, chips, badges, missions, notifications, or settlement changes.
- Scheduled weekly finalization or immutable snapshots.
- New tables, migrations, indexes, cron jobs, Durable Objects, queues, or caches.
- Generalizing `src/lib/leaderboard/` or creating a cross-game period framework.
- Refactoring Daily gameplay, scoring, or one-attempt-per-day behavior.
- Migrating old pre-HPA-553 Daily Challenge data.

## Why the existing seams are enough

HPA-553 already stores one Daily run per `(userId, mode, periodKey)` plus the projections needed here:

- `status`;
- `dailyEndingBankroll`;
- `dailyRoundsCompleted`;
- `settledAt`.

The current `blackjack_run_daily_leaderboard_idx` starts with `(mode, periodKey, status, ...)`, so the current seven-day range remains a bounded read. Do not add another index without measured evidence.

`src/lib/missions/periods.ts` already owns the UTC weekly reset calculation. Extend Daily by composing that helper rather than reimplementing ISO week arithmetic.

## Week semantics

Add this Daily-owned helper in `src/lib/blackjack-run/daily.ts`:

```ts
export interface DailyWeekWindow {
  readonly startPeriodKey: string;
  readonly endPeriodKeyExclusive: string;
}

export function getDailyWeekWindow(nowSeconds: number): DailyWeekWindow;
```

Implementation:

1. validate `nowSeconds` with the same non-negative safe-integer contract as `getDailyWindow`;
2. convert to `Date`;
3. call existing `getNextWeeklyReset(now)`;
4. subtract seven UTC calendar days for the start;
5. return both boundaries through `getDailyPeriodKey`.

Do **not** return an ISO `weekKey`. No caller needs it, and the repository filters only canonical `YYYY-MM-DD` period keys.

Pin the year boundary directly on the date range:

```text
2027-01-01 -> start 2026-12-28, end 2027-01-04 exclusive
```

This makes it impossible for later SQL to accidentally filter Daily `periodKey` with an ISO week label.

## Weekly scoring and ranking

For each user:

```text
weeklyScore = SUM(dailyEndingBankroll)
daysPlayed = COUNT(*)
totalRounds = SUM(dailyRoundsCompleted)
lastSettledAt = MAX(settledAt)
```

Daily attempts all start from the same challenge bankroll, so summing ending bankrolls intentionally rewards both participation and performance. The UI labels the result **Weekly score**; it is not wallet balance or reward currency.

Rank by the full deterministic order:

1. `weeklyScore DESC`;
2. `daysPlayed DESC`;
3. `totalRounds DESC`;
4. `lastSettledAt ASC`;
5. `userId ASC`.

Keep the full order inside `RANK()`. Because `userId` is the terminal key, weekly ranks are unique by construction.

`totalRounds`, `lastSettledAt`, and `userId` are repository-only ranking data. Do not carry them through HTTP or UI merely because the query needs them.

## Repository design

Keep the weekly read in `src/server/blackjack-run/repository.ts` beside `listDailyLeaderboard`.

Repository types:

```ts
export interface WeeklyLeaderboardEntry {
  readonly rank: number;
  readonly userId: string;
  readonly playerName: string;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
  readonly totalRounds: number;
  readonly lastSettledAt: number;
  readonly totalEligible: number;
}

export interface WeeklyCurrentUserStanding {
  readonly rank: number;
  readonly totalEligible: number;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
}

export interface WeeklyLeaderboardRead {
  readonly entries: readonly WeeklyLeaderboardEntry[];
  readonly currentUser: WeeklyCurrentUserStanding | null;
}
```

Repository interface:

```ts
listWeeklyLeaderboard(
  startPeriodKey: string,
  endPeriodKeyExclusive: string,
  limit: number,
  userId?: string | null,
): Promise<WeeklyLeaderboardRead>;
```

### One-query contract

Use one aggregate/rank query, not separate top/current/count statements.

Semantic SQL shape:

```sql
WITH weekly AS (
  SELECT
    r.userId,
    u.name AS playerName,
    SUM(r.dailyEndingBankroll) AS weeklyScore,
    COUNT(*) AS daysPlayed,
    SUM(r.dailyRoundsCompleted) AS totalRounds,
    MAX(r.settledAt) AS lastSettledAt
  FROM blackjack_run AS r
  JOIN user AS u ON u.id = r.userId
  WHERE r.mode = 'daily'
    AND r.status = 'completed'
    AND r.periodKey >= ?1
    AND r.periodKey < ?2
  GROUP BY r.userId, u.name
), ranked AS (
  SELECT
    userId,
    playerName,
    weeklyScore,
    daysPlayed,
    totalRounds,
    lastSettledAt,
    RANK() OVER (
      ORDER BY
        weeklyScore DESC,
        daysPlayed DESC,
        totalRounds DESC,
        lastSettledAt ASC,
        userId ASC
    ) AS rank,
    COUNT(*) OVER () AS totalEligible
  FROM weekly
)
SELECT
  userId,
  playerName,
  weeklyScore,
  daysPlayed,
  totalRounds,
  lastSettledAt,
  rank,
  totalEligible
FROM ranked
WHERE rank <= ?3 OR userId = ?4
ORDER BY rank ASC;
```

Guests bind `NULL` for `?4`, so only top rows are returned. Authenticated users outside the top limit are returned by the same query. Aggregation, rank, participant count, top rows, and out-of-top standing therefore cannot drift between statements.

Validate all numeric row fields with the existing repository invariant style.

## Service and HTTP design

The service owns current-week resolution; clients cannot pass historical dates.

Add:

```ts
weeklyLeaderboard(
  userId: string | null,
  limit: number,
): Promise<WeeklyLeaderboardRead>;
```

The implementation calls `getDailyWeekWindow(this.nowSeconds())` and delegates its two date boundaries to the repository.

Add one public route:

```text
GET /api/blackjack-daily/weekly-leaderboard?limit=50
```

The HTTP handler:

- allows guests;
- reuses existing leaderboard limit validation `1..50`, default `50`;
- accepts no week/date parameter;
- uses the existing `no-store` JSON response;
- strips repository-only fields.

Public types:

```ts
export interface WeeklyLeaderboardPublicEntry {
  readonly rank: number;
  readonly playerName: string;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
}

export interface WeeklyCurrentUserPublicStanding {
  readonly rank: number;
  readonly totalEligible: number;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
}

export interface WeeklyLeaderboardPublicView {
  readonly entries: readonly WeeklyLeaderboardPublicEntry[];
  readonly currentUser: WeeklyCurrentUserPublicStanding | null;
}
```

The Astro file remains a thin adapter matching the existing Daily leaderboard route.

## UI design

Keep today's board unchanged and add a second section immediately after it:

- eyebrow: `This Week`;
- heading: `Weekly Results`;
- helper: `Monday–Sunday · UTC`;
- row: `#1 Alice 3,450 pts · 3/7 days`;
- current standing: `#4 of 12 · 2,100 pts · 2/7 days`.

Weekly score is intentionally points rather than `$` chips. Add one formatter beside `formatCurrency`:

```ts
export function formatPoints(value: number): string {
  return new Intl.NumberFormat('en-US').format(value);
}
```

Use the same formatter for weekly row and standing copy. Unit tests pin its exact formatting. E2E may reuse it for wiring expectations; formatter correctness remains a unit-test responsibility.

Weekly rows use:

```text
data-testid="daily-challenge-weekly-leaderboard-row"
```

### Required DOM contract

`createDailyRunRenderer` eagerly resolves required elements through `requireElement`. Weekly nodes are part of the page contract and stay required.

Update the shared `makeRoot(...)` fixture in `daily-ui.test.ts` with:

```text
daily-challenge-weekly-current-standing
daily-challenge-weekly-error
daily-challenge-weekly-leaderboard-rows
```

Do not make weekly nodes optional merely to preserve old tests.

### Empty and error states

Empty week:

```text
No results yet this week.
```

Render that as one list item inside the weekly rows container so the section never looks like a broken empty box.

Weekly malformed payload/request failure:

```text
Weekly leaderboard is unavailable — refresh to retry.
```

Show it only in the weekly section. Do not route weekly failures through the general gameplay `renderError` surface.

No retries, backoff, persistence, or offline cache.

## Testing strategy

### Week-window unit tests

Pin:

- Monday boundary;
- Sunday late UTC;
- next Monday rollover;
- `2027-01-01` -> `2026-12-28`..<`2027-01-04`;
- invalid time values.

### Repository integration tests — authoritative ranking proof

Use the real existing seam:

- `createBlackjackRunTestD1` + `insertTestUser` from `src/server/blackjack-run/test-d1.ts`;
- local `dailyStartInput(...)` in `repository.integration.test.ts`;
- `repository.createDailyRun(...)`;
- `repository.finishRun(...)` with explicit `nowSeconds`.

Do not claim `test-d1.ts` provides Daily creation/finish helpers; it does not.

Repository tests prove:

- multiple users and multiple days;
- previous-week exclusion;
- Ranked/non-completed exclusion;
- score/day/round aggregation;
- all five tie-breakers;
- exact remaining tie determinism;
- top limit;
- out-of-top current user;
- `totalEligible` is participant count and comes from the same query.

### Service/HTTP tests

Verify current range derivation, guest access, limit validation, absence of historical parameters, public projection, and authenticated current standing.

### Daily UI tests

Verify:

- `makeRoot` contains all required weekly elements;
- strict weekly payload parsing;
- `formatPoints`;
- weekly rows and current standing;
- `totalEligible` appears in standing copy;
- empty-week copy;
- weekly-local request/payload failure;
- guest weekly request.

### E2E — real product wiring only

Extend the existing Daily Challenge journey without adding a seed endpoint, direct D1 writer, or weekly `page.route` fake.

Verify:

- guest requests the real weekly endpoint and sees the section;
- existing Practice/Ranked/today-board journey remains intact;
- after today's real completion, `currentUser` has `daysPlayed = 1` and `weeklyScore` equal to today's ending bankroll;
- current-standing DOM shows `1/7 days`;
- only if `currentUser.rank <= 50`, assert a matching top row. Persistent local D1 data may push the fresh user outside the top 50, so the row is not unconditional.

Multi-day ordering and out-of-top behavior remain repository tests.

## Risks and mitigations

- **Ranking semantics drift:** one D1 statement owns aggregation, ranking, participant count, top rows, and current user.
- **Wrong test seam:** repository tests use their local `dailyStartInput` plus repository methods; no nonexistent test helper is referenced.
- **Page/test fixture drift:** weekly DOM elements remain required and `makeRoot` is updated before renderer assertions.
- **Persistent E2E history:** current standing is authoritative; top-row assertion is conditional on rank <= 50.
- **Scope creep hidden inside existing files:** final review uses an exact changed-file allowlist plus manual runtime diff inspection; schema/migration files are hard-rejected.

## Expected implementation surface

- `src/lib/blackjack-run/daily.ts`
- `src/lib/blackjack-run/daily.test.ts`
- `src/server/blackjack-run/repository.ts`
- `src/server/blackjack-run/repository.integration.test.ts`
- `src/server/blackjack-run/service.ts`
- `src/server/blackjack-run/service.test.ts`
- `src/server/blackjack-run/http.ts`
- `src/server/blackjack-run/http.test.ts`
- `src/pages/api/blackjack-daily/weekly-leaderboard.ts`
- `src/lib/blackjack-run/daily-ui.ts`
- `src/lib/blackjack-run/daily-ui.test.ts`
- `src/pages/games/daily-challenge.astro`
- `e2e/daily-challenge.spec.ts`

No database schema or migration file should change.

## Validation

Focused:

```bash
bun test src/lib/blackjack-run/daily.test.ts
bun test src/server/blackjack-run/repository.integration.test.ts
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
bun test src/lib/blackjack-run/daily-ui.test.ts
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Final:

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Final scope review must confirm:

- no `src/db/schema.ts` or migration changes;
- only the planned runtime/test files plus the two HPA-177 planning files changed;
- no historical period input, generic period framework, cache, scheduled job, reward/wallet mutation, or test seed path appears in the runtime diff.

## Scope guardrails

Do not add old Daily adapters, monthly boards, seasons, divisions, rewards, cosmetics, notifications, history UI, week picker, snapshots, cron, caches, compatibility work, generic period infrastructure, production test seed endpoints, direct Playwright D1 writers, or weekly response stubs.

If the implementation needs more than a bounded aggregate query plus a second read-only projection, simplify before merge.
