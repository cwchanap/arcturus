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

---

### Task 1: Define the current Daily week window

**Files:**
- Modify: `src/lib/blackjack-run/daily.ts`
- Modify: `src/lib/blackjack-run/daily.test.ts`

**Interfaces:**
- Consumes: `getWeeklyPeriodKey(date)` and `getNextWeeklyReset(date)` from `src/lib/missions/periods.ts`.
- Produces:

```ts
export interface DailyWeekWindow {
  readonly weekKey: string;
  readonly startPeriodKey: string;
  readonly endPeriodKeyExclusive: string;
}

export function getDailyWeekWindow(nowSeconds: number): DailyWeekWindow;
```

- [ ] **Step 1: Add failing week-boundary tests**

Add tests in `src/lib/blackjack-run/daily.test.ts` that pin exact UTC boundaries:

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
});
```

Also add an invalid-time test matching `getDailyWindow`'s non-negative safe-integer contract.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```bash
bun test src/lib/blackjack-run/daily.test.ts
```

Expected: FAIL because `getDailyWeekWindow` does not exist.

- [ ] **Step 3: Implement the minimal week helper**

In `src/lib/blackjack-run/daily.ts`, extend the existing mission-period import:

```ts
import {
  getDailyPeriodKey,
  getNextWeeklyReset,
  getWeeklyPeriodKey,
} from '../missions/periods';
```

Implement:

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

Do not add a second general-purpose week helper elsewhere.

- [ ] **Step 4: Run the focused tests**

Run:

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
- Consumes: canonical `YYYY-MM-DD` start/end period keys from Task 1's service caller.
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

In `repository.integration.test.ts`, seed users and `blackjack_run` rows covering:

- Alice: two completed Daily rows in `2026-08-17..23` with ending bankrolls `1200` and `900`, rounds `10` and `8`.
- Bob: one completed Daily row in the same week with ending bankroll `2200`, rounds `10`.
- Carol: two completed rows summing to Alice's `2100` but fewer total rounds.
- Dave: a completed Daily row in the previous week.
- one Ranked row in the current week.
- one active/forfeited Daily row in the current week.

Assert:

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

Add focused fixtures proving the remaining tie order:

1. equal score -> more days wins;
2. equal score/days -> more rounds wins;
3. equal score/days/rounds -> earlier `MAX(settledAt)` wins;
4. exact remaining tie -> ascending `userId` wins deterministically.

The exact-tie assertion should verify stable ranks/order across repeated calls.

- [ ] **Step 2: Run repository integration tests and verify failure**

Run:

```bash
bun test src/server/blackjack-run/repository.integration.test.ts
```

Expected: FAIL because `listWeeklyLeaderboard` and weekly types do not exist.

- [ ] **Step 3: Add weekly types and repository contract**

Add the interfaces above beside the existing Daily leaderboard types. Extend `BlackjackRunRepository` with `listWeeklyLeaderboard(...)` exactly as specified.

- [ ] **Step 4: Implement one weekly aggregate/rank CTE**

In `repository.ts`, define a shared SQL fragment/constant with this semantic shape:

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

Use it for:

- top rows ordered by the same five keys and `LIMIT ?`;
- current-user row by `userId = ?`;
- total eligible as the participant count, not source-row count.

Validate every numeric field with the same invariant discipline used by the existing Daily leaderboard reader. `weeklyScore`, `daysPlayed`, `totalRounds`, and `lastSettledAt` must be safe non-negative integers; `rank` and `totalEligible` must be positive safe integers.

Do not add or modify indexes in this task.

- [ ] **Step 5: Run repository integration tests**

Run:

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
- Consumes: `getDailyWeekWindow(nowSeconds)` from Task 1 and `repository.listWeeklyLeaderboard(...)` from Task 2.
- Produces service method:

```ts
weeklyLeaderboard(
  userId: string | null,
  limit: number,
): Promise<WeeklyLeaderboardRead>;
```

- Produces endpoint:

```text
GET /api/blackjack-daily/weekly-leaderboard?limit=50
```

- Produces public entry shape:

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

In `service.test.ts`, add a repository spy for `listWeeklyLeaderboard` and freeze `now()` at `2026-08-18T12:00:00Z`.

Assert:

```ts
await service.weeklyLeaderboard(userId, 25);
expect(repository.listWeeklyLeaderboard).toHaveBeenCalledWith(
  '2026-08-17',
  '2026-08-24',
  25,
  userId,
);
```

Also assert `null` user id is passed through for guests.

- [ ] **Step 2: Add failing HTTP tests**

In `http.test.ts`, extend the fake service with `weeklyLeaderboard` and add tests proving:

- guest request succeeds;
- default limit is `50`;
- `?limit=1` works;
- `?limit=0`, `?limit=51`, non-numeric limit -> `400 INVALID_REQUEST`;
- response entries omit repository-only `userId` and `lastSettledAt`;
- authenticated `currentUser` survives projection;
- the handler has no `week`, `periodKey`, or historical-date input.

Use a fake repository-facing result containing `userId: 'internal-user-id'` and assert serialized JSON does not contain that value.

- [ ] **Step 3: Run focused service/HTTP tests and verify failure**

Run:

```bash
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
```

Expected: FAIL because weekly service/handler surfaces are missing.

- [ ] **Step 4: Implement service delegation**

Import `getDailyWeekWindow` and `WeeklyLeaderboardRead`. Add the interface method and implementation:

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

Reuse the existing leaderboard limit constants and `parseLimit` helper. Add `weeklyLeaderboard` to `BlackjackRunHttpHandlers` and return it from `createBlackjackRunHttpHandlers`.

Projection must be explicit:

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

Handler shape:

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
    return jsonSuccess(projectWeeklyLeaderboard(
      await service.weeklyLeaderboard(userId, limit),
    ));
  } catch (error) {
    return blackjackRunJsonError(error);
  }
};
```

