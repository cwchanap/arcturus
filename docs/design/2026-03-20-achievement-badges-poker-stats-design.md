# Design: Achievement Badge Column + Poker Game Stats

**Date:** 2026-03-20
**Status:** Approved

---

## Overview

Two completion features that finish partially-built work:

1. **Achievement Badge Column** — surface already-earned badges in the leaderboard UI
2. **Poker Game Stats** — wire Poker into the existing `recordGameRound()` pipeline so it appears on the game-specific leaderboard

Both are independent. Badges ship first (pure UI work), Poker stats second (data pipeline work).

---

## Feature 1: Achievement Badge Column

### Goal

Players who have earned achievement badges currently have no way to see them in the leaderboard. The `user_achievement` table and all business logic already exist; only the UI integration is missing.

### Data Flow

1. After fetching top-N players (first stage), run `getBulkUserAchievements` in parallel with `getUserRank` and `getTotalPlayerCount` (second stage `Promise.all`) — badge fetch cannot run in stage 1 because userIds aren't known yet, but it can be parallelised with the other second-stage queries.
2. Group results by `userId` in application code — no N+1 queries.
3. Map each `achievementId` → `achievement.icon` (emoji) using the existing `ACHIEVEMENTS` array.
4. Enrich leaderboard entries with a `badges: string[]` field (emoji array, empty array if none).
5. Render a dedicated "Badges" column in the leaderboard table.

### New Function

**`achievement-repository.ts`** — add `getBulkUserAchievements`. Add `inArray` to the existing `import { eq, and, sql } from 'drizzle-orm'` line (not a separate import statement):

```typescript
import { eq, and, sql, inArray } from 'drizzle-orm'; // inArray added to existing import

/**
 * Get achievement emoji icons for multiple users in a single query.
 * Returns a Map of userId → string[] (emoji icons).
 * Returns empty Map if userIds is empty (guard against inArray([]) D1 behavior).
 */
export async function getBulkUserAchievements(
	db: Database,
	userIds: string[],
): Promise<Map<string, string[]>> {
	if (userIds.length === 0) return new Map();

	const results = await db
		.select({ userId: userAchievement.userId, achievementId: userAchievement.achievementId })
		.from(userAchievement)
		.where(inArray(userAchievement.userId, userIds));

	const map = new Map<string, string[]>();
	for (const row of results) {
		const achievement = ACHIEVEMENTS.find((a) => a.id === row.achievementId);
		if (!achievement) continue;
		const existing = map.get(row.userId) ?? [];
		existing.push(achievement.icon); // emoji string
		map.set(row.userId, existing);
	}
	return map;
}
```

No ordering needed — badge display order is not significant.

### Type Changes

- `LeaderboardEntry` (`src/lib/leaderboard/types.ts`) — add `badges: string[]`
- `GameLeaderboardEntry` (`src/lib/game-stats/types.ts`) — add `badges: string[]`
- Container types `LeaderboardData` and `GameLeaderboardData` reference these entry types and require no separate change.

### Transform Function Updates

`transformToLeaderboardEntries` in `leaderboard.ts` must accept a `badgeMap: Map<string, string[]>` parameter and populate `badges` on each entry:

```typescript
badges: badgeMap.get(entry.userId) ?? [];
```

`transformToGameLeaderboardEntries` in `game-stats.ts` must do the same.

### `getLeaderboardData` / `getGameLeaderboardData` Changes

Two-stage fetch to maximise parallelism:

```typescript
// Stage 1: fetch top players (userIds not known until this resolves)
const players = await getTopPlayers(db, limit);
const userIds = players.map((p) => p.userId);

// Stage 2: parallel queries that depend on stage 1
const [badgeMap, currentUserRank, totalPlayers] = await Promise.all([
	getBulkUserAchievements(db, userIds),
	getUserRank(db, currentUserId),
	getTotalPlayerCount(db),
]);

const entries = transformToLeaderboardEntries(players, badgeMap, currentUserId);
```

