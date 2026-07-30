# Player Statistics Dashboard Design

**Status:** Design complete; pending PR approval before implementation  
**Date:** 2026-07-30  
**Issue:** [HPA-171 — Player statistics dashboard](https://linear.app/cwchanap/issue/HPA-171/player-statistics-dashboard)  
**Scope:** Aggregate all-time player statistics only. Verified session and trend history is owned by HPA-174.

## 1. Context

Arcturus persists cumulative per-user, per-game statistics in `game_stats`: wins, losses,
hands played, biggest win, net profit, and an update timestamp. The existing game-statistics
business logic derives win rate from decided hands (`wins + losses`), and the leaderboard ranks
wins by `totalWins DESC, userId ASC`.

The profile currently presents account details, AI settings, and achievements, but does not show
playing performance. The existing `getUserStatsAllGames()` result is not a dashboard contract
because it returns only rows that exist; HPA-171 requires every canonical game to appear, including
games the player has never played.

Existing calculations must be reused rather than duplicated:

- `calculateMetrics()` is the current per-game derived-metric entry point.
- `getAggregateUserStats()` currently reduces all game rows and is used by achievement evaluation.
- HPA-171 will extract shared pure calculation helpers and make these existing functions delegate to
  them, so dashboard and achievement calculations cannot drift.

Arcturus also has a separate authoritative ranked-results domain. Ranked Blackjack writes separate
ranked statistics and must not be blended with the client-authoritative casual `game_stats`
aggregates. This dashboard therefore describes casual all-time account activity.

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
- Resolve all current-user Wins Ranks in one database statement without ranking the entire table.
- Provide useful loading, empty, error, retry, responsive, and accessible behavior.
- Reuse shared metric, aggregation, number, percentage, and chip-formatting logic.
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
- Fixing the existing leaderboard behavior that includes zero-activity initialized rows.
- Refactoring unrelated profile settings or achievement behavior.
- Refactoring the ranked Blackjack private chip-formatting helpers.

## 3. Resolved product decisions

| Topic | Decision |
|---|---|
| Dashboard trust domain | Existing all-time casual `game_stats` only |
| Ranked statistics | Remain separate and out of scope |
| Game-card rank | **Wins Rank**, explicitly labelled |
| Rank destination | `/games/leaderboard?game=<gameType>&metric=wins` |
| Rank eligibility | Dashboard ranks only `handsPlayed > 0`; initialized zero-hand rows are `Unranked` |
| Leaderboard eligibility mismatch | Existing zero-hand leaderboard inclusion is a pre-existing quirk and out of scope |
| Discovery | Compact profile summary plus dedicated detailed page |
| Detailed route | `/profile/statistics` |
| Profile loading | Server rendered |
| Detailed loading | Client fetch from authenticated `GET /api/profile/statistics` |
| No-JavaScript behavior | Detailed data requires JavaScript; `<noscript>` explains this instead of leaving skeletons indefinitely |
| Detailed layout | Responsive game-card grid |
| Game ordering | Exact `GAME_TYPES` order |
| Zero-activity card | Visible, zero-filled, `Not played yet`, `Unranked`, and `Play <Game>` |
| Profile metrics | Total hands, most-played game, overall win rate, total net profit |
| Aggregate biggest win | Intentionally omitted from compact summary; shown per game on detailed page |
| Overall win rate | Sum wins / sum decided hands; never average game percentages |
| Most-played tie-break | First tied game in canonical `GAME_TYPES` order |
| Rank access | One correlated-count SQL statement, not a whole-table window sort or seven route calls |
| Cross-field API validation | Client recomputes summary invariants from the canonical game array |
| Private caching | API and authenticated HTML responses use `private, no-store` |
| Database migration | None |
| Session/trend follow-up | HPA-174 |

## 4. Architecture

### 4.1 Topology

```text
/profile
  |
  | authenticated server render
  v
getPlayerStatisticsSummary(db, userId)
  |
  +--> getAllUserGameStats(db, userId)
  |
  +--> shared pure aggregate helper
  |
  +--> pure canonical dashboard builder (ranks omitted)

/profile/statistics
  |
  | authenticated shell + accessible skeleton
  | GET /api/profile/statistics
  v
getPlayerStatisticsDashboard(db, userId)
  |
  +--> getAllUserGameStats(db, userId) ---------+
  |                                             |
  +--> getBulkUserWinsRanks(db, userId) --------+--> pure canonical dashboard builder
                                                    |
                                                    +--> shared metric/aggregate helpers
```

The two detailed-page database reads are independent and run in parallel. The profile summary does
not execute the rank query because it does not display game ranks.

### 4.2 Why the detailed page client-fetches

The detailed page could technically server-render the same authenticated D1 reads. Client fetching
is a deliberate interaction tradeoff, not a claim that SSR cannot perform the query:

- HPA-171 explicitly requires meaningful loading and retryable error states.
- With SSR, the loading state is not visible after navigation begins and retry is a full-page reload.
- The client-fetched shell can remain available while the account-scoped data request fails, then
  retry in place without discarding page context or keyboard focus.
- The API provides one testable authentication and response contract for the detailed page.

This choice adds a small controller, runtime validation, and accessibility state management. That
cost is accepted for the in-page retry experience. It is not justified as an unmeasured performance
optimization. If loading/retry requirements are later removed, SSR becomes a valid simplification.

The compact profile summary remains SSR because it should appear in the initial profile HTML and its
failure must not prevent the rest of the profile from rendering.

The authenticated application already depends on JavaScript for interactive features. For the
detailed statistics page, JavaScript is required to load account data. The shell includes a
`<noscript>` message with a link back to `/profile`; it must not leave a permanent loading skeleton
as the only no-JavaScript experience.

### 4.3 Proposed files and responsibilities

```text
src/lib/game-stats/
├── aggregation.ts                     # Shared calculateWinRate and aggregateGameStats helpers
├── aggregation.test.ts                # Existing/helper equivalence and aggregate edge cases
├── player-statistics.ts               # Zero-fill, most-played selection, service orchestration
├── player-statistics.test.ts          # Dashboard ordering, integrity, tie-break, rank mapping
├── player-statistics-types.ts         # Public dashboard contracts
├── game-stats.ts                      # calculateMetrics delegates to calculateWinRate
├── game-stats-repository.ts           # Existing aggregate delegate + bulk wins-rank raw SQL
└── game-stats-repository.test.ts      # Aggregate compatibility and rank-query behavior

src/components/profile/
└── PlayerStatisticsSummary.astro      # Server-rendered compact summary

src/pages/profile.astro                 # Compose summary; set private no-store; no inline dashboard logic
src/pages/profile/statistics.astro      # Protected no-store shell, skeleton, noscript, error containers
src/pages/api/profile/statistics.ts     # Authenticated private no-store JSON endpoint
src/lib/profile-statistics-client.ts    # Fetch, validate, render, retry, focus management
src/lib/formatting.ts                   # Shared integer, percentage, and signed-chip formatting

e2e/profile.spec.ts                     # High-value profile placement and navigation coverage
e2e/profile-statistics.spec.ts          # High-value detailed dashboard flows
```

The exact split between focused type/helper files may be collapsed if responsibilities stay clear.
Dashboard logic must not be added directly to `profile.astro`, which already owns unrelated account,
AI-settings, and achievement concerns.

### 4.4 Service interfaces

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
the same builder, and the builder uses the shared metric/aggregate helpers, so profile, dashboard,
leaderboard-derived metrics, and achievement totals cannot acquire parallel formulas.

## 5. Existing metric and aggregation reuse

### 5.1 Aggregate-stat read

Reuse `getAllUserGameStats(db, userId)`. Do not initialize missing rows merely to render the
dashboard; zero-fill is a read-model concern and must not mutate persistence.

### 5.2 Shared pure helpers

Extract two focused pure helpers:

```ts
export function calculateWinRate(totalWins: number, totalLosses: number): number;

export function aggregateGameStats(stats: readonly GameStats[]): {
  totalWins: number;
  totalLosses: number;
  totalHandsPlayed: number;
  biggestWin: number;
  totalNetProfit: number;
};
```

Reuse rules:

- `calculateMetrics(stats)` delegates to `calculateWinRate`.
- `getUserStatsAllGames()` keeps its existing row-only behavior and delegates per-row derivation
  through `calculateMetrics`; it is not used as the dashboard contract because it does not zero-fill.
- Existing `getAggregateUserStats(db, userId)` remains available to achievement evaluation, but its
  reducer delegates to `aggregateGameStats`.
- The HPA-171 builder calls `aggregateGameStats` on its already-fetched canonical rows rather than
  calling `getAggregateUserStats`, which would perform a duplicate database read.
- `aggregateGameStats` continues to compute aggregate `biggestWin` for achievements even though
  `PlayerStatisticsSummary` intentionally does not expose that field.

This preserves current achievement behavior while creating one source of truth for aggregate
calculations.

## 6. Repository and Wins Rank design

### 6.1 Contract

Add a repository function with this logical contract:

```ts
export async function getBulkUserWinsRanks(
  db: Database,
  userId: string,
): Promise<Map<GameType, number>>;
```

### 6.2 Correlated-count query

Use one correlated-count statement equivalent to:

```sql
SELECT
  subject.gameType,
  1 + (
    SELECT COUNT(*)
    FROM game_stats AS higher
    WHERE higher.gameType = subject.gameType
      AND (
        higher.totalWins > subject.totalWins
        OR (
          higher.totalWins = subject.totalWins
          AND higher.userId < subject.userId
        )
      )
  ) AS winsRank
FROM game_stats AS subject
WHERE subject.userId = ?
  AND subject.handsPlayed > 0;
```

The comparison inside the correlated count mirrors the existing wins-rank branch: a player's rank is
one plus the number of rows with more wins, or equal wins and a lexicographically lower user ID.
Equal-win players therefore receive deterministic unique positions rather than a shared competition
rank.

The outer `handsPlayed > 0` predicate is an intentional dashboard-only eligibility rule and is the
one exception to exact parity with `getUserGameRank(..., 'wins')`. Existing single-game leaderboard
functions remain unchanged in HPA-171: they may rank or list initialized zero-hand rows. The
dashboard instead treats those rows as `Unranked` because the player has not actually played.
Correcting leaderboard eligibility is a separate cleanup, not part of this implementation.

The statement performs one correlated rank count for each active game row owned by the current user,
within one database call. The existing `(gameType, totalWins)` index can narrow each game's
higher-win range; equal-win tie checks may still inspect matching rows. This scales more directly
with the current user's canonical games than a whole-table multi-partition window sort.

Implement the statement with Drizzle's raw `sql` template and explicitly validate/map returned rows.
No first-class ORM rank abstraction is assumed. The existing `getUserGameRank` remains the
single-game implementation used by the leaderboard; HPA-171 does not force it through the new bulk
function.

An active game with zero wins still receives its actual leaderboard position because the dashboard
eligibility rule is activity, not minimum wins.

### 6.3 Unknown, duplicate, and integrity failures

Unknown `gameType` values returned by persistence are not exposed. Log a warning without sensitive
account data and ignore those rows.

Multiple rows for the same canonical game are a data-integrity error because the schema's
`(userId, gameType)` primary key should make them impossible. The pure builder throws a dedicated
integrity exception rather than silently choosing or merging rows.

Integrity exceptions follow the same generic failure paths as repository errors:

- `/api/profile/statistics` logs the server-side exception and returns
  `500 { "error": "Unable to load player statistics" }`.
- `/profile` logs the exception and renders only the Player Performance unavailable state; the rest
  of the profile continues rendering.
- No stack, SQL, duplicate values, or user identifier is exposed to the browser.

### 6.4 Query count and migration

- Profile summary: one query.
- Detailed dashboard: two parallel queries.
- No per-game network calls and no whole-table rank window.
- No schema migration is required for the MVP.

If measured production profiling later shows tie-heavy rank counts are expensive, evaluate a
purpose-built covering index in a follow-up. Do not add an unmeasured index in this design PR.

## 7. Pure dashboard rules

### 7.1 Canonical zero-fill

Start from `GAME_TYPES`, not from database rows. For each canonical game:

1. Find the matching raw row.
2. Use persisted values when present.
3. Otherwise construct zero values.
4. Calculate win rate through `calculateWinRate`.
5. Apply a rank only when `handsPlayed > 0`.

This guarantees exactly one output card per canonical game and stable ordering independent of D1
row order.

### 7.2 Per-game win rate

```text
decidedHands = totalWins + totalLosses
winRate = decidedHands > 0 ? totalWins / decidedHands * 100 : 0
```

Pushes remain represented in `handsPlayed` but do not enter the win-rate denominator.

### 7.3 Overall summary

Use `aggregateGameStats` for total wins, losses, hands, net profit, and the internal aggregate
biggest-win value. Then expose:

```text
totalHands = aggregate.totalHandsPlayed
totalWins = aggregate.totalWins
totalLosses = aggregate.totalLosses
totalNetProfit = aggregate.totalNetProfit
overallDecidedHands = totalWins + totalLosses
overallWinRate = overallDecidedHands > 0
  ? totalWins / overallDecidedHands * 100
  : 0
```

Do not average per-game win-rate percentages; that would overweight low-volume games. Aggregate
`biggestWin` remains available to achievement logic but is intentionally omitted from the compact
profile/dashboard summary.

### 7.4 Most-played game

- If every game has zero hands, return `null`.
- Otherwise choose the greatest `handsPlayed` value.
- When multiple games tie, choose the first tied entry in `GAME_TYPES` order.

This makes the result deterministic and avoids introducing another preference or timestamp rule.

### 7.5 Activity and zero-win rank semantics

`hasActivity` is exactly `handsPlayed > 0`. Row existence alone does not make a game active.

`Unranked` is reserved for zero-activity games or a genuinely unavailable rank. A player who has
played a game but has zero wins may display a numeric last-place or near-last-place Wins Rank. That
is intentional and matches the active-player comparison semantics of the current wins leaderboard.

## 8. API design

### 8.1 Endpoint

`GET /api/profile/statistics`

The route:

1. Reads `locals.session`.
2. Returns `401` JSON when unauthenticated.
3. Resolves the D1 binding from `locals.runtime.env.DB`.
4. Returns `500` JSON if the database is unavailable.
5. Calls `getPlayerStatisticsDashboard(db, session.user.id)`.
6. Returns raw numeric values as `{ summary, games }`.
7. Catches repository, service, and integrity exceptions, logs them server-side, and returns the
   same generic `500` response.

The status and body contract is:

- `200`: `{ summary, games }`.
- `401`: `{ error: 'Unauthorized' }`.
- `500`: `{ error: 'Unable to load player statistics' }`.

Every response is JSON with an explicit `content-type` header. The route never accepts a user ID,
game type, or ranking metric from the request. It is always scoped to the authenticated account and
the fixed MVP Wins Rank contract.

### 8.2 Response

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

### 8.3 Privacy and caching

Set `Cache-Control: private, no-store` on:

- Every `/api/profile/statistics` response.
- The authenticated `/profile` HTML response.
- The authenticated `/profile/statistics` HTML response, including shell and error responses.

The client fetch uses `credentials: 'same-origin'` and `cache: 'no-store'`.

Errors returned to the browser do not expose SQL, user IDs, or repository details. Repository,
service, and integrity exceptions are logged server-side and produce one retryable dashboard error.
If the session expires after the page shell loads, a `401` redirects to `/signin` rather than
rendering account data anonymously.

### 8.4 Payload validation

The client validates both shape and domain invariants before rendering.

Summary invariants:

- `totalHands`, `totalWins`, and `totalLosses` are non-negative safe integers.
- `totalNetProfit` is a signed safe integer.
- `overallWinRate` is finite and within `[0, 100]`.
- `mostPlayedGame` is a canonical `GameType` or `null`.

Game-array invariants:

- The array contains exactly one object for every `GAME_TYPES` entry, with no unknown, missing, or
  duplicate game, in canonical order.
- `totalWins`, `totalLosses`, `handsPlayed`, and `biggestWin` are non-negative safe integers.
- `netProfit` is a signed safe integer.
- `winRate` is finite and within `[0, 100]`.
- `winsRank` is a positive safe integer or `null`.
- `hasActivity === (handsPlayed > 0)`.
- A zero-activity game has `winsRank === null`.

Cross-field invariants are hard validation failures, not advisory checks:

- `summary.totalHands === sum(games.handsPlayed)`.
- `summary.totalWins === sum(games.totalWins)`.
- `summary.totalLosses === sum(games.totalLosses)`.
- `summary.totalNetProfit === sum(games.netProfit)`.
- `summary.overallWinRate` equals the rate recomputed from summed wins and losses within an absolute
  tolerance of `1e-9`.
- `summary.mostPlayedGame` equals the highest-hand game with canonical `GAME_TYPES` tie-breaking, or
  `null` when every card has zero hands.
- Each per-game `winRate` equals the value recomputed from that card's wins and losses within an
  absolute tolerance of `1e-9`.

Malformed or internally inconsistent success payloads enter the same retryable error state as a
failed fetch; they are never partially rendered.

## 9. Profile summary experience

Place `Player Performance` immediately after the existing two-column **Account Details / Casino
Tips** grid and before **AI Rival Settings**.

The section is server rendered so these four metrics appear in initial HTML:

- Total hands.
- Most-played game.
- Overall win rate.
- Total net profit.

Aggregate biggest win is intentionally not a fifth profile metric. It is available on each detailed
game card, while the compact summary stays limited to the four previously approved metrics.

The section includes one `View detailed statistics` link to `/profile/statistics`.

When no games have activity:

- Total hands is `0`.
- Most-played game is `No games played yet`.
- Overall win rate is `0.0%`.
- Net profit is a neutral zero-chip value.
- The section remains visible and keeps the `View detailed statistics` link. The detailed page owns
  the lobby invitation.

If its database read or pure-builder integrity validation fails, only this section displays an
unavailable state. Account details, Casino Tips, AI settings, and achievements continue rendering.
The failure is logged server-side without exposing private data.

## 10. Detailed dashboard experience

`/profile/statistics` applies the same session guard as `/profile`. An unauthenticated page request
redirects to `/signin` before rendering the shell; the API remains independently authenticated for
session expiry and direct requests.

### 10.1 Page structure

1. Header with `Player Statistics`, a short all-time-casual clarification, and a link back to the
   profile.
2. Overall summary with the same four user-facing metrics as the profile.
3. Responsive game-card grid in canonical order.

The grid uses one column on narrow screens, two on medium screens, and three on wider screens.

### 10.2 Game card

Each card contains:

- Game icon and label from shared game constants.
- `Played` or `Not played yet` status.
- Primary metrics: hands played, win rate, and net profit.
- Secondary metrics: wins, losses, and biggest win.
- `Wins Rank` as `#<rank>` or `Unranked`.
- Leaderboard link to `/games/leaderboard?game=<gameType>&metric=wins`.
- Play link to `/games/<gameType>` with accessible text `Play <Game>`.

An active zero-win game displays its numeric Wins Rank when returned. Implementers must not replace
that rank with `Unranked` merely because `totalWins === 0`.

Net-profit presentation is standardized:

- Positive: `+1,200 chips`.
- Negative: `−400 chips`.
- Zero: `0 chips`.

Use a shared formatter with the same grouping behavior as `formatChipBalance`; do not create another
page-private signed-chip formatter. Colour may reinforce the result but the sign and `chips` suffix
carry the meaning. Percentage display uses one decimal with behavior equivalent to
`value.toFixed(1)`, matching the existing leaderboard presentation.

Cards use headings and description lists so metric labels remain associated with values.

### 10.3 Loading state

The initial server-rendered shell contains labelled skeleton cards and a parent region with
`aria-busy="true"`. Skeletons preserve the final layout and avoid an empty flash. Motion respects
`prefers-reduced-motion`.

### 10.4 Populated and partial-activity state

Every canonical `GAME_TYPES` card remains visible. Played and untouched games may coexist;
untouched cards are not mistaken for missing data.

### 10.5 All-empty state

Keep the full zero-filled card grid and add a page-level invitation to start playing. Do not replace
the cards with one generic empty panel because players should still see the complete supported game
surface.

### 10.6 Error and retry state

A failed request or invalid payload replaces the dashboard region with:

- A concise explanation that statistics could not be loaded.
- A keyboard-accessible `Try again` button.
- No stale or partially trusted values.

Retry restores the loading state and refetches. After success, focus moves to the dashboard heading;
after repeated failure, focus moves to the error message. Screen readers receive state changes
through an appropriate live region without repeated noisy announcements.

### 10.7 Unranked state

Render `Unranked`, never `#0`, an empty string, or a misleading total-player rank. Zero-activity
cards are always unranked. Active zero-win cards may still show a numeric rank, as defined in
Section 7.5.

## 11. Shared formatting

Extend `src/lib/formatting.ts` rather than adding page-local `Intl.NumberFormat` helpers. Implement
or expose focused helpers for:

- Whole-number counts.
- Chip amounts.
- Signed chip results using `+N chips`, `−N chips`, and `0 chips`.
- Percentages with a consistent one-decimal display policy equivalent to `toFixed(1)`.

The API retains raw numbers. Formatting occurs at the rendering boundary, and both the Astro summary
and detailed-page client reuse the same helpers. Existing exports remain compatible with current
callers.

The private ranked Blackjack `formatSignedChips` remains unchanged in HPA-171. Consolidating that
unrelated UI helper may be considered separately after the shared formatter exists.

## 12. Failure behavior and consistency

- Profile-summary failure is isolated to the summary component.
- The detailed API fails as one unit if either stats or ranks cannot be read.
- Builder integrity failures use the same generic API and profile-summary failure paths as repository
  failures.
- The two detailed queries run against the same request but are not an atomic snapshot. Minor
  concurrent-play skew is acceptable for an informational all-time dashboard; adding transaction or
  snapshot machinery is disproportionate to the MVP.
- Refreshing after a completed game is the supported way to observe newly persisted totals.
- No local-storage totals are read, merged, or used as fallback.
- HTML and API responses carrying or leading to private account data are explicitly non-cacheable.

## 13. Testing strategy

Pure calculations, payload invariants, and formatting receive comprehensive unit coverage. E2E
coverage is intentionally limited to high-value user flows rather than duplicating every pure
assertion or checking pixel-perfect grid details.

### 13.1 Shared helper and pure builder tests

Cover:

- `calculateMetrics` and the dashboard use the same `calculateWinRate` helper.
- `getAggregateUserStats` preserves current achievement-facing totals through `aggregateGameStats`.
- All canonical games are zero-filled exactly once and in `GAME_TYPES` order.
- Unordered raw rows map to the correct cards.
- Weighted overall win rate uses summed wins and losses.
- Pushes remain in hands but not the win-rate denominator.
- Zero decided hands produce zero win rate.
- Most-played game selection and canonical tie-breaking.
- All-empty summary returns `mostPlayedGame: null`.
- Missing ranks and zero-activity rows become unranked.
- Active zero-win rows retain numeric ranks.
- Unknown game types are ignored.
- Duplicate canonical rows throw the integrity exception.

### 13.2 Repository tests

Cover:

- The correlated-count query returns the current user's rank for multiple active games.
- Equal wins use ascending user ID as deterministic tie-breaker.
- Game partitions rank independently.
- An active zero-win row receives a rank.
- A zero-activity current-user row produces no dashboard rank entry.
- Existing `getUserGameRank(..., 'wins')` behavior for zero-hand rows remains unchanged.
- A user with no row for a game receives no rank entry.
- Empty results produce an empty map.
- Unexpected persisted game types are not returned as valid `GameType` keys.

### 13.3 Formatting tests

Cover:

- Positive result displays `+1,200 chips`.
- Negative result displays `−400 chips`.
- Zero displays `0 chips`.
- Large counts use grouping.
- Percentage rounding uses one decimal.
- No `NaN` or infinity leaks into display output.

### 13.4 Client payload-validation tests

Cover rejection of:

- Negative or fractional count fields.
- Unsafe integer chip/count values.
- Win rates outside `[0, 100]`.
- Missing, duplicate, unknown, or noncanonical game entries.
- `hasActivity` values that disagree with `handsPlayed`.
- A non-null rank for a zero-activity game.
- Summary totals that disagree with game-card sums.
- Per-game or overall win rates outside the stated tolerance.
- An incorrect most-played game or tie-break.

### 13.5 API, page, and failure-path tests

Cover:

- Authenticated API success response.
- API `401` without a session.
- Database binding unavailable.
- Repository and builder-integrity exceptions map to the generic API `500`.
- Profile summary repository and integrity exceptions render only the unavailable section.
- Private no-store cache headers on the API and both authenticated HTML pages.
- The API has no input that can select another user's ID.
- The detailed shell contains the explicit no-JavaScript fallback.

Failure injection strategy:

- Use Playwright `page.route()` interception for detailed API failure followed by retry; no production
  test hook is needed.
- Exercise profile SSR failure isolation in a route/component integration test by injecting or
  mocking the statistics service dependency.
- Do not add a production query parameter, cookie, or public endpoint solely to force SSR failures
  from Playwright.

### 13.6 Focused Playwright coverage

Keep E2E to these high-value flows:

1. Profile summary placement after Casino Tips, before AI Rival Settings, and navigation to details.
2. Populated detailed dashboard: canonical card order, representative metrics, numeric/Unranked
   states, and representative rank/play links.
3. All-empty detailed dashboard: invitation plus the complete zero-filled game grid.
4. Intercepted API failure followed by successful retry and correct focus transition.
5. Mobile/keyboard smoke flow verifying readable cards and operable navigation without
   pixel-perfect layout assertions.

Math, tie-breaks, complete payload validation, every formatter edge, and exhaustive per-card values
belong to unit or integration tests rather than Playwright.

## 14. Delivery sequence

One focused implementation PR is appropriate because HPA-171 requires no migration:

1. Extract shared metric/aggregate helpers and refactor existing callers with equivalence tests.
2. Add dashboard contracts, zero-fill builder, integrity exception, and pure tests.
3. Add the correlated-count Wins Rank repository query and tests.
4. Add summary/dashboard orchestration services.
5. Add authenticated API route, strict cross-field payload validator, and tests.
6. Extend shared formatting utilities.
7. Add the profile summary component, exact insertion point, no-store header, and isolated failure.
8. Add the protected detailed page, no-store shell, client controller, no-JavaScript fallback, and
   runtime states.
9. Add focused Playwright coverage and run the full project verification suite.

The implementation must not begin the HPA-174 event-history model in the same PR.

## 15. Acceptance mapping

- **Every game appears consistently:** canonical zero-fill starts from `GAME_TYPES`.
- **Server-side account data:** both entrypoints use authenticated D1 queries only.
- **Rank display:** each active card uses correlated-count Wins Rank and links to the matching
  leaderboard.
- **Dashboard eligibility:** zero-hand initialized rows are intentionally `Unranked`; the existing
  leaderboard quirk remains out of scope.
- **Graceful unranked behavior:** zero-activity ranks display `Unranked`; active zero-win ranks remain
  numeric.
- **Aggregate consistency:** client validation rejects summaries that disagree with canonical games.
- **Integrity failures:** duplicates are logged and use generic API/profile failure states.
- **Aggregate unit tests:** shared helper and pure builder tests cover calculations and compatibility.
- **Populated, empty, and database-error E2E:** focused scenarios cover each state and retry.
- **Responsive and accessible:** semantic cards, keyboard operation, focus handling, and mobile smoke
  behavior are explicit requirements.
- **Private caching:** API and authenticated HTML responses use `private, no-store`.
- **Shared formatting:** no dashboard-local number/chip formatter is permitted.

## 16. Follow-up boundary

HPA-174 may later add verified history below or beside this aggregate dashboard, but it must treat
its coverage as distinct from all-time `game_stats` totals. It should consume the append-only
verified-event platform, state its earliest available date and supported modes, and must not infer
trusted historical rounds from this dashboard's cumulative snapshots.
