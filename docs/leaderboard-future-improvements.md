# Leaderboard System - Future Improvements PRD

## Overview

This document outlines potential future enhancements for the Arcturus Casino Leaderboard System. The current implementation (v1.0) provides a solid foundation with top 50 rankings by chip balance.

## Current State (v1.0)

### Features Implemented

- Top 50 players ranked by chip balance
- Current user rank display (even if outside top 50)
- Medal emojis for top 3 positions
- Responsive design with casino theme
- Protected route with authentication
- API endpoint for programmatic access

### Technical Stack

- Astro SSR page with server-side data fetching
- Drizzle ORM with Cloudflare D1
- Clean architecture (types → repository → business logic)
- Unit tests (12) and E2E tests (11)

---

## Future Improvements

### Phase 1: Time-Based Rankings

**Priority:** High
**Effort:** Medium
**Impact:** High engagement through competitive resets

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
2. Scheduled worker to capture snapshots at period boundaries
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

#### Requirements

- Separate leaderboards for Poker, Blackjack, Baccarat
- Track game-specific statistics (hands won, biggest pot, etc.)
- Show game-specific badges/achievements

#### Technical Approach

1. Create `game_stats` table:
   ```sql
   CREATE TABLE game_stats (
     userId TEXT NOT NULL REFERENCES user(id),
     gameType TEXT NOT NULL, -- 'poker', 'blackjack', 'baccarat'
     totalWins INTEGER DEFAULT 0,
     totalLosses INTEGER DEFAULT 0,
     handsPlayed INTEGER DEFAULT 0,
     biggestWin INTEGER DEFAULT 0,
     updatedAt INTEGER NOT NULL,
     PRIMARY KEY (userId, gameType)
   );
   ```
2. Update chip sync endpoint to record game stats
3. Add game filter to leaderboard page
4. Create game-specific ranking queries

#### Success Metrics

- Increased time per game session
- Higher variety in games played

---

### Phase 3: Social Features

**Priority:** Medium
**Effort:** High
**Impact:** Viral growth and retention

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

#### Technical Approach

1. Create `achievement` and `user_achievement` tables
2. Add achievement checking logic to leaderboard updates
3. Display badges in leaderboard UI
4. Add achievement notification system

---

### Phase 5: Tournament Integration

**Priority:** Low
**Effort:** High
**Impact:** Premium engagement feature

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

- [ ] Extract `jsonResponse` helper to shared utility (`src/lib/api-utils.ts`)
- [ ] Extract `formatChips` to shared utility (`src/lib/format-utils.ts`)
- [ ] Add database index on `user.chipBalance` for performance
- [ ] Consider caching leaderboard data (1-5 minute TTL)

### Performance

- [ ] Implement pagination for viewing beyond top 50
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
  &offset=0           # Pagination
  &period=all         # all, daily, weekly, monthly
  &game=poker         # Filter by game type
  &friends=true       # Friends-only view

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

| Phase                  | Effort    | Dependencies                 |
| ---------------------- | --------- | ---------------------------- |
| Phase 1: Time-Based    | 2-3 weeks | Cloudflare scheduled workers |
| Phase 2: Game-Specific | 2 weeks   | Game stats tracking          |
| Phase 3: Social        | 4-5 weeks | Friend system                |
| Phase 4: Achievements  | 2 weeks   | Achievement system           |
| Phase 5: Tournaments   | 6+ weeks  | Tournament system            |

---

## Open Questions

1. Should time-based leaderboards reset chip balances or just track deltas?
2. What's the minimum player count before showing a game-specific leaderboard?
3. Should anonymous/guest users see the leaderboard (read-only)?
4. How to handle inactive users in rankings (exclude after X days)?

---

## References

- Current implementation: `src/lib/leaderboard/`
- Database schema: `src/db/schema.ts`
- E2E tests: `e2e/leaderboard.spec.ts`
- CLAUDE.md guidelines for new features