### UI Changes

**`src/pages/games/leaderboard.astro`**:

- Add `<th>Badges</th>` column header to both overall and game-specific tables
- Add `<td>` per row rendering emoji icons joined by a space, or `—` if `badges` is empty
- No expand/modal needed

### Constraints

- No schema changes — `user_achievement` table already exists
- No new API endpoint — badges fetched server-side during SSR
- Empty badge cell renders `—` to preserve column alignment
- `inArray` with empty array is guarded in `getBulkUserAchievements` to avoid D1 edge behavior

---

## Feature 2: Poker Game Stats

### Goal

Poker is the only game excluded from game-specific leaderboards. The `/api/chips/update` endpoint already accepts `'poker'` for chip balance updates (it passes the `GAME_LIMITS.poker` gate). The only gap is:

1. `PokerGame.ts` never calls the endpoint, and
2. `isValidGameType('poker')` returns `false` (because `'poker'` is absent from `GAME_TYPES`), which silently skips `recordGameRound()` inside the endpoint.

Both must be fixed together for stats to be recorded.

### Hook Points

`PokerGame.ts` has **three** round-ending paths where the sync call is added:

| Path           | Location       | Trigger                                            | Human outcome     |
| -------------- | -------------- | -------------------------------------------------- | ----------------- |
| Opponents fold | ~line 491      | `activePlayers.length === 1` and `winner.id === 0` | Win               |
| Human folds    | ~line 588      | `players[0]` folds                                 | Loss              |
| Showdown       | ~lines 522–560 | Cards compared; winner(s) determined               | Win / Loss / Push |

All three paths must trigger `syncChips()`.

**Important — Opponents fold path guard:** The `activePlayers.length === 1` branch fires for _any_ sole remaining player, including AI players. The sync must only fire when `winner.id === 0` (i.e. the human is the last standing). When an AI wins by sole survivor, no sync is needed.

**Fourth hook point — Showdown entry with one active player:** Inside the `showdown` phase block (~line 524) there is a second `activePlayers.length === 1` guard (a player may fold on the river just before cards are compared). This path awards chips and must trigger `syncChips()` with the same `winner.id === 0` guard. This covers the same logic as hook point 1 but reached via the showdown code path.

### Human Player Identification

The human player is always `this.players[0]` (created via `createPlayer(0, 'You', ...)` in the constructor — `id` is a numeric `0`, not the string `'human'`). `serverSyncedBalance` is added as a **private class field** on `PokerGame`:

```typescript
private serverSyncedBalance: number = 0; // set in constructor from DOM
```

**Delta calculation — unified approach:** For all outcomes, use `players[0].chips - humanChipsBefore` where `humanChipsBefore` is captured at the start of each hand (before blinds are posted). This works for win, loss, fold, and split cases without special-casing:

