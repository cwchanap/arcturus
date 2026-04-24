# Leaderboard System - Future Improvements PRD

## Overview

This document outlines potential future enhancements for the Arcturus Casino Leaderboard System. The current implementation (v2.0) provides overall chip-balance rankings plus game-specific leaderboards with multiple ranking metrics.

## Current State (v2.0) — as of 2026-03-19

### Features Implemented

- Top 50 players ranked by chip balance (overall leaderboard)
- Game-specific leaderboards for Blackjack, Baccarat, Craps, and Poker
- Four ranking metrics per game: Wins, Win Rate, Biggest Win, Net Profit
- Win rate eligibility gate (minimum 10 decided hands to prevent inflation)
- Current user rank display (even if outside top 50)
- Medal emojis for top 3 positions
- Tab-based navigation (`/games/leaderboard?game=blackjack&metric=wins`)
- Metric selector UI for game tabs
- Responsive design with casino theme
- Protected route with authentication; API returns 401 if unauthenticated
- API endpoint for programmatic access

### Technical Stack

- Astro SSR page with server-side data fetching
- Drizzle ORM with Cloudflare D1
- Clean architecture (types → repository → business logic → API → UI)
- `gameStats` table tracking wins, losses, hands played, biggest win, net profit
- `userAchievement` table (schema ready and now in active use for leaderboard badges and achievement-award checks); notification UX remains future work
- Unit tests (22 leaderboard + game-stats repository + game-stats logic) and E2E tests (11)

### Key Files

- `src/lib/leaderboard/` — overall leaderboard logic and repository
- `src/lib/game-stats/` — game-specific stats logic, repository, types, constants
- `src/pages/games/leaderboard.astro` — UI with tabs and metric selector
- `src/pages/api/leaderboard/index.ts` — REST endpoint
- `e2e/leaderboard.spec.ts` — E2E test suite

---

## Future Improvements

### Phase 1: Time-Based Rankings

**Priority:** High
**Effort:** Medium
**Impact:** High engagement through competitive resets
**Status:** ❌ Not implemented

#### Requirements

- Add daily, weekly, and monthly leaderboard views
- Track historical chip balances at period boundaries
- Allow users to toggle between time periods

#### Technical Approach

1. Create `leaderboard_snapshot` table:
   ```sql
   CREATE TABLE leaderboard_snapshot (
     id TEXT PRIMARY KEY,
     userId TEXT NOT NULL REFERENCES user(id),
     chipBalance INTEGER NOT NULL,
     periodType TEXT NOT NULL, -- 'daily', 'weekly', 'monthly'
     periodStart INTEGER NOT NULL, -- timestamp
     createdAt INTEGER NOT NULL
   );
   ```
2. Scheduled Cloudflare Worker to capture snapshots at period boundaries
3. Calculate rankings based on balance delta within period
4. Add tab UI for period selection

#### Success Metrics

- Increased daily active users
- Higher engagement during reset periods

---

### Phase 2: Game-Specific Leaderboards

**Priority:** Medium
**Effort:** Medium
**Impact:** Deeper engagement per game
**Status:** ✅ Fully implemented

The `gameStats` table is live with `totalWins`, `totalLosses`, `handsPlayed`, `biggestWin`, and `netProfit` columns. Leaderboards exist for Blackjack, Baccarat, Craps, and Poker across four metrics. Poker is both recognized by the shared game-stats constants and actively populated through the same `game_stats` leaderboard pipeline as the other supported games.

---

### Phase 3: Social Features

**Priority:** Medium
**Effort:** High
**Impact:** Viral growth and retention
**Status:** ❌ Not implemented

#### Requirements

- Friend list with chip balance comparison
- Challenge friends to beat your rank
- Share leaderboard position on social media
- Leaderboard notifications (rank changes)

#### Technical Approach

1. Create `friendship` table for friend relationships
2. Add friend-filtered leaderboard view
3. Implement push notifications for rank changes
4. Add social sharing meta tags and buttons

#### Success Metrics

- Friend invites sent per user
- Social shares per week
- Notification-driven return visits

---

### Phase 4: Achievements & Badges

**Priority:** Low
**Effort:** Medium
**Impact:** Long-term engagement
**Status:** ⚠️ Mostly implemented — achievement awarding, leaderboard badge UI (`getBulkUserAchievements`, `badges: string[]` column), and achievement toast notification UX are all live for Blackjack, Baccarat, and Craps; two gaps remain

#### Requirements

- Award badges for leaderboard milestones
- Display badges on leaderboard entries
- Track achievement progress

