# HPA-177 Weekly Daily Challenge Leaderboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one read-only current UTC week leaderboard for unified Blackjack Daily Challenge results on the existing Daily Challenge page.

**Architecture:** Extend the existing `blackjack-run` Daily read model. Derive two current-week date boundaries from the existing Monday-UTC reset helper, aggregate/rank completed Daily rows with one D1 query, expose one guest-readable current-week endpoint, and render a second independent leaderboard section on `/games/daily-challenge`.

**Tech Stack:** Astro, TypeScript, Bun tests, Cloudflare D1/SQLite, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-18-weekly-daily-leaderboard-design.md`

## Global Constraints

- One implementation PR for HPA-177; continue on this existing branch/PR.
- Current UTC week only: Monday 00:00 UTC through next Monday 00:00 UTC.
- `getDailyWeekWindow` returns only `startPeriodKey` and `endPeriodKeyExclusive`.
- Weekly score is `SUM(dailyEndingBankroll)` over completed unified Daily rows.
- Deterministic order is score DESC, days DESC, rounds DESC, last settlement ASC, user id ASC.
- Use one D1 weekly query for top rows, participant count, and optional out-of-top current user.
- `totalRounds`, `lastSettledAt`, and `userId` remain repository-only.
- Public current standing includes `totalEligible` because the UI renders it.
- Reuse `blackjack_run`; no schema, migration, index, snapshot, cache, cron, queue, or Durable Object.
- No historical week input, monthly board, rewards, seasons, leagues, generic period framework, or old Daily compatibility.
- Weekly read failures must stay local to the weekly section.
- No production seed endpoint, direct Playwright D1 writer, or weekly `page.route` JSON fake.

## Proof Boundaries

- **Repository integration tests own multi-user/multi-day SQL semantics.** They use the local `dailyStartInput(...)` fixture builder plus `repository.createDailyRun(...)` and `repository.finishRun(...)`. `test-d1.ts` supplies only Miniflare/D1 setup and `insertTestUser`.
- **Playwright owns product wiring.** It plays today's real Daily attempt. It does not create historical Daily rows.
- **Formatter correctness is a unit-test concern.** E2E may reuse exported `formatPoints` to assert wiring/copy without duplicating number-format code.

## Risks and Mitigations

- **Ranking semantics drift:** one SQL statement owns aggregate, rank, total eligible, top rows, and current user.
- **Wrong fixture seam:** Task 2 explicitly uses repository-local helpers rather than nonexistent Daily helpers in `test-d1.ts`.
- **Required weekly DOM omitted from test fixtures:** Task 4 updates `makeRoot(...)` before renderer tests and keeps weekly nodes required.
- **Persistent local D1 pushes the new E2E user outside top 50:** current standing is authoritative; top-row assertion is conditional on `rank <= 50`.
- **Scope creep inside existing files:** final validation uses a changed-file allowlist plus manual runtime diff review; schema/migration paths are hard-rejected.

---

### Task 1: Define the current Daily week boundaries

**Files:**
- Modify: `src/lib/blackjack-run/daily.ts`
- Modify: `src/lib/blackjack-run/daily.test.ts`

**Interfaces:**

Consumes:

```ts
getDailyPeriodKey(date: Date): string;
getNextWeeklyReset(date: Date): Date;
```

Produces:

```ts
export interface DailyWeekWindow {
  readonly startPeriodKey: string;
  readonly endPeriodKeyExclusive: string;
}

export function getDailyWeekWindow(nowSeconds: number): DailyWeekWindow;
```

- [ ] **Step 1: Write failing boundary tests**

Add to `src/lib/blackjack-run/daily.test.ts`:

```ts
import { getDailyWeekWindow } from './daily';