- Win: positive (chips gained)
- Loss/fold: negative (chips lost — all rounds' bets, not just current round; `player.totalBet` accumulates across all betting rounds)
- Push: small positive or zero (chips returned from split pot minus chips committed)

Do **not** use `currentBet` for fold delta — `currentBet` resets each betting round and only reflects the most recent round's bet. Do **not** use `totalBet` directly — use the balance diff.

**Pot capture ordering:** For win cases, capture `const potWon = this.pot` before calling `awardChips()` (which zeroes `this.pot`), then use `potWon` as `biggestWinCandidate`.

### `serverSyncedBalance` Initialization

Currently `poker.astro` renders `#player-balance` as a hardcoded `$1,000` string — not the real server chip balance. This must be fixed:

1. **`poker.astro`**: inject `user.chipBalance` as a locale-formatted number into `#player-balance` (identical pattern to `blackjack.astro`):

   ```astro
   ---
   const initialBalance = user.chipBalance ?? 1000;
   ---

   <div id="player-balance">{initialBalance.toLocaleString()}</div>
   ```

2. **`PokerGame.ts` constructor**: read and parse `#player-balance` text content, stripping commas (same parsing as `blackjackClient.ts`). `serverSyncedBalance` is a private class field:

   ```typescript
   private serverSyncedBalance: number;

   constructor(settings: GameSettings) {
     const balanceEl = document.getElementById('player-balance');
     const rawText = balanceEl?.textContent ?? '';
     const parsed = Number(rawText.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0]);
     this.serverSyncedBalance = Number.isFinite(parsed) ? parsed : settings.startingChips;
     // ... rest of constructor
   }
   ```

3. On successful sync response, update `this.serverSyncedBalance` from the API response `balance` field (not local delta) to prevent 409 BALANCE_MISMATCH on rapid successive hands.

### Sync Payload

```typescript
{
  previousBalance: serverSyncedBalance,  // last confirmed server balance
  delta: number,                          // human's chip change this round
  gameType: 'poker',
  outcome: 'win' | 'loss' | 'push',
  handCount: 1,                           // always 1 per hand
  winsIncrement: 0 | 1,
  lossesIncrement: 0 | 1,
  biggestWinCandidate: number,            // pot won if win; 0 if loss or push
}
```

### Outcome Rules

`delta` is always `players[0].chips - humanChipsBefore` (balance diff from start of hand — not `currentBet` which resets each betting round).

| Situation                   | outcome | winsIncrement | lossesIncrement | biggestWinCandidate            | delta            |
| --------------------------- | ------- | ------------- | --------------- | ------------------------------ | ---------------- |
| Human wins (opponents fold) | `win`   | 1             | 0               | `potWon` (before `awardChips`) | positive         |
| Human wins showdown         | `win`   | 1             | 0               | `potWon` (before `awardChips`) | positive         |
| Human loses showdown        | `loss`  | 0             | 1               | 0                              | negative         |
| Human folds                 | `loss`  | 0             | 1               | 0                              | negative         |
| Tie / split pot             | `push`  | 0             | 0               | 0                              | positive or zero |

### `GAME_TYPES` Constant Update

**`src/lib/game-stats/constants.ts`** must add `'poker'` to three places:

```typescript
export const GAME_TYPES = ['blackjack', 'baccarat', 'craps', 'poker'] as const;

export const GAME_TYPE_LABELS: Record<(typeof GAME_TYPES)[number], string> = {
	blackjack: 'Blackjack',
	baccarat: 'Baccarat',
	craps: 'Craps',
	poker: 'Poker',
};

export const GAME_TYPE_ICONS: Record<(typeof GAME_TYPES)[number], string> = {
	blackjack: '🃏',
	baccarat: '🎰',
	craps: '🎲',
	poker: '♠️',
};
```

This also makes `isValidGameType('poker')` return `true`, which enables `recordGameRound()` to be called in `/api/chips/update`. **Side effect:** achievement checking (`checkAndGrantAchievements`) also gates on `isValidGameType`, so poker wins will now trigger achievement evaluation. This is intentional — poker stats should count toward milestones like "High Roller".

### Constraints

- One sync per hand (no batching) — same as Blackjack
- No additional schema changes — `gameStats` table already supports any `gameType` string
- Sync is best-effort (fire-and-forget); game play is not blocked on sync response
- `serverSyncedBalance` must be updated from the API response `balance` field, not computed locally
- **Rate limiting:** The endpoint enforces a 2-second minimum between requests. If a 429 is returned, the sync is silently dropped (stats for that hand are lost). Poker does **not** implement a pending-stats accumulator — the simplicity tradeoff is acceptable for a demo platform. This is intentional and should be noted in code comments.

---

## Files to Modify

### Feature 1 — Badge Column (8 files)

| File                                             | Change                                                   |
| ------------------------------------------------ | -------------------------------------------------------- |
| `src/lib/achievements/achievement-repository.ts` | Add `getBulkUserAchievements()`; add `inArray` import    |
| `src/lib/leaderboard/types.ts`                   | Add `badges: string[]` to `LeaderboardEntry`             |
| `src/lib/leaderboard/leaderboard-repository.ts`  | Call `getBulkUserAchievements` after fetching players    |
| `src/lib/leaderboard/leaderboard.ts`             | Pass `badgeMap` into `transformToLeaderboardEntries`     |
| `src/lib/game-stats/types.ts`                    | Add `badges: string[]` to `GameLeaderboardEntry`         |
| `src/lib/game-stats/game-stats-repository.ts`    | Call `getBulkUserAchievements` after fetching players    |
| `src/lib/game-stats/game-stats.ts`               | Pass `badgeMap` into `transformToGameLeaderboardEntries` |
| `src/pages/games/leaderboard.astro`              | Add Badges column to both table variants                 |

### Feature 2 — Poker Stats (4 files)

| File                              | Change                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/pages/games/poker.astro`     | Inject `user.chipBalance` into `#player-balance` DOM element                                       |
| `src/lib/poker/PokerGame.ts`      | Add `serverSyncedBalance`; capture `humanChipsBefore`; call `syncChips()` at all 3 round-end paths |
| `src/lib/game-stats/constants.ts` | Add `'poker'` to `GAME_TYPES`, `GAME_TYPE_LABELS`, `GAME_TYPE_ICONS`                               |
| `src/lib/game-stats/types.ts`     | `GameType` derives from `GAME_TYPES` const — no separate change needed once constants updated      |

---

## Testing

### Unit Tests

**Feature 1:**

- `achievement-repository.test.ts` — `getBulkUserAchievements`:
  - Multiple users, each with different achievements → correct emoji per user
  - User with no achievements → empty array in map
  - Empty `userIds` input → returns empty Map without querying DB
  - `achievementId` not in `ACHIEVEMENTS` list → skipped gracefully
- `leaderboard.test.ts` / `game-stats.test.ts` — update existing tests for `transformToLeaderboardEntries` and `transformToGameLeaderboardEntries` to pass the new `badgeMap` parameter (passing an empty `new Map()` is sufficient for tests not focused on badges)

**Feature 2 — 6 test scenarios covering the 3 `GameRoundOutcome` values (`win | loss | push`):**

- AI wins because all opponents fold (sole survivor is AI, `winner.id !== 0`) → no sync fires
- Human wins because all opponents fold (`winner.id === 0`) → `outcome: 'win'`, `winsIncrement: 1`, `biggestWinCandidate = pot`
- Human folds → `outcome: 'loss'`, `lossesIncrement: 1`, `delta = players[0].chips - humanChipsBefore` (negative), `biggestWinCandidate: 0`
- Human wins at showdown → `outcome: 'win'`, `biggestWinCandidate = pot captured before awardChips()`
- Human loses at showdown → `outcome: 'loss'`, `lossesIncrement: 1`
- Tie / split pot → `outcome: 'push'`, `winsIncrement: 0`, `lossesIncrement: 0`, `biggestWinCandidate: 0`

### E2E Tests

**Feature 1:**

- `leaderboard.spec.ts`:
  - Assert "Badges" column header is present on both overall and game tabs
  - Assert badge emoji appears for a user with at least one known achievement

**Feature 2:**

- `poker.spec.ts` (new or extend existing):
  - Complete a poker hand (win path) → assert `/api/chips/update` receives `gameType: 'poker'`
  - Assert chip balance updates server-side after hand completes
  - Assert Poker tab appears on leaderboard after stats are recorded

---

## Out of Scope

- Badge detail modal / hover expand (future)
- Achievement progress bars in leaderboard (future)
- Poker-specific achievement types (future)
- Time-based leaderboard resets (separate PRD phase)
