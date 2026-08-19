# HPA-177 Weekly Daily Challenge Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only current UTC week leaderboard for unified Blackjack Daily Challenge results on the existing Daily Challenge page.

**Architecture:** Extend the existing `blackjack-run` Daily read model rather than introducing competition infrastructure. Derive the current Monday-to-Monday UTC window from existing mission week helpers, aggregate completed Daily rows directly from `blackjack_run`, expose one guest-readable current-week endpoint, and render a second independent leaderboard section on `/games/daily-challenge`.

**Tech Stack:** Astro, TypeScript, Bun tests, Cloudflare D1/SQLite, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-18-weekly-daily-leaderboard-design.md`

## Global Constraints

- One implementation PR for HPA-177; do not split the ticket across multiple PRs.
- Current UTC week only: Monday 00:00 UTC through next Monday 00:00 UTC.
- Weekly score is `SUM(dailyEndingBankroll)` over completed unified Daily rows in the current week.
- Deterministic order is weekly score DESC, days played DESC, total rounds DESC, last settlement ASC, user id ASC.
- Reuse `blackjack_run`; no schema change, migration, snapshot table, cache, cron, queue, or Durable Object.
- No historical week picker/API, monthly board, rewards, seasons, leagues, generic period leaderboard framework, or old Daily compatibility.
- Keep existing Daily Challenge gameplay and today's leaderboard behavior unchanged.
- Weekly read failures must be local to the weekly section and must not overwrite gameplay or today's-board status.
- Do not add a production seed endpoint, direct Playwright D1 writer, or weekly `page.route` JSON fake.

## Proof boundaries

The repository already has two different testing seams and this plan keeps them separate:

- **Repository integration tests own multi-user/multi-day SQL semantics.** They may use `src/server/blackjack-run/test-d1.ts` to seed multiple users, multiple period keys, prior-week rows, and current-user-outside-top fixtures.
- **Playwright owns real product wiring.** `e2e/daily-challenge.spec.ts` plays today's real Daily attempt through the product API. It does not have a multi-day seed helper and must not grow one for this feature.

This avoids a fake E2E that only proves a stubbed JSON response while claiming to prove weekly aggregation.

---

### Task 1: Define the current Daily week window

**Files:**
- Modify: `src/lib/blackjack-run/daily.ts`
- Modify: `src/lib/blackjack-run/daily.test.ts`

**Interfaces:**
- Consumes: `getDailyPeriodKey(date)`, `getWeeklyPeriodKey(date)`, and `getNextWeeklyReset(date)` from `src/lib/missions/periods.ts`.
- Produces:

```ts
export interface DailyWeekWindow {
  readonly weekKey: string;
  readonly startPeriodKey: string;
  readonly endPeriodKeyExclusive: string;
}

export function getDailyWeekWindow(nowSeconds: number): DailyWeekWindow;
```

- [ ] **Step 1: Add failing UTC week-window tests**

Add these cases to `src/lib/blackjack-run/daily.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { getDailyWeekWindow } from './daily';