describe('getDailyWeekWindow', () => {
  test('uses Monday 00:00 UTC through the next Monday', () => {
    const now = Math.trunc(Date.parse('2026-08-17T00:00:00.000Z') / 1000);
    expect(getDailyWeekWindow(now)).toEqual({
      startPeriodKey: '2026-08-17',
      endPeriodKeyExclusive: '2026-08-24',
    });
  });

  test('keeps Sunday night inside the same range', () => {
    const now = Math.trunc(Date.parse('2026-08-23T23:59:59.000Z') / 1000);
    expect(getDailyWeekWindow(now)).toEqual({
      startPeriodKey: '2026-08-17',
      endPeriodKeyExclusive: '2026-08-24',
    });
  });

  test('rolls over exactly at next Monday UTC', () => {
    const now = Math.trunc(Date.parse('2026-08-24T00:00:00.000Z') / 1000);
    expect(getDailyWeekWindow(now)).toEqual({
      startPeriodKey: '2026-08-24',
      endPeriodKeyExclusive: '2026-08-31',
    });
  });

  test('uses calendar date boundaries across ISO week-year rollover', () => {
    const now = Math.trunc(Date.parse('2027-01-01T12:00:00.000Z') / 1000);
    expect(getDailyWeekWindow(now)).toEqual({
      startPeriodKey: '2026-12-28',
      endPeriodKeyExclusive: '2027-01-04',
    });
  });

  test('rejects invalid timestamps', () => {
    expect(() => getDailyWeekWindow(-1)).toThrow(TypeError);
    expect(() => getDailyWeekWindow(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});
```

Do not import or return `getWeeklyPeriodKey`/`weekKey`.

- [ ] **Step 2: Run the focused test and confirm RED**

```bash
bun test src/lib/blackjack-run/daily.test.ts
```

Expected: FAIL because `getDailyWeekWindow` does not exist.

- [ ] **Step 3: Implement the minimal helper**

Extend the existing mission-period import in `daily.ts`:

```ts
import { getDailyPeriodKey, getNextWeeklyReset } from '../missions/periods';
```

Add:

```ts
export interface DailyWeekWindow {
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
    startPeriodKey: getDailyPeriodKey(start),
    endPeriodKeyExclusive: getDailyPeriodKey(nextReset),
  };
}
```

- [ ] **Step 4: Run the focused test and confirm GREEN**

```bash
bun test src/lib/blackjack-run/daily.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/blackjack-run/daily.ts src/lib/blackjack-run/daily.test.ts
git commit -m "feat(daily): define current week boundaries"
```

---

### Task 2: Add one-query weekly aggregation and ranking

**Files:**
- Modify: `src/server/blackjack-run/repository.ts`
- Modify: `src/server/blackjack-run/repository.integration.test.ts`

**Interfaces:**

Produces:

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

listWeeklyLeaderboard(
  startPeriodKey: string,
  endPeriodKeyExclusive: string,
  limit: number,
  userId?: string | null,
): Promise<WeeklyLeaderboardRead>;
```

- [ ] **Step 1: Add a local helper for completed Daily fixtures**

Do **not** add a helper to `test-d1.ts`. Reuse the existing local `dailyStartInput(...)` and repository methods in `repository.integration.test.ts`.

Add a small test-local function only if it removes repeated setup:

```ts
async function completeDailyRun(input: {
  userId: string;
  runSequence: number;
  periodKey: string;
  endingBankroll: number;
  roundsCompleted: number;
  settledAt: number;
}): Promise<void> {
  const id = runId(input.runSequence);
  expect(
    await repository.createDailyRun(
      dailyStartInput({
        userId: input.userId,
        id,
        periodKey: input.periodKey,
        startRequestId: `request-${id}`,
      }),
    ),
  ).toEqual({ kind: 'created' });

  expect(
    await repository.finishRun({
      userId: input.userId,
      runId: id,
      mode: 'daily',
      expectedSequence: 0,
      status: 'completed',
      resultJson: '{}',
      dailyEndingBankroll: input.endingBankroll,
      dailyRoundsCompleted: input.roundsCompleted,
      nowSeconds: input.settledAt,
    }),
  ).toEqual({ kind: 'applied' });
}
```

If `finishRun` requires a different `expectedSequence` for the existing fixture shape, use the same sequence setup already demonstrated by the current Daily repository tests; do not bypass the repository with direct SQL merely for convenience.

- [ ] **Step 2: Write failing aggregate/rank integration tests**

Create users Alice, Bob, Carol, Dave with `insertTestUser`.

Seed current-week completed rows using `completeDailyRun`:

```text
Alice: 2026-08-17 = 1200 / 10 rounds / settled 100
       2026-08-18 =  900 /  8 rounds / settled 200
Bob:   2026-08-17 = 2200 / 10 rounds / settled 150
Carol: 2026-08-17 = 1100 /  7 rounds / settled 120
       2026-08-18 = 1000 /  7 rounds / settled 180
Dave:  2026-08-16 = 9999 / 10 rounds / previous week
```

Also create one current-week Ranked row and one non-completed Daily row; neither may aggregate.

Call:

```ts
const read = await repository.listWeeklyLeaderboard(
  '2026-08-17',
  '2026-08-24',
  2,
  carolId,
);
```

Assert:

```ts
expect(read.entries.map((entry) => ({
  name: entry.playerName,
  score: entry.weeklyScore,
  days: entry.daysPlayed,
}))).toEqual([
  { name: 'Bob', score: 2200, days: 1 },
  { name: 'Alice', score: 2100, days: 2 },
]);

expect(read.currentUser).toEqual({
  rank: 3,
  totalEligible: 3,
  weeklyScore: 2100,
  daysPlayed: 2,
});
```

Verify every returned entry reports `totalEligible === 3` internally.

- [ ] **Step 3: Add focused tie-order tests**

Use independent fixtures to prove:

1. equal score -> more completed days wins;
2. equal score/days -> more total rounds wins;
3. equal score/days/rounds -> earlier `MAX(settledAt)` wins;
4. exact remaining tie -> ascending `userId` wins.

Because `userId` is inside `RANK()`, assert exact ranks are unique and stable across repeated calls.

- [ ] **Step 4: Run repository integration tests and confirm RED**

```bash
bun test src/server/blackjack-run/repository.integration.test.ts
```

Expected: FAIL because weekly types/method/query do not exist.

- [ ] **Step 5: Add repository types and interface method**

Add the interfaces above next to the existing Daily leaderboard types and extend `BlackjackRunRepository` with `listWeeklyLeaderboard(...)`.

- [ ] **Step 6: Implement one weekly SQL statement**

Add one SQL constant with this shape:

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

Do not create separate current-user or count SQL constants.

- [ ] **Step 7: Parse the single result set**

Bind:

```ts
const rows = await db
  .prepare(WEEKLY_LEADERBOARD_SQL)
  .bind(startPeriodKey, endPeriodKeyExclusive, limit, userId ?? null)
  .all<WeeklyLeaderboardRow>();
```

For every row validate:

- `rank >= 1` safe integer;
- `weeklyScore >= 0` safe integer;
- `daysPlayed >= 1` safe integer;
- `totalRounds >= 0` safe integer;
- `lastSettledAt >= 0` safe integer;
- `totalEligible >= 1` safe integer.

Return:

```ts
const entries = parsed.filter((row) => row.rank <= limit);
const own = userId ? parsed.find((row) => row.userId === userId) ?? null : null;

return {
  entries,
  currentUser: own
    ? {
        rank: own.rank,
        totalEligible: own.totalEligible,
        weeklyScore: own.weeklyScore,
        daysPlayed: own.daysPlayed,
      }
    : null,
};
```

Repository entries may retain `totalRounds`, `lastSettledAt`, and `userId`; no later layer may require them.

- [ ] **Step 8: Run repository integration tests and confirm GREEN**

```bash
bun test src/server/blackjack-run/repository.integration.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/server/blackjack-run/repository.ts src/server/blackjack-run/repository.integration.test.ts
git commit -m "feat(daily): aggregate weekly leaderboard"
```

---

### Task 3: Expose the current-week public API

**Files:**
- Modify: `src/server/blackjack-run/service.ts`
- Modify: `src/server/blackjack-run/service.test.ts`
- Modify: `src/server/blackjack-run/http.ts`
- Modify: `src/server/blackjack-run/http.test.ts`
- Create: `src/pages/api/blackjack-daily/weekly-leaderboard.ts`

**Interfaces:**

Service:

```ts
weeklyLeaderboard(
  userId: string | null,
  limit: number,
): Promise<WeeklyLeaderboardRead>;
```

Public response:

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

Endpoint:

```text
GET /api/blackjack-daily/weekly-leaderboard?limit=50
```

- [ ] **Step 1: Add failing service tests**

Freeze `now()` at `2026-08-18T12:00:00Z` and spy on `listWeeklyLeaderboard`.

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

Also assert `null` is passed for guests.

- [ ] **Step 2: Add failing HTTP tests**

Extend the fake service with `weeklyLeaderboard` and verify:

- guest succeeds;
- default limit is 50;
- limit 1 succeeds;
- 0, 51, and non-numeric limit return `400 INVALID_REQUEST`;
- no week/date parameter is consumed;
- top entries expose only rank/name/score/days;
- authenticated current standing includes rank/totalEligible/score/days;
- response JSON contains neither repository `userId`, `totalRounds`, nor `lastSettledAt`.

- [ ] **Step 3: Run focused tests and confirm RED**

```bash
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
```

- [ ] **Step 4: Implement service delegation**

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

Do not accept a period from callers.

- [ ] **Step 5: Implement explicit HTTP projection**

```ts
function projectWeeklyLeaderboard(
  read: WeeklyLeaderboardRead,
): WeeklyLeaderboardPublicView {
  return {
    entries: read.entries.map((entry) => ({
      rank: entry.rank,
      playerName: entry.playerName,
      weeklyScore: entry.weeklyScore,
      daysPlayed: entry.daysPlayed,
    })),
    currentUser: read.currentUser,
  };
}
```

Reuse the existing leaderboard `parseLimit`, limit constants, `optionalUserId`, `serviceFor`, `jsonSuccess`, and error mapping.

- [ ] **Step 6: Add the handler**

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

Add it to `BlackjackRunHttpHandlers` and the returned handler object.

- [ ] **Step 7: Add the thin Astro route**

Create `src/pages/api/blackjack-daily/weekly-leaderboard.ts` following the existing sibling adapter pattern:

```ts
import type { APIRoute } from 'astro';
import { blackjackRunHttpHandlers } from '../../../server/blackjack-run/http';

export const GET: APIRoute = blackjackRunHttpHandlers.weeklyLeaderboard;
```

No route-local logic.

- [ ] **Step 8: Run focused tests and confirm GREEN**

```bash
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
```

- [ ] **Step 9: Commit**

```bash
git add \
  src/server/blackjack-run/service.ts \
  src/server/blackjack-run/service.test.ts \
  src/server/blackjack-run/http.ts \
  src/server/blackjack-run/http.test.ts \
  src/pages/api/blackjack-daily/weekly-leaderboard.ts
git commit -m "feat(daily): expose weekly leaderboard"
```

---

### Task 4: Render weekly results with required DOM and local states

**Files:**
- Modify: `src/lib/blackjack-run/daily-ui.ts`
- Modify: `src/lib/blackjack-run/daily-ui.test.ts`
- Modify: `src/pages/games/daily-challenge.astro`

**Interfaces:**

```ts
export const DAILY_WEEKLY_LEADERBOARD_PATH = '/api/blackjack-daily/weekly-leaderboard';

export interface WeeklyLeaderboardEntryView {
  readonly rank: number;
  readonly playerName: string;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
}

export interface WeeklyCurrentUserStandingView {
  readonly rank: number;
  readonly totalEligible: number;
  readonly weeklyScore: number;
  readonly daysPlayed: number;
}

export interface WeeklyLeaderboardView {
  readonly entries: readonly WeeklyLeaderboardEntryView[];
  readonly currentUser: WeeklyCurrentUserStandingView | null;
}

export function formatPoints(value: number): string;
export function parseWeeklyLeaderboardView(payload: unknown): WeeklyLeaderboardView;
```

`DailyRunRenderer` gains:

```ts
renderWeeklyLeaderboard(leaderboard: WeeklyLeaderboardView): void;
renderWeeklyLeaderboardError(message: string): void;
```

- [ ] **Step 1: Update the shared `makeRoot(...)` fixture first**

`createDailyRunRenderer` resolves elements eagerly. Add these required nodes to `makeRoot` in `daily-ui.test.ts` before constructing renderer tests:

```html
<p data-testid="daily-challenge-weekly-current-standing" hidden></p>
<p data-testid="daily-challenge-weekly-error" hidden></p>
<ol data-testid="daily-challenge-weekly-leaderboard-rows"></ol>
```

Do not make production weekly lookups optional.

- [ ] **Step 2: Write failing formatter/parser tests**

Add:

```ts
expect(formatPoints(3450)).toBe('3,450');
```

Parse this payload:

```ts
{
  entries: [{
    rank: 1,
    playerName: 'Alice',
    weeklyScore: 3450,
    daysPlayed: 3,
  }],
  currentUser: {
    rank: 4,
    totalEligible: 12,
    weeklyScore: 2100,
    daysPlayed: 2,
  },
}
```

Reject malformed/non-integer/negative rank, score, days, and total eligible. Do not parse `totalRounds`.

- [ ] **Step 3: Write failing renderer tests**

Expected row:

```text
#1 Alice 3,450 pts · 3/7 days
```

Expected current standing:

```text
#4 of 12 · 2,100 pts · 2/7 days
```

Assert rows use:

```text
data-testid="daily-challenge-weekly-leaderboard-row"
```

For `{ entries: [], currentUser: null }`, assert exactly one empty-state item:

```text
No results yet this week.
```

Assert `renderWeeklyLeaderboardError(...)` modifies only the weekly error node and does not change `daily-challenge-status` or today's leaderboard DOM.

- [ ] **Step 4: Add failing bootstrap request tests**

Extend fetch mocks so today's endpoint and weekly endpoint are distinguishable; do not let a generic `url.endsWith('/leaderboard')` branch accidentally return the Daily payload for the weekly request.

Verify:

- both requests succeed -> both render;
- Daily success + weekly failure -> Daily remains rendered, weekly error is visible;
- guest still issues weekly GET.

- [ ] **Step 5: Run UI tests and confirm RED**

```bash
bun test src/lib/blackjack-run/daily-ui.test.ts
```

- [ ] **Step 6: Add weekly page markup**

Immediately after today's leaderboard section add:

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

No tabs, page, picker, or chart.

- [ ] **Step 7: Implement `formatPoints`**

Keep one formatter instance beside `CURRENCY`:

```ts
const POINTS = new Intl.NumberFormat('en-US');

export function formatPoints(value: number): string {
  return POINTS.format(value);
}
```

Do not inline `toLocaleString` in weekly rendering.

- [ ] **Step 8: Implement parser and renderer**

Use existing `parseSafeInteger` for weekly numeric fields.

For non-empty entries:

```ts
const row = document.createElement('li');
row.dataset.testid = 'daily-challenge-weekly-leaderboard-row';
row.textContent =
  `#${entry.rank} ${entry.playerName} ${formatPoints(entry.weeklyScore)} pts · ${entry.daysPlayed}/7 days`;
```

For zero entries:

```ts
const empty = document.createElement('li');
empty.dataset.testid = 'daily-challenge-weekly-empty';
empty.textContent = 'No results yet this week.';
weeklyRowsEl.replaceChildren(empty);
```

Current standing:

```ts
weeklyStandingEl.textContent =
  `#${rank} of ${totalEligible} · ${formatPoints(weeklyScore)} pts · ${daysPlayed}/7 days`;
```

Hide standing when `currentUser === null`. Clear/hide weekly error on successful weekly render.

- [ ] **Step 9: Fetch weekly results independently**

Keep today's fetch untouched and add a separate try/catch:

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

Never send this failure to `renderer.renderError`.

- [ ] **Step 10: Run UI tests and confirm GREEN**

```bash
bun test src/lib/blackjack-run/daily-ui.test.ts
```

- [ ] **Step 11: Commit**

```bash
git add \
  src/lib/blackjack-run/daily-ui.ts \
  src/lib/blackjack-run/daily-ui.test.ts \
  src/pages/games/daily-challenge.astro
git commit -m "feat(daily): render weekly leaderboard"
```

---

### Task 5: Extend the real Daily E2E and perform final validation

**Files:**
- Modify: `e2e/daily-challenge.spec.ts`
- Verify unchanged: `src/db/schema.ts`
- Verify unchanged: `drizzle/`

**Interfaces:**
- Consumes the complete feature from Tasks 1–4.
- Produces no runtime/test-only API.

- [ ] **Step 1: Import the points formatter and add request matcher**

Add:

```ts
import { formatPoints } from '../src/lib/blackjack-run/daily-ui';

const WEEKLY_LEADERBOARD_PATH = '/api/blackjack-daily/weekly-leaderboard';

function isWeeklyLeaderboard(url: string, method: string): boolean {
  return pathname(url) === WEEKLY_LEADERBOARD_PATH && method === 'GET';
}
```

The unit test in Task 4 owns formatter correctness; this E2E uses it only to build the expected rendered wiring string.

Do not add `page.route`, D1 writes, or seed helpers.

- [ ] **Step 2: Verify guest weekly GET**

In the existing guest journey, wait for the real weekly response:

```ts
const guestWeeklyResponse = page.waitForResponse((response) =>
  isWeeklyLeaderboard(response.url(), response.request().method()),
);

await page.goto(DAILY_CHALLENGE_PAGE);

expect((await guestWeeklyResponse).ok()).toBe(true);
await expect(page.getByTestId('daily-challenge-weekly-leaderboard')).toBeVisible();
await expect(page.getByTestId('daily-challenge-weekly-error')).toBeHidden();
```

Keep current guest Practice assertions unchanged.

- [ ] **Step 3: Extend the existing post-completion reload**

After the real Daily attempt produces `receiptBankroll`, wait for both Daily and weekly responses on the same reload:

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

Preserve the current Daily leaderboard assertions.

- [ ] **Step 4: Assert current weekly standing from the real response**

Parse:

```ts
const weekly = (await weeklyLeaderboardResponse.json()) as {
  entries: Array<{
    rank: number;
    playerName: string;
    weeklyScore: number;
    daysPlayed: number;
  }>;
  currentUser: {
    rank: number;
    totalEligible: number;
    weeklyScore: number;
    daysPlayed: number;
  } | null;
};
```

Assert:

```ts
expect(weekly.currentUser).not.toBeNull();
expect(weekly.currentUser).toMatchObject({
  weeklyScore: receiptBankroll as number,
  daysPlayed: 1,
});

const standing = weekly.currentUser!;
await expect(page.getByTestId('daily-challenge-weekly-current-standing')).toHaveText(
  `#${standing.rank} of ${standing.totalEligible} · ${formatPoints(standing.weeklyScore)} pts · 1/7 days`,
);
```

Do not expect `totalRounds` in the HTTP response.

- [ ] **Step 5: Guard the top-row assertion on the real rank**

Persistent local D1 data may make the fresh user rank below the endpoint's top-50 list.

```ts
if (standing.rank <= 50) {
  const matchingRows = await page
    .getByTestId('daily-challenge-weekly-leaderboard-row')
    .filter({
      hasText: `${formatPoints(standing.weeklyScore)} pts · 1/7 days`,
    })
    .count();
  expect(matchingRows).toBeGreaterThanOrEqual(1);
}
```

The current-standing assertion is unconditional and is the proof for ranks outside the top 50.

- [ ] **Step 6: Run Daily Challenge E2E**

```bash
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 7: Run all focused HPA-177 tests**

```bash
bun test src/lib/blackjack-run/daily.test.ts
bun test src/server/blackjack-run/repository.integration.test.ts
bun test src/server/blackjack-run/service.test.ts
bun test src/server/blackjack-run/http.test.ts
bun test src/lib/blackjack-run/daily-ui.test.ts
bunx playwright test e2e/daily-challenge.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 8: Run repository-wide validation**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Step 9: Hard-reject schema/migration leakage**

```bash
if git diff --name-only main...HEAD | grep -Eq '(^src/db/schema\.ts$|^drizzle/)'; then
  echo 'Unexpected schema/migration change'
  exit 1
fi
```

Expected: exit 0 with no message.

- [ ] **Step 10: Verify the exact changed-file allowlist**

```bash
cat > /tmp/hpa177-expected-files <<'EOF'
docs/superpowers/plans/2026-08-18-weekly-daily-leaderboard.md
docs/superpowers/specs/2026-08-18-weekly-daily-leaderboard-design.md
e2e/daily-challenge.spec.ts
src/lib/blackjack-run/daily-ui.test.ts
src/lib/blackjack-run/daily-ui.ts
src/lib/blackjack-run/daily.test.ts
src/lib/blackjack-run/daily.ts
src/pages/api/blackjack-daily/weekly-leaderboard.ts
src/pages/games/daily-challenge.astro
src/server/blackjack-run/http.test.ts
src/server/blackjack-run/http.ts
src/server/blackjack-run/repository.integration.test.ts
src/server/blackjack-run/repository.ts
src/server/blackjack-run/service.test.ts
src/server/blackjack-run/service.ts
EOF

git diff --name-only main...HEAD | sort > /tmp/hpa177-actual-files
diff -u /tmp/hpa177-expected-files /tmp/hpa177-actual-files
```

Expected: no diff.

If an implementation step legitimately changes a different file, stop and justify it against the spec before extending this allowlist.

- [ ] **Step 11: Manually inspect the runtime diff for scope**

```bash
git diff main...HEAD -- \
  src/lib/blackjack-run \
  src/server/blackjack-run \
  src/pages/api/blackjack-daily \
  src/pages/games/daily-challenge.astro \
  e2e/daily-challenge.spec.ts
```

Reject any:

- historical week/date input;
- generic period/season abstraction;
- cache/snapshot/scheduled-finalization code;
- wallet/reward mutation;
- production test seed path;
- direct Playwright D1 writer;
- weekly network stub presented as SQL coverage.

This manual diff review replaces the previous grep gates that could not actually fail on in-file scope creep.

- [ ] **Step 12: Commit the E2E slice**

```bash
git add e2e/daily-challenge.spec.ts
git commit -m "test(daily): cover weekly leaderboard journey"
```

- [ ] **Step 13: Update the existing draft PR**

Push the same branch. Update PR #41 with:

- actual one-query implementation;
- final public response shape;
- validation output;
- explicit confirmation of no schema/index/cron/snapshot/reward/history/generic framework work.

Do not open a second implementation PR.

---

## Post-merge Linear Closeout

After this same HPA-177 PR merges:

1. re-fetch HPA-177;
2. comment with the merged PR and shipped bounded scope;
3. mark HPA-177 Done;
4. verify HPA-167 remains Done;
5. do not create a replacement competition/season epic as part of closeout.