#### Badge Ideas

| Badge       | Criteria                           |
| ----------- | ---------------------------------- |
| Rising Star | Enter top 50 for first time        |
| High Roller | Reach top 10                       |
| Champion    | Reach #1 position                  |
| Consistent  | Stay in top 50 for 7 days          |
| Comeback    | Re-enter top 50 after dropping out |

#### Remaining Work

1. Wire `achievement-toast` into `poker.astro` (Blackjack/Baccarat/Craps already done via `initAchievementToast`; Poker still missing the `#achievement-toast` element and the `initAchievementToast` call after `syncChips` resolves)
2. Add E2E tests for the Badges column in `leaderboard.spec.ts`:
   - Assert "Badges" column header is present on both the overall tab and game-specific tabs
   - Assert badge emoji appears for a user with at least one known achievement

---

### Phase 5: Tournament Integration

**Priority:** Low
**Effort:** High
**Impact:** Premium engagement feature
**Status:** ❌ Not implemented

#### Requirements

- Tournament-specific leaderboards
- Buy-in and prize pool display
- Bracket/progression visualization
- Historical tournament results

#### Technical Approach

1. Create tournament tables (see separate Tournament PRD)
2. Reuse leaderboard components for tournament rankings
3. Add tournament filter to leaderboard page
4. Create tournament history view

---

## Technical Debt & Improvements

### Code Quality

- [ ] Extract `jsonResponse` helper to shared utility (`src/lib/api-utils.ts`) — currently duplicated across API endpoints
- [ ] Extract `formatChips` / `Intl.NumberFormat` calls to shared utility (`src/lib/format-utils.ts`) — currently inline in `leaderboard.astro`
- [ ] Add database index on `user.chipBalance` for performance on top-player queries
- [ ] Consider caching leaderboard data (1-5 minute TTL)

### Performance

- [ ] Implement pagination (`offset` param) for viewing beyond top 50 — API currently supports `limit` only
- [ ] Add infinite scroll option
- [ ] Cache user rank calculation (invalidate on balance change)

### Testing

- [ ] Add integration tests for repository layer
- [ ] Add load testing for concurrent leaderboard requests
- [ ] Add visual regression tests for UI

---

## API Extensions

### Current Endpoint

```
GET /api/leaderboard
  ?limit=50 (max: 100)
```

### Proposed Extensions

```
GET /api/leaderboard
  ?limit=50
  &offset=0           # Pagination (not yet implemented)
  &period=all         # all, daily, weekly, monthly (not yet implemented)
  &game=poker         # Filter by game type (served by game-stats module)
  &friends=true       # Friends-only view (not yet implemented)

GET /api/leaderboard/user/:userId
  # Get specific user's rank and stats

GET /api/leaderboard/history
  ?period=weekly
  &count=10           # Historical rankings
```

---

## Success Metrics

| Metric                         | Current | Target (6mo) |
| ------------------------------ | ------- | ------------ |
| Daily leaderboard views        | -       | 500          |
| Avg. time on page              | -       | 45s          |
| Return visits from leaderboard | -       | 30%          |
| Users in top 50 retention      | -       | 70%          |

---

## Timeline Estimate

| Phase                  | Effort    | Status                       | Dependencies                                      |
| ---------------------- | --------- | ---------------------------- | ------------------------------------------------- |
| Phase 1: Time-Based    | 2-3 weeks | ❌ Not started               | Cloudflare scheduled workers                      |
| Phase 2: Game-Specific | 2 weeks   | ✅ Done                      | —                                                 |
| Phase 3: Social        | 4-5 weeks | ❌ Not started               | Friend system                                     |
| Phase 4: Achievements  | 2 weeks   | ⚠️ Poker toast + E2E missing | Wire poker achievement toast; add badge E2E tests |
| Phase 5: Tournaments   | 6+ weeks  | ❌ Not started               | Tournament system                                 |

---

## Open Questions

1. Should time-based leaderboards reset chip balances or just track deltas?
2. What's the minimum player count before showing a game-specific leaderboard?
3. Should anonymous/guest users see the leaderboard (read-only)?
4. How to handle inactive users in rankings (exclude after X days)?

---

## References

- Current implementation: `src/lib/leaderboard/`, `src/lib/game-stats/`
- Database schema: `src/db/schema.ts`
- Migrations: `drizzle/0003_marvelous_sasquatch.sql`, `drizzle/0004_wide_vin_gonzales.sql`
- E2E tests: `e2e/leaderboard.spec.ts`
- CLAUDE.md guidelines for new features
