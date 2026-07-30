# Player Statistics Dashboard Design

**Status:** Approved (brainstorming phase complete)
**Date:** 2026-07-30
**Issue:** [HPA-171 — Player statistics dashboard](https://linear.app/cwchanap/issue/HPA-171/player-statistics-dashboard)
**Scope:** Aggregate all-time player statistics only. Verified session and trend history is owned by HPA-174.

## 1. Context

Arcturus already persists cumulative per-user, per-game statistics in `game_stats`: wins,
losses, hands played, biggest win, net profit, and an update timestamp. The game-statistics
service derives win rate from decided hands (`wins + losses`) and the leaderboard can compute a
user's game-specific rank for one selected metric.

The profile currently presents account details, AI settings, and achievements, but does not show
playing performance. The existing `getUserStatsAllGames()` result is not itself a dashboard
contract because it returns only database rows that exist; HPA-171 requires every canonical game
to appear, including games the player has never played.

Arcturus also now has a separate authoritative ranked-results domain. Ranked Blackjack writes
separate ranked statistics and must not be blended with the client-authoritative casual
`game_stats` aggregates. This dashboard therefore describes casual all-time account activity.

HPA-174 has been split out as **Player session and performance history**. It owns append-only
verified events, seven- and thirty-day trends, recent sessions, streaks, drill-down, coverage
metadata, and pagination. HPA-171 does not create an event model or history backfill.

## 2. Goals and non-goals

### 2.1 Goals

- Add a compact, server-rendered performance summary to `/profile`.
- Add a dedicated `/profile/statistics` dashboard for all canonical games.
- Show hands, wins, losses, win rate, net profit, biggest win, and Wins Rank for each game.
- Show total hands, most-played game, weighted overall win rate, and total net profit globally.
- Display every entry in `GAME_TYPES` exactly once and in canonical order.
- Give untouched games useful zero-activity cards and a direct play action.
- Read only authenticated server-side account data.
- Avoid per-game rank-query fan-out.
- Provide useful loading, empty, error, retry, responsive, and accessible behavior.
- Reuse shared number, percentage, and chip formatting.
- Keep repository access, aggregation, API transport, profile composition, and client rendering in
  separate units.

### 2.2 Non-goals

- Combining casual aggregates with ranked-only statistics.
- Adding ranked/casual tabs or a ranked-performance dashboard.
- Adding append-only round or session tables.
- Showing seven-day, thirty-day, or bankroll trend charts.
- Showing recent sessions, streaks, individual rounds, or game-history drill-down.
- Backfilling historical events from `game_stats` or client-authoritative chip receipts.
- Changing leaderboard metrics, seasonal ranking, or reward settlement.
- Refactoring unrelated profile settings or achievement behavior.

## 3. Resolved product decisions

| Topic | Decision |
|---|---|
| Dashboard trust domain | Existing all-time casual `game_stats` only |
| Ranked statistics | Remain separate and out of scope |
| Game-card rank | **Wins Rank**, explicitly labelled |
| Rank destination | `/games/leaderboard?game=<gameType>&metric=wins` |
| Discovery | Compact profile summary plus dedicated detailed page |
| Detailed route | `/profile/statistics` |
| Profile loading | Server rendered |
| Detailed loading | Client fetch from authenticated `GET /api/profile/statistics` |
| Detailed layout | Responsive game-card grid |
| Game ordering | Exact `GAME_TYPES` order |
| Zero-activity card | Visible, zero-filled, `Not played yet`, `Unranked`, and `Play <Game>` |
| Profile metrics | Total hands, most-played game, overall win rate, total net profit |
| Overall win rate | Sum wins / sum decided hands; never average game percentages |
| Most-played tie-break | First tied game in canonical `GAME_TYPES` order |
| Rank access | One bulk wins-rank query, not seven rank calls |
| Database migration | None |
| Session/trend follow-up | HPA-174 |

## 4. Architecture

### 4.1 Topology

```text
/profile
  |
  | server render
  v
getPlayerStatisticsSummary(db, userId)
  |
  +--> getAllUserGameStats(db, userId)
  |
  +--> pure canonical dashboard builder (ranks omitted)

/profile/statistics
  |
  | initial accessible shell and skeleton
  | GET /api/profile/statistics
  v
getPlayerStatisticsDashboard(db, userId)
  |
  +--> getAllUserGameStats(db, userId) ---------+
  |                                             |
  +--> getBulkUserWinsRanks(db, userId) --------+--> pure canonical dashboard builder
```

The two detailed-page database reads are independent and run in parallel. The profile summary does
not execute the rank query because it does not display game ranks.

### 4.2 Proposed files and responsibilities

```text
src/lib/game-stats/
├── player-statistics.ts              # Pure builder plus summary/dashboard orchestration
├── player-statistics.test.ts         # Aggregation, zero-fill, ordering, tie-break tests
├── player-statistics-types.ts        # Public dashboard contracts
├── game-stats-repository.ts          # Add bulk wins-rank query
└── game-stats-repository.test.ts     # Rank-query behavior

src/components/profile/
└── PlayerStatisticsSummary.astro     # Server-rendered compact summary

src/pages/profile.astro               # Compose summary; do not inline dashboard logic
src/pages/profile/statistics.astro    # Protected page shell, skeleton, empty/error containers
src/pages/api/profile/statistics.ts   # Authenticated JSON endpoint
src/lib/profile-statistics-client.ts  # Fetch, validate, render, retry, focus management
src/lib/formatting.ts                  # Shared integer, percentage, and signed-chip formatting

e2e/profile.spec.ts                   # Existing profile coverage plus summary tests
e2e/profile-statistics.spec.ts        # Detailed dashboard states and interaction
```

The exact split between `player-statistics.ts` and `player-statistics-types.ts` may be collapsed if
each file remains focused and small. Dashboard logic must not be added directly to
`profile.astro`, which is already responsible for unrelated account, AI-settings, and achievement
concerns.

### 4.3 Service interfaces

```ts
export interface PlayerStatisticsSummary {
  totalHands: number;
  totalWins: number;
  totalLosses: number;
  overallWinRate: number;
  totalNetProfit: number;
  mostPlayedGame: GameType | null;
}

export interface PlayerGameStatistics {
  gameType: GameType;
  totalWins: number;
  totalLosses: number;
  handsPlayed: number;
  winRate: number;
  netProfit: number;
  biggestWin: number;
  winsRank: number | null;
  hasActivity: boolean;
}

export interface PlayerStatisticsDashboard {
  summary: PlayerStatisticsSummary;
  games: PlayerGameStatistics[];
}

export async function getPlayerStatisticsSummary(
  db: Database,
  userId: string,
): Promise<PlayerStatisticsSummary>;

export async function getPlayerStatisticsDashboard(
  db: Database,
  userId: string,
): Promise<PlayerStatisticsDashboard>;
```

The pure builder accepts raw stat rows and an optional rank map. Both public service functions use
the same builder so summary calculations cannot drift between the profile and detailed page.

## 5. Repository and ranking design

### 5.1 Aggregate-stat read

Reuse `getAllUserGameStats(db, userId)`. Do not initialize missing rows merely to render the
dashboard; zero-fill is a read-model concern and must not mutate persistence.

### 5.2 Bulk Wins Rank

Add a repository function with this logical contract:

```ts
export async function getBulkUserWinsRanks(
  db: Database,
  userId: string,
): Promise<Map<GameType, number>>;
```

Use one SQLite window-function query equivalent to:

```sql
WITH ranked AS (
  SELECT
    userId,
    gameType,
    ROW_NUMBER() OVER (
      PARTITION BY gameType
      ORDER BY totalWins DESC, userId ASC
    ) AS winsRank
  FROM game_stats
)
SELECT gameType, winsRank
FROM ranked
WHERE userId = ?;
```

`ROW_NUMBER` is intentional. The existing leaderboard breaks equal win totals by ascending user ID,
so every row has a deterministic unique position rather than a shared competition rank.

The query ranks existing rows exactly as the current wins leaderboard does. During dashboard
construction, a game with `handsPlayed === 0` is still presented as `Unranked`, even if a legacy or
transient zero-valued row exists. An active zero-win game may retain a rank produced by the current
leaderboard semantics.

Unknown `gameType` values returned by persistence are not exposed. The repository or builder logs a
warning with no sensitive account data and ignores those rows. Multiple rows for the same canonical
game are treated as a data-integrity error because the schema's `(userId, gameType)` primary key
should make duplicates impossible.

### 5.3 Query count

- Profile summary: one query.
- Detailed dashboard: two parallel queries.
- No per-game reads and no seven-call rank loop.

No schema or index migration is required for the current `GAME_TYPES` dashboard workload. If later
profiling shows the window query is expensive at production scale, index optimization belongs to a
measured follow-up rather than this MVP.

## 6. Pure aggregation rules

### 6.1 Canonical zero-fill

Start from `GAME_TYPES`, not from database rows. For each canonical game:

1. Find the matching raw row.
2. Use persisted values when present.
3. Otherwise construct zero values.
4. Calculate derived metrics.
5. Apply a rank only when `handsPlayed > 0`.

This guarantees exactly one output card per canonical game and stable ordering independent of D1
row order.

### 6.2 Per-game win rate

```text
decidedHands = totalWins + totalLosses
winRate = decidedHands > 0 ? totalWins / decidedHands * 100 : 0
```

Pushes remain represented in `handsPlayed` but do not enter the win-rate denominator.

### 6.3 Overall summary

```text
totalHands = sum(handsPlayed)
totalWins = sum(totalWins)
totalLosses = sum(totalLosses)
totalNetProfit = sum(netProfit)
overallDecidedHands = totalWins + totalLosses
overallWinRate = overallDecidedHands > 0
  ? totalWins / overallDecidedHands * 100
  : 0
```

Do not average per-game win-rate percentages; that would overweight low-volume games.

### 6.4 Most-played game

- If every game has zero hands, return `null`.
- Otherwise choose the greatest `handsPlayed` value.
- When multiple games tie, choose the first tied entry in `GAME_TYPES` order.

This makes the result deterministic and avoids introducing another preference or timestamp rule.

### 6.5 Activity state

`hasActivity` is exactly `handsPlayed > 0`. Row existence alone does not make a game active.

## 7. API design

### 7.1 Endpoint

`GET /api/profile/statistics`

The route:

1. Reads `locals.session`.
2. Returns `401` JSON when unauthenticated.
3. Resolves the D1 binding from `locals.runtime.env.DB`.
4. Returns `500` JSON if the database is unavailable.
5. Calls `getPlayerStatisticsDashboard(db, session.user.id)`.
6. Returns raw numeric values as `{ summary, games }`.
7. Catches service/repository failures, logs them server-side, and returns the same generic `500`
   response used for database unavailability.

The status and body contract is:

- `200`: `{ summary, games }`.
- `401`: `{ error: 'Unauthorized' }`.
- `500`: `{ error: 'Unable to load player statistics' }`.

Every response is JSON with an explicit `content-type` header. The route never accepts a user ID,
game type, or ranking metric from the request. It is always scoped to the authenticated account and
the fixed MVP Wins Rank contract.

### 7.2 Response

```json
{
  "summary": {
    "totalHands": 1250,
    "totalWins": 610,
    "totalLosses": 590,
    "overallWinRate": 50.83333333333333,
    "totalNetProfit": 2400,
    "mostPlayedGame": "blackjack"
  },
  "games": [
    {
      "gameType": "blackjack",
      "totalWins": 420,
      "totalLosses": 390,
      "handsPlayed": 850,
      "winRate": 51.85185185185185,
      "netProfit": 3200,
      "biggestWin": 500,
      "winsRank": 12,
      "hasActivity": true
    }
  ]
}
```

The real `games` array always contains every `GAME_TYPES` entry. The shortened example above is not
the full response.

### 7.3 Privacy and caching

- Send `Cache-Control: private, no-store`.
- The client fetch uses `credentials: 'same-origin'` and `cache: 'no-store'`.
- Errors returned to the browser do not expose SQL, user IDs, or repository details.
- Repository exceptions are logged server-side and produce one retryable dashboard error.
- If the session expires after the page shell loads, a `401` redirects to `/signin` rather than
  rendering account data anonymously.

### 7.4 Payload validation

The client validates the response shape before rendering:

- `summary` is an object with finite numeric fields and a valid or null `mostPlayedGame`.
- `games` is an array containing exactly one valid object for each canonical game.
- Numeric fields are finite numbers.
- `winsRank` is a positive integer or `null`.
- `hasActivity` is boolean and consistent with the server contract.

Malformed success payloads enter the same retryable error state as a failed fetch; they are never
partially rendered.

## 8. Profile summary experience

Place a `Player Performance` section after the account overview and before AI Rival Settings. It is
server rendered so the four metrics appear in initial HTML:

- Total hands.
- Most-played game.
- Overall win rate.
- Total net profit.

The section includes one `View detailed statistics` link to `/profile/statistics`.

When no games have activity:

- Total hands is `0`.
- Most-played game is `No games played yet`.
- Overall win rate is `0.0%`.
- Net profit is a neutral zero-chip value.
- The section remains visible and keeps the `View detailed statistics` link. The detailed page owns
  the lobby invitation.

If its database read fails, only this section displays an unavailable state. Account details, AI
settings, and achievements continue rendering. The failure is logged server-side without exposing
private data.

## 9. Detailed dashboard experience

`/profile/statistics` applies the same session guard as `/profile`. An unauthenticated page request
redirects to `/signin` before rendering the shell; the API remains independently authenticated for
session expiry and direct requests.

### 9.1 Page structure

1. Header with `Player Statistics`, a short all-time-casual clarification, and a link back to the
   profile.
2. Overall summary with the same four user-facing metrics as the profile.
3. Responsive game-card grid in canonical order.

The grid uses one column on narrow screens, two on medium screens, and three on wider screens.

### 9.2 Game card

Each card contains:

- Game icon and label from shared game constants.
- `Played` or `Not played yet` status.
- Primary metrics: hands played, win rate, and net profit.
- Secondary metrics: wins, losses, and biggest win.
- `Wins Rank` as `#<rank>` or `Unranked`.
- Leaderboard link to `/games/leaderboard?game=<gameType>&metric=wins`.
- Play link to `/games/<gameType>` with accessible text `Play <Game>`.

Net-profit styling communicates positive, negative, and neutral values with text/signs as well as
colour. Cards use headings and description lists so metric labels remain associated with values.

### 9.3 Loading state

The initial server-rendered shell contains labelled skeleton cards and a parent region with
`aria-busy="true"`. Skeletons preserve the final layout and avoid an empty flash. Motion respects
`prefers-reduced-motion`.

### 9.4 Populated and partial-activity state

Every canonical `GAME_TYPES` card remains visible. Played and untouched games may coexist;
untouched cards are not mistaken for missing data.

### 9.5 All-empty state

Keep the full zero-filled card grid and add a page-level invitation to start playing. Do not replace
the cards with one generic empty panel because players should still see the complete supported game
surface.

### 9.6 Error and retry state

A failed request or invalid payload replaces the dashboard region with:

- A concise explanation that statistics could not be loaded.
- A keyboard-accessible `Try again` button.
- No stale or partially trusted values.

Retry restores the loading state and refetches. After success, focus moves to the dashboard heading;
after repeated failure, focus moves to the error message. Screen readers receive state changes
through an appropriate live region without repeated noisy announcements.

### 9.7 Unranked state

Render `Unranked`, never `#0`, an empty string, or a misleading total-player rank. Zero-activity
cards are always unranked.

## 10. Shared formatting

Extend `src/lib/formatting.ts` rather than adding page-local `Intl.NumberFormat` helpers.
Implement or expose focused helpers for:

- Whole-number counts.
- Chip amounts, including a signed presentation for net profit.
- Percentages with a consistent one-decimal display policy.

The API retains raw numbers. Formatting occurs at the rendering boundary, and both the Astro summary
and detailed-page client reuse the same helpers. Existing exports remain compatible with current
callers.

## 11. Failure behavior and consistency

- Profile-summary failure is isolated to the summary component.
- The detailed API fails as one unit if either stats or ranks cannot be read. It does not present a
  dashboard with silently missing ranks.
- The two detailed queries run against the same request but are not an atomic snapshot. Minor
  concurrent-play skew is acceptable for an informational all-time dashboard; adding transaction
  or snapshot machinery is disproportionate to the MVP.
- Refreshing after a completed game is the supported way to observe newly persisted totals.
- No local-storage totals are read, merged, or used as fallback.

## 12. Testing strategy

### 12.1 Pure unit tests

Cover:

- All canonical games are zero-filled exactly once.
- Output order always matches `GAME_TYPES`.
- Unordered raw rows map to the correct cards.
- Weighted overall win rate uses summed wins and losses.
- Pushes remain in hands but not the win-rate denominator.
- Zero decided hands produce zero win rate.
- Most-played game selection.
- Canonical tie-breaking for most-played game.
- All-empty summary returns `mostPlayedGame: null`.
- Missing ranks and zero-activity rows become unranked.
- Rank rows map to the correct game.
- Unknown game types are ignored.
- Duplicate canonical rows fail loudly.

### 12.2 Repository tests

Cover:

- Bulk query returns the current user's rank for multiple games.
- Equal wins use ascending user ID as deterministic tie-breaker.
- Game partitions rank independently.
- A user with no row for a game receives no rank entry.
- Empty results produce an empty map.
- Unexpected persisted game types are not returned as valid `GameType` keys.

### 12.3 Formatting tests

Cover:

- Positive, negative, and zero chip values.
- Large counts.
- Percentage rounding at one decimal.
- No `NaN` or infinity leaks into display output.

### 12.4 API route tests

Cover:

- Authenticated success response.
- `401` without a session.
- Database binding unavailable.
- Repository/service exception.
- Private no-store cache header.
- The route ignores or rejects attempts to choose another user's ID because no such input exists.

### 12.5 Playwright tests

Profile coverage:

- Populated summary.
- All-empty summary.
- Summary failure does not break the rest of the profile.
- Detailed-page link.

Detailed-page coverage:

- Populated dashboard.
- One card for every `GAME_TYPES` entry in canonical order.
- Mixed played and untouched cards.
- Correct weighted summary values.
- Wins Rank and unranked states.
- Rank links and play links.
- Initial loading state.
- Intercepted API failure followed by successful retry.
- All-empty invitation while retaining the full grid.
- Mobile layout.
- Keyboard navigation and retry focus behavior.

## 13. Delivery sequence

One focused implementation PR is appropriate because HPA-171 requires no migration:

1. Add dashboard contracts and pure aggregation tests.
2. Add the bulk Wins Rank repository query and tests.
3. Add summary/dashboard orchestration services.
4. Add authenticated API route and route tests.
5. Extend shared formatting utilities.
6. Add the profile summary component and isolated profile failure handling.
7. Add the detailed page, client controller, runtime validation, and states.
8. Add Playwright coverage and run the full project verification suite.

The implementation must not begin the HPA-174 event-history model in the same PR.

## 14. Acceptance mapping

- **Every game appears consistently:** canonical zero-fill starts from `GAME_TYPES`.
- **Server-side account data:** both entrypoints use authenticated D1 queries only.
- **Rank display:** each active card uses bulk Wins Rank and links to the matching leaderboard.
- **Graceful unranked behavior:** absent or zero-activity ranks display `Unranked`.
- **Aggregate unit tests:** pure builder tests cover all calculations and edge cases.
- **Populated, empty, and database-error E2E:** dedicated Playwright scenarios cover each state and
  retry.
- **Responsive and accessible:** semantic cards, keyboard operation, focus handling, and mobile grid
  behavior are explicit requirements.
- **Shared formatting:** no dashboard-local number/chip formatter is permitted.

## 15. Follow-up boundary

HPA-174 may later add verified history below or beside this aggregate dashboard, but it must treat
its coverage as distinct from all-time `game_stats` totals. It should consume the append-only
verified-event platform, state its earliest available date and supported modes, and must not infer
trusted historical rounds from this dashboard's cumulative snapshots.