- [ ] **Step 6: Add the thin Astro API route**

Create `src/pages/api/blackjack-daily/weekly-leaderboard.ts` matching the existing route adapter style:

```ts
import { blackjackRunHttpHandlers } from '../../../server/blackjack-run/http';

export const prerender = false;
export const GET = blackjackRunHttpHandlers.weeklyLeaderboard;
```

Adjust the relative import only if the existing sibling route demonstrates a different exact depth; copy that route's adapter pattern rather than adding logic here.

- [ ] **Step 7: Run service/HTTP tests**

Run:

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

In `daily-ui.test.ts`, add tests that parse:

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

Add DOM tests requiring these new test IDs:

```text
daily-challenge-weekly-leaderboard-rows
daily-challenge-weekly-current-standing
daily-challenge-weekly-error
```

Expected row text:

```text
#1 Alice 3,450 pts · 3/7 days
```

Expected current standing:

```text
#4 · 2,100 pts · 2/7 days
```

Verify `renderWeeklyLeaderboardError(...)` changes only `daily-challenge-weekly-error`; it must not modify `daily-challenge-status` or today's leaderboard DOM.

- [ ] **Step 2: Add failing page-bootstrap request tests**

Extend the existing `initDailyChallengePage` transport mocks to expect both public leaderboard reads:

```text
/api/blackjack-daily/<periodKey>/leaderboard
/api/blackjack-daily/weekly-leaderboard
```

Test independently:

- both success -> both render;
- daily success + weekly failure -> daily remains rendered, weekly error visible;
- guest mode still issues weekly request.

- [ ] **Step 3: Run Daily UI tests and verify failure**

Run:

```bash
bun test src/lib/blackjack-run/daily-ui.test.ts
```

Expected: FAIL because the weekly parser/renderer/DOM do not exist.

- [ ] **Step 4: Add weekly markup to `daily-challenge.astro`**

Immediately after the existing `data-testid="daily-challenge-leaderboard"` section, add one section with:

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

Do not add tabs, navigation, a new page, or week picker.

- [ ] **Step 5: Implement strict weekly parsing and rendering**

Use the existing `parseSafeInteger` helper for weekly integer fields. Add a weekly parser that does not accept Daily-specific field aliases.

Renderer row copy:

```ts
row.textContent = `#${entry.rank} ${entry.playerName} ${entry.weeklyScore.toLocaleString('en-US')} pts · ${entry.daysPlayed}/7 days`;
```

Current standing copy:

```ts
currentWeeklyStandingEl.textContent =
  `#${rank} · ${weeklyScore.toLocaleString('en-US')} pts · ${daysPlayed}/7 days`;