describe('getDailyWeekWindow', () => {
  test('uses Monday 00:00 UTC through the next Monday', () => {
    const monday = Math.trunc(Date.parse('2026-08-17T00:00:00.000Z') / 1000);
    expect(getDailyWeekWindow(monday)).toEqual({
      weekKey: '2026-W34',
      startPeriodKey: '2026-08-17',
      endPeriodKeyExclusive: '2026-08-24',
    });
  });

  test('keeps Sunday night in the same UTC week', () => {
    const sunday = Math.trunc(Date.parse('2026-08-23T23:59:59.000Z') / 1000);
    expect(getDailyWeekWindow(sunday)).toEqual({
      weekKey: '2026-W34',
      startPeriodKey: '2026-08-17',
      endPeriodKeyExclusive: '2026-08-24',
    });
  });

  test('rolls over exactly at Monday 00:00 UTC', () => {
    const nextMonday = Math.trunc(Date.parse('2026-08-24T00:00:00.000Z') / 1000);
    expect(getDailyWeekWindow(nextMonday)).toEqual({
      weekKey: '2026-W35',
      startPeriodKey: '2026-08-24',
      endPeriodKeyExclusive: '2026-08-31',
    });
  });

  test('keeps ISO week year separate from calendar date boundaries', () => {
    const friday = Math.trunc(Date.parse('2027-01-01T12:00:00.000Z') / 1000);
    expect(getDailyWeekWindow(friday)).toEqual({
      weekKey: '2026-W53',
      startPeriodKey: '2026-12-28',
      endPeriodKeyExclusive: '2027-01-04',
    });
  });

  test('rejects invalid time values', () => {
    expect(() => getDailyWeekWindow(-1)).toThrow(TypeError);
    expect(() => getDailyWeekWindow(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
```

The year-boundary case is required: `weekKey` is ISO week-year, while SQL filters use calendar-date `periodKey` boundaries.

- [ ] **Step 2: Run the focused test and verify failure**

```bash
bun test src/lib/blackjack-run/daily.test.ts
```

Expected: FAIL because `getDailyWeekWindow` does not exist.

- [ ] **Step 3: Implement the minimal week helper**

Extend the import in `src/lib/blackjack-run/daily.ts`:

```ts
import {
  getDailyPeriodKey,
  getNextWeeklyReset,
  getWeeklyPeriodKey,
} from '../missions/periods';
```

Add:

```ts
export interface DailyWeekWindow {
  readonly weekKey: string;
  readonly startPeriodKey: string;
  readonly endPeriodKeyExclusive: string;
}

export function getDailyWeekWindow(nowSeconds: number): DailyWeekWindow {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new TypeError('Daily time must be a non-negative safe integer');
  }

  const now = new Date(nowSeconds * 1000);
  if (Number.isNaN(now.getTime())) {
    throw new RangeError('Daily time must resolve to a valid date');
  }

  const nextReset = getNextWeeklyReset(now);
  const start = new Date(nextReset);
  start.setUTCDate(start.getUTCDate() - 7);

  return {
    weekKey: getWeeklyPeriodKey(now),
    startPeriodKey: getDailyPeriodKey(start),
    endPeriodKeyExclusive: getDailyPeriodKey(nextReset),
  };
}
```

Do not add another generic week/calendar helper.

- [ ] **Step 4: Run the focused tests**

```bash
bun test src/lib/blackjack-run/daily.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blackjack-run/daily.ts src/lib/blackjack-run/daily.test.ts
git commit -m "feat(daily): define current UTC week window"
```

---

### Task 2: Add bounded weekly aggregation to the Blackjack Run repository

**Files:**
- Modify: `src/server/blackjack-run/repository.ts`
- Modify: `src/server/blackjack-run/repository.integration.test.ts`

**Interfaces:**
- Consumes: canonical `YYYY-MM-DD` start/end period keys from the service caller.
- Produces:

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

listWeeklyLeaderboard(
  startPeriodKey: string,
  endPeriodKeyExclusive: string,
  limit: number,
  userId?: string | null,
): Promise<WeeklyLeaderboardRead>;
```

- [ ] **Step 1: Add failing repository integration coverage**

Use the existing `insertTestUser`, Daily-run creation, and finish helpers from `src/server/blackjack-run/test-d1.ts` to seed:

```text
Alice:
  2026-08-17 -> ending 1200, rounds 10
  2026-08-18 -> ending 900, rounds 8
  weekly = 2100, days = 2, rounds = 18

Bob:
  2026-08-18 -> ending 2200, rounds 10
  weekly = 2200, days = 1, rounds = 10

Carol:
  two completed current-week rows totaling 2100 with fewer than 18 total rounds

Dave:
  one completed previous-week row
```

Also seed one current-week Ranked row and one non-completed Daily row. Neither may contribute.

Assert the bounded read:

```ts
const read = await repository.listWeeklyLeaderboard(
  '2026-08-17',
  '2026-08-24',
  2,
  carolId,
);

expect(read.entries.map((entry) => ({
  name: entry.playerName,
  score: entry.weeklyScore,
  days: entry.daysPlayed,
  rounds: entry.totalRounds,
}))).toEqual([
  { name: 'Bob', score: 2200, days: 1, rounds: 10 },
  { name: 'Alice', score: 2100, days: 2, rounds: 18 },
]);

expect(read.currentUser).toMatchObject({
  rank: 3,
  totalEligible: 3,
  weeklyScore: 2100,
  daysPlayed: 2,
});
```

Add focused tie fixtures proving:

1. equal score -> more days wins;
2. equal score/days -> more rounds wins;
3. equal score/days/rounds -> earlier `MAX(settledAt)` wins;
4. exact remaining tie -> ascending `userId` wins.

Because `userId` is inside the `RANK()` order, exact final ties must still produce distinct deterministic ranks. Repeat the read and assert the same order/ranks.

This task is the authoritative proof for multi-day aggregation, previous-week exclusion, deterministic weekly order, and current-user standing outside the top limit.

- [ ] **Step 2: Run repository integration tests and verify failure**

```bash
bun test src/server/blackjack-run/repository.integration.test.ts
```

Expected: FAIL because weekly repository interfaces do not exist.

- [ ] **Step 3: Add weekly types and repository contract**

Add the interfaces above beside the existing Daily leaderboard types and extend `BlackjackRunRepository` with `listWeeklyLeaderboard(...)` exactly as specified.

- [ ] **Step 4: Implement one shared weekly aggregate/rank CTE**

Define a single CTE semantic source:

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
    AND r.periodKey >= ?
    AND r.periodKey < ?
  GROUP BY r.userId, u.name
), ranked AS (
  SELECT
    *,
    RANK() OVER (
      ORDER BY
        weeklyScore DESC,
        daysPlayed DESC,
        totalRounds DESC,
        lastSettledAt ASC,
        userId ASC
    ) AS rank
  FROM weekly
)
```

Reuse the same CTE/order for:

- top rows with `LIMIT ?`;
- current-user row by `userId = ?`;
- total eligible participant count.

Do not copy the existing Daily leaderboard's separate `RANK()` definitions; that is the drift this weekly read should avoid.

Validate numeric fields with repository invariants:

- `weeklyScore`, `daysPlayed`, `totalRounds`, `lastSettledAt`: safe non-negative integers;
- `rank`, `totalEligible`: positive safe integers.

Do not add or modify indexes.

- [ ] **Step 5: Run repository integration tests**

```bash
bun test src/server/blackjack-run/repository.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/blackjack-run/repository.ts src/server/blackjack-run/repository.integration.test.ts
git commit -m "feat(daily): aggregate current-week leaderboard"
```

---

### Task 3: Expose one current-week public API

**Files:**
- Modify: `src/server/blackjack-run/service.ts`
- Modify: `src/server/blackjack-run/service.test.ts`
- Modify: `src/server/blackjack-run/http.ts`
- Modify: `src/server/blackjack-run/http.test.ts`
- Create: `src/pages/api/blackjack-daily/weekly-leaderboard.ts`

**Interfaces:**
- Consumes: `getDailyWeekWindow(nowSeconds)` and `repository.listWeeklyLeaderboard(...)`.
- Produces:

```ts
weeklyLeaderboard(
  userId: string | null,
  limit: number,
): Promise<WeeklyLeaderboardRead>;
```

Endpoint:

```text
GET /api/blackjack-daily/weekly-leaderboard?limit=50
```

Public shape:

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

- [ ] **Step 1: Add failing service tests**

Freeze `now()` at `2026-08-18T12:00:00Z` and assert:

```ts
await service.weeklyLeaderboard(userId, 25);
expect(repository.listWeeklyLeaderboard).toHaveBeenCalledWith(
  '2026-08-17',
  '2026-08-24',
  25,
  userId,
);
```

Add the guest variant and assert `null` is passed through unchanged.

- [ ] **Step 2: Add failing HTTP tests**

Extend the fake service with `weeklyLeaderboard` and verify:

- guest request succeeds;
- default limit is `50`;
- `?limit=1` succeeds;
- `?limit=0`, `?limit=51`, and non-numeric limits return `400 INVALID_REQUEST`;
- entries strip repository-only `userId` and `lastSettledAt`;
- authenticated `currentUser` survives projection;
- no week/date/period input is accepted because the route has no such parameter.

Use a fake entry with `userId: 'internal-user-id'` and assert serialized JSON does not contain it.

- [ ] **Step 3: Run service/HTTP tests and verify failure**

```bash
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
```

Expected: FAIL because weekly service/handler surfaces are missing.

- [ ] **Step 4: Implement service delegation**

Add:

```ts
async weeklyLeaderboard(
  userId: string | null,
  limit: number,
): Promise<WeeklyLeaderboardRead> {
  const week = getDailyWeekWindow(this.nowSeconds());
  return this.repository.listWeeklyLeaderboard(
    week.startPeriodKey,
    week.endPeriodKeyExclusive,
    limit,
    userId,
  );
}
```

Do not accept a week key from callers.

- [ ] **Step 5: Implement HTTP projection and handler**

Reuse the existing leaderboard limit constants and `parseLimit` helper.

```ts
function projectWeeklyLeaderboard(read: WeeklyLeaderboardRead): WeeklyLeaderboardPublicView {
  return {
    entries: read.entries.map((entry) => ({
      rank: entry.rank,
      playerName: entry.playerName,
      weeklyScore: entry.weeklyScore,
      daysPlayed: entry.daysPlayed,
      totalRounds: entry.totalRounds,
    })),
    currentUser: read.currentUser,
  };
}
```

Handler:

```ts
const weeklyLeaderboard: APIRoute = async ({ locals, url }) => {
  try {
    const userId = optionalUserId(locals);
    const limit = parseLimit(
      url.searchParams.get('limit'),
      LEADERBOARD_MIN_LIMIT,
      LEADERBOARD_MAX_LIMIT,
      LEADERBOARD_DEFAULT_LIMIT,
    );
    const service = serviceFor(deps, locals);
    return jsonSuccess(
      projectWeeklyLeaderboard(await service.weeklyLeaderboard(userId, limit)),
    );
  } catch (error) {
    return blackjackRunJsonError(error);
  }
};
```

Add `weeklyLeaderboard` to `BlackjackRunHttpHandlers` and return it from `createBlackjackRunHttpHandlers`.

- [ ] **Step 6: Add the thin Astro API route**

Create `src/pages/api/blackjack-daily/weekly-leaderboard.ts` using the exact sibling adapter shape:

```ts
import type { APIRoute } from 'astro';
import { blackjackRunHttpHandlers } from '../../../server/blackjack-run/http';

export const GET: APIRoute = blackjackRunHttpHandlers.weeklyLeaderboard;
```

No route-local parsing or service construction.

- [ ] **Step 7: Run service/HTTP tests**

```bash
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add \
  src/server/blackjack-run/service.ts \
  src/server/blackjack-run/service.test.ts \
  src/server/blackjack-run/http.ts \
  src/server/blackjack-run/http.test.ts \
  src/pages/api/blackjack-daily/weekly-leaderboard.ts
git commit -m "feat(daily): expose current-week leaderboard"
```

---

### Task 4: Render the weekly board independently on Daily Challenge

**Files:**
- Modify: `src/lib/blackjack-run/daily-ui.ts`
- Modify: `src/lib/blackjack-run/daily-ui.test.ts`
- Modify: `src/pages/games/daily-challenge.astro`

**Interfaces:**
- Consumes endpoint from Task 3.
- Produces:

```ts
export const DAILY_WEEKLY_LEADERBOARD_PATH = '/api/blackjack-daily/weekly-leaderboard';

export interface WeeklyLeaderboardEntryView {
  readonly rank: number;
  readonly playerName: string;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
  readonly totalRounds: number;
}

export interface WeeklyCurrentUserStandingView {
  readonly rank: number;
  readonly totalEligible: number;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
  readonly totalRounds: number;
}

export interface WeeklyLeaderboardView {
  readonly entries: readonly WeeklyLeaderboardEntryView[];
  readonly currentUser: WeeklyCurrentUserStandingView | null;
}

export function parseWeeklyLeaderboardView(payload: unknown): WeeklyLeaderboardView;
```

`DailyRunRenderer` gains:

```ts
renderWeeklyLeaderboard(leaderboard: WeeklyLeaderboardView): void;
renderWeeklyLeaderboardError(message: string): void;
```

- [ ] **Step 1: Add failing parser/renderer tests**

Parse this valid payload:

```ts
{
  entries: [{
    rank: 1,
    playerName: 'Alice',
    weeklyScore: 3450,
    daysPlayed: 3,
    totalRounds: 28,
  }],
  currentUser: {
    rank: 4,
    totalEligible: 12,
    weeklyScore: 2100,
    daysPlayed: 2,
    totalRounds: 18,
  },
}
```

Assert malformed/non-integer/negative weekly score, days, rounds, rank, and total eligible are rejected.

Add DOM fixtures for:

```text
daily-challenge-weekly-leaderboard-rows
daily-challenge-weekly-current-standing
daily-challenge-weekly-error
```

Expected row:

```text
#1 Alice 3,450 pts · 3/7 days
```

Expected current standing:

```text
#4 · 2,100 pts · 2/7 days
```

Verify `renderWeeklyLeaderboardError(...)` changes only `daily-challenge-weekly-error`; it must not modify `daily-challenge-status` or today's leaderboard DOM.

- [ ] **Step 2: Add failing page-bootstrap request tests**

Extend the existing `initDailyChallengePage` transport mocks to expect both public reads:

```text
/api/blackjack-daily/<periodKey>/leaderboard
/api/blackjack-daily/weekly-leaderboard
```

Verify independently:

- both success -> both render;
- daily success + weekly failure -> daily remains rendered and weekly error is visible;
- guest mode still issues the weekly request.

- [ ] **Step 3: Run Daily UI tests and verify failure**

```bash
bun test src/lib/blackjack-run/daily-ui.test.ts
```

Expected: FAIL because the weekly parser/renderer/DOM do not exist.

- [ ] **Step 4: Add weekly markup to `daily-challenge.astro`**

Immediately after the existing `data-testid="daily-challenge-leaderboard"` section add:

```astro
<section class="mb-10" data-testid="daily-challenge-weekly-leaderboard">
  <div class="mb-4">
    <p class="deco-section-eyebrow">This Week</p>
    <h2 class="deco-section-title text-3xl">Weekly Results</h2>
    <p class="mt-2 text-sm text-[var(--deco-muted)]">Monday–Sunday · UTC</p>
  </div>
  <p
    data-testid="daily-challenge-weekly-current-standing"
    class="mb-3 inline-block rounded-lg border border-[var(--deco-brass-dim)] bg-[var(--deco-obsidian-2)] px-4 py-2 text-sm font-semibold text-[var(--deco-brass)]"
    hidden
  ></p>
  <p
    data-testid="daily-challenge-weekly-error"
    role="status"
    class="mb-3 text-sm text-[var(--deco-muted)]"
    hidden
  ></p>
  <ol
    data-testid="daily-challenge-weekly-leaderboard-rows"
    class="divide-y divide-[var(--deco-line)] rounded-xl border border-[var(--deco-line)] bg-[var(--deco-obsidian-2)]"
  ></ol>
</section>
```

Do not add tabs, navigation, a new page, or a week picker.

- [ ] **Step 5: Implement strict weekly parsing and rendering**

Use the existing `parseSafeInteger` helper for weekly integer fields.

For each row, mirror the existing Daily renderer test seam and then set its copy:

```ts
const row = document.createElement('li');
row.dataset.testid = 'daily-challenge-weekly-leaderboard-row';
row.textContent =
  `#${entry.rank} ${entry.playerName} ${entry.weeklyScore.toLocaleString('en-US')} pts · ${entry.daysPlayed}/7 days`;
```

Current standing:

```ts
currentWeeklyStandingEl.textContent =
  `#${rank} · ${weeklyScore.toLocaleString('en-US')} pts · ${daysPlayed}/7 days`;
```

On success, clear/hide the weekly error. Do not touch the Daily gameplay status.

- [ ] **Step 6: Fetch the weekly endpoint independently**

Keep the existing Daily leaderboard fetch intact and add a separate weekly block:

```ts
try {
  const { response, data } = await fetchJsonWithTimeout(
    DAILY_WEEKLY_LEADERBOARD_PATH,
    { method: 'GET' },
    timeoutMs,
  );
  if (!response.ok) {
    throw new TypeError(`Weekly leaderboard request failed (${response.status})`);
  }
  renderer.renderWeeklyLeaderboard(parseWeeklyLeaderboardView(data));
} catch (error) {
  console.error('Weekly leaderboard fetch failed', error);
  renderer.renderWeeklyLeaderboardError(
    'Weekly leaderboard is unavailable — refresh to retry.',
  );
}
```

Do not route weekly failures through `renderer.renderError`.

- [ ] **Step 7: Run Daily UI tests**

```bash
bun test src/lib/blackjack-run/daily-ui.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add \
  src/lib/blackjack-run/daily-ui.ts \
  src/lib/blackjack-run/daily-ui.test.ts \
  src/pages/games/daily-challenge.astro
git commit -m "feat(daily): show current-week leaderboard"
```

---

### Task 5: Extend the real Daily Challenge journey and run final validation

**Files:**
- Modify: `e2e/daily-challenge.spec.ts`
- Verify unchanged: `src/db/schema.ts`
- Verify unchanged: repository migration files

**Interfaces:**
- Consumes the complete Task 1–4 feature.
- Produces no runtime interface and no test-only production endpoint.

- [ ] **Step 1: Add a weekly request matcher to the existing E2E**

Beside `isDailyLeaderboard`, add:

```ts
const WEEKLY_LEADERBOARD_PATH = '/api/blackjack-daily/weekly-leaderboard';

function isWeeklyLeaderboard(url: string, method: string): boolean {
  return pathname(url) === WEEKLY_LEADERBOARD_PATH && method === 'GET';
}
```

Do not add `page.route`, D1 writes, or seed helpers.

- [ ] **Step 2: Verify the guest journey uses the real weekly endpoint**

In the existing guest page-load portion, wait for the weekly response alongside the current Daily/leaderboard reads:

```ts
const guestWeeklyResponse = page.waitForResponse((response) =>
  isWeeklyLeaderboard(response.url(), response.request().method()),
);

await page.goto(DAILY_CHALLENGE_PAGE);

expect((await guestWeeklyResponse).ok()).toBe(true);
await expect(page.getByTestId('daily-challenge-weekly-leaderboard')).toBeVisible();
await expect(page.getByTestId('daily-challenge-weekly-error')).toBeHidden();
```

Keep the existing guest Practice assertions intact.

- [ ] **Step 3: Verify today's real completed attempt appears in the weekly projection**

After the existing ranked completion obtains `receiptBankroll`, extend the same reload that already verifies today's leaderboard. Wait for both leaderboard responses:

```ts
const dailyLeaderboardReload = page.waitForResponse((response) =>
  isDailyLeaderboard(response.url(), response.request().method()),
);
const weeklyLeaderboardReload = page.waitForResponse((response) =>
  isWeeklyLeaderboard(response.url(), response.request().method()),
);

await page.reload({ waitUntil: 'domcontentloaded' });

const dailyLeaderboardResponse = await dailyLeaderboardReload;
const weeklyLeaderboardResponse = await weeklyLeaderboardReload;
expect(dailyLeaderboardResponse.ok()).toBe(true);
expect(weeklyLeaderboardResponse.ok()).toBe(true);
```

Parse the weekly response:

```ts
const weekly = (await weeklyLeaderboardResponse.json()) as {
  entries: Array<{
    weeklyScore: number;
    daysPlayed: number;
    totalRounds: number;
  }>;
  currentUser: {
    rank: number;
    totalEligible: number;
    weeklyScore: number;
    daysPlayed: number;
    totalRounds: number;
  } | null;
};

expect(weekly.currentUser).not.toBeNull();
expect(weekly.currentUser).toMatchObject({
  weeklyScore: receiptBankroll as number,
  daysPlayed: 1,
  totalRounds: ROUND_COUNT,
});
```

Then assert the real DOM wiring:

```ts
const weeklyRank = weekly.currentUser!.rank;
await expect(page.getByTestId('daily-challenge-weekly-current-standing')).toHaveText(
  `#${weeklyRank} · ${(receiptBankroll as number).toLocaleString('en-US')} pts · 1/7 days`,
);

const matchingWeeklyRows = await page
  .getByTestId('daily-challenge-weekly-leaderboard-row')
  .filter({
    hasText: `${(receiptBankroll as number).toLocaleString('en-US')} pts · 1/7 days`,
  })
  .count();
expect(matchingWeeklyRows).toBeGreaterThanOrEqual(1);
```

Do **not** assert Alice/Bob multi-day order here. Task 2 already proves that with real D1 fixtures.

- [ ] **Step 4: Run the real Daily Challenge E2E**

```bash
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Expected: PASS with the existing Practice/Ranked/Daily-board journey plus the new real weekly request/render assertions.

- [ ] **Step 5: Run all focused HPA-177 tests**

```bash
bun test src/lib/blackjack-run/daily.test.ts
bun test src/server/blackjack-run/repository.integration.test.ts
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
bun test src/lib/blackjack-run/daily-ui.test.ts
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 6: Run repository-wide validation**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Step 7: Run scope guards**

```bash
if git diff --name-only main...HEAD | grep -Eq '(^src/db/schema\.ts$|^drizzle/|migration)'; then
  echo 'Unexpected schema/migration change'
  exit 1
fi

if git diff --name-only main...HEAD | grep -Eq '(season|snapshot|cron|reward|monthly)'; then
  echo 'Unexpected broad competition infrastructure'
  exit 1
fi

rg -n "page\.route|seed.*endpoint|weekly.*seed" e2e/daily-challenge.spec.ts src/pages/api src/server/blackjack-run \
  && echo 'Review matches manually; reject any HPA-177-only test backdoor' \
  || true

git diff --name-only main...HEAD
```

Expected implementation/test surface is limited to the files named by this plan plus the two HPA-177 planning documents.

Inspect the final diff and reject any new generic period-leaderboard abstraction, historical week API, cache, scheduled job, wallet mutation, production seed endpoint, direct Playwright D1 writer, or weekly response stub.

- [ ] **Step 8: Commit the E2E slice**

```bash
git add e2e/daily-challenge.spec.ts
git commit -m "test(daily): cover weekly leaderboard journey"
```

- [ ] **Step 9: Update the existing HPA-177 draft PR, not a second PR**

Push this same branch and keep the existing draft PR as the single implementation/design PR for HPA-177. Update its description with:

- weekly score/order semantics;
- actual implementation files;
- validation results;
- explicit confirmation that no schema/migration/cron/reward/history/general leaderboard framework/test seed path was added.

Do not open another PR for implementation.

---

## Post-merge Linear closeout

After the implementation PR merges:

1. re-fetch HPA-177;
2. add one concise comment with the merged PR and shipped scope;
3. mark HPA-177 Done;
4. verify HPA-167 remains Done and no broader competition roadmap is reopened.

Do not create a replacement season/competition epic as part of closeout.