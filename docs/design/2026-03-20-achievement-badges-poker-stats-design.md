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

1. After fetching top-N players, run a single bulk query against `user_achievement`:
   ```sql
   SELECT userId, achievementId FROM user_achievement WHERE userId IN (...)
   ```
2. Group results by `userId` in application code — no N+1 queries.
3. Map `achievementId` → emoji icon using the existing `ACHIEVEMENTS` definition array.
4. Enrich leaderboard entries with a `badges: string[]` field (emoji array, empty if none).
5. Render a dedicated "Badges" column in the leaderboard table.

### New Function

**`achievement-repository.ts`** — add:

```typescript
getBulkUserAchievements(db: Database, userIds: string[]): Promise<Map<string, string[]>>
```

Returns a map of `userId → achievement emoji[]` for efficient batch lookup.

### Type Changes

- `LeaderboardEntry` (in `src/lib/leaderboard/types.ts`) — add `badges: string[]`
- `GameLeaderboardEntry` (in `src/lib/game-stats/types.ts`) — add `badges: string[]`

### UI Changes

**`src/pages/games/leaderboard.astro`**:

- Add `<th>Badges</th>` column header to both overall and game-specific tables
- Add `<td>` per row rendering emoji icons joined by spaces, or `—` if empty
- No expand/modal needed — keep scope minimal

### Constraints

- No schema changes — `user_achievement` table already exists
- No new API endpoint — badges fetched server-side during leaderboard SSR
- Empty badge cell renders `—` (not hidden) to preserve column alignment

---

## Feature 2: Poker Game Stats

### Goal

Poker is the only game excluded from game-specific leaderboards. The `/api/chips/update` endpoint already accepts `gameType: 'poker'`; the gap is that `PokerGame.ts` never calls it.

### Hook Points

`PokerGame.ts` has two round-ending paths where the sync call is added:

| Path     | Location       | Trigger                                 |
| -------- | -------------- | --------------------------------------- |
| Fold win | ~line 491      | All opponents fold; one player wins pot |
| Showdown | ~lines 522–560 | Cards compared; winner(s) determined    |

In both paths, after chips are awarded to winner(s), call `syncChips()` with the human player's round result.

### Human Player Identification

The human player has `id === 'human'` in `this.players`. Delta is computed as:

```
delta = humanChipsAfter - humanChipsBefore
```

`humanChipsBefore` is captured at the start of each round (when blinds/antes are posted).

### Sync Payload

```typescript
{
  previousBalance: serverSyncedBalance,  // last confirmed server balance
  delta: number,                          // human's chip change this round
  gameType: 'poker',
  outcome: 'win' | 'loss' | 'push',      // push = tie/split pot
  handCount: 1,                           // always 1 per hand
  winsIncrement: 0 | 1,
  lossesIncrement: 0 | 1,
  biggestWinCandidate: number,            // pot won if win, else 0
}
```

### State Tracking

A `serverSyncedBalance` variable (mirroring the Blackjack pattern) is added to `PokerGame.ts` to track the last server-confirmed chip count. Initialized from the chip balance passed to the constructor. Updated on successful sync response.

### Outcome Rules

| Situation                             | outcome | winsIncrement | lossesIncrement |
| ------------------------------------- | ------- | ------------- | --------------- |
| Human wins pot                        | `win`   | 1             | 0               |
| Human loses (folds or loses showdown) | `loss`  | 0             | 1               |
| Tie / split pot                       | `push`  | 0             | 0               |

### Constraints

- One sync per hand (no batching) — same as Blackjack
- No schema changes — `gameStats` table already supports `gameType = 'poker'`
- No changes to `/api/chips/update` endpoint — `'poker'` is already a valid game type
- Sync is best-effort (fire-and-forget with error logging); game is not blocked on sync response

---

## Files to Modify

### Feature 1 — Badge Column

| File                                             | Change                                              |
| ------------------------------------------------ | --------------------------------------------------- |
| `src/lib/achievements/achievement-repository.ts` | Add `getBulkUserAchievements()`                     |
| `src/lib/leaderboard/types.ts`                   | Add `badges: string[]` to `LeaderboardEntry`        |
| `src/lib/leaderboard/leaderboard-repository.ts`  | Call bulk achievements query after fetching players |
| `src/lib/leaderboard/leaderboard.ts`             | Pass badges through to return value                 |
| `src/lib/game-stats/types.ts`                    | Add `badges: string[]` to `GameLeaderboardEntry`    |
| `src/lib/game-stats/game-stats-repository.ts`    | Call bulk achievements query after fetching players |
| `src/lib/game-stats/game-stats.ts`               | Pass badges through to return value                 |
| `src/pages/games/leaderboard.astro`              | Add Badges column to both table variants            |

### Feature 2 — Poker Stats

| File                         | Change                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/lib/poker/PokerGame.ts` | Add `serverSyncedBalance`, capture `humanChipsBefore`, call `syncChips()` at both round-end paths |
| `src/lib/poker/types.ts`     | Add sync-related fields if needed                                                                 |

---

## Testing

### Unit Tests

- `achievement-repository.test.ts` — test `getBulkUserAchievements()` with multiple users, empty input, users with no achievements
- `PokerGame.test.ts` (if exists) or new test — test that `syncChips` is called with correct payload for win/loss/push/fold scenarios

### E2E Tests

- `leaderboard.spec.ts` — assert Badges column header exists; assert badge emojis appear for a user with known achievements
- `poker.spec.ts` (if exists) — assert that completing a poker hand triggers a chips/update call (via network intercept or balance change)

---

## Out of Scope

- Badge detail modal / hover expand (future)
- Achievement progress bars in leaderboard (future)
- Poker-specific achievement types (future)
- Time-based leaderboard resets (separate PRD phase)