```

Clear/hide the weekly error on successful weekly render.

- [ ] **Step 6: Fetch the weekly endpoint independently**

At the end of `initDailyChallengePage`, keep the existing daily leaderboard fetch intact and add a separate weekly block:

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

Do not route this error through `renderer.renderError`.

- [ ] **Step 7: Run Daily UI tests**

Run:

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

### Task 5: Add the populated-board E2E and run final validation

**Files:**
- Modify: `e2e/daily-challenge.spec.ts`
- Verify unchanged: `src/db/schema.ts`
- Verify unchanged: `drizzle/` or repository migration directory used by this project

**Interfaces:**
- Consumes the complete Task 1–4 feature.
- Produces no new runtime interface.

- [ ] **Step 1: Add a failing populated weekly-board E2E**

Reuse the existing Daily Challenge DB/setup helpers in `e2e/daily-challenge.spec.ts`; do not add a production-only seed endpoint.

Freeze or derive the test week using the same deterministic date approach already used by the file. Seed multiple completed unified Daily `blackjack_run` rows:

```text
Alice: 1200 + 900 = 2100, 2 days
Bob: 2200, 1 day
Current user: 800 + 700 = 1500, 2 days
```

Constrain the weekly HTTP response to a top limit below the current user's rank using the existing request interception pattern if needed; do not add a production `limit` UI.

Assert:

```ts
await expect(page.getByTestId('daily-challenge-weekly-leaderboard-row').nth(0))
  .toContainText('#1 Bob 2,200 pts · 1/7 days');
await expect(page.getByTestId('daily-challenge-weekly-leaderboard-row').nth(1))
  .toContainText('#2 Alice 2,100 pts · 2/7 days');
await expect(page.getByTestId('daily-challenge-weekly-current-standing'))
  .toContainText('#3 · 1,500 pts · 2/7 days');
```

Also assert today's leaderboard still renders in the same page session.

- [ ] **Step 2: Run the E2E and verify failure before final runtime changes are complete**

Run:

```bash
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Expected before Tasks 1–4 are present: FAIL on missing weekly UI. If executing tasks sequentially and Tasks 1–4 are already complete, first confirm the new test fails on an intentionally wrong expected weekly score/order, then restore the correct expectation before proceeding.

- [ ] **Step 3: Run the populated Daily Challenge E2E**

Run:

```bash
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 4: Run all focused HPA-177 tests**

```bash
bun test src/lib/blackjack-run/daily.test.ts
bun test src/server/blackjack-run/repository.integration.test.ts
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
bun test src/lib/blackjack-run/daily-ui.test.ts
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 5: Run repository-wide validation**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Step 6: Run scope guards**

Check that no persistence or generic-framework work leaked in:

```bash
git diff --name-only main...HEAD | grep -E '(^src/db/schema\.ts$|^drizzle/|migration)' && exit 1 || true

git diff --name-only main...HEAD | grep -E '(season|snapshot|cron|reward|monthly)' && exit 1 || true

git diff --name-only main...HEAD
```

Expected runtime/test surface is limited to the files named by this plan plus the two HPA-177 planning documents already on the branch.

Inspect the final diff and reject any new generic period-leaderboard abstraction, historical week API, cache, scheduled job, or wallet mutation.

- [ ] **Step 7: Commit the E2E/final test slice**

```bash
git add e2e/daily-challenge.spec.ts
git commit -m "test(daily): cover weekly leaderboard journey"
```

- [ ] **Step 8: Update the existing HPA-177 draft PR, not a second PR**

Push this same branch and keep the existing draft PR as the single implementation/design PR for HPA-177. Update its description with:

- weekly score/order semantics;
- actual implementation files;
- validation results;
- explicit confirmation that no schema/migration/cron/reward/history/general leaderboard framework was added.

Do not open another PR for implementation.

---

## Post-merge Linear closeout

After the implementation PR merges:

1. re-fetch HPA-177;
2. add one concise comment with the merged PR and shipped scope;
3. mark HPA-177 Done;
4. verify HPA-167 remains Done and no broader competition roadmap is reopened.

Do not create a replacement season/competition epic as part of closeout.
