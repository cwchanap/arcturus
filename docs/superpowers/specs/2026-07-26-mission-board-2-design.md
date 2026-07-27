# Mission Board 2.0 Design

Linear: [HPA-173 — Mission Board 2.0: daily quests, streaks, and weekly goals](https://linear.app/cwchanap/issue/HPA-173/mission-board-20-daily-quests-streaks-and-weekly-goals)

## Goal

Create a repeatable progression loop that rewards players for returning, trying different games, and completing measurable gameplay objectives. Replaces the single Daily Login mission with a full mission board: multiple daily quests, a weekly goal, a 7-day login streak, daily rerolls, and idempotent reward claiming.

## Resolved Design Decisions

| Decision | Choice |
|----------|--------|
| Progress tracking | Dedicated `mission_progress` table, incremented inline during validated chip sync |
| Period reset | Lazy reset on read via UTC period keys (no cron) |
| Mission definitions | Code registry in `src/lib/missions/registry.ts` (not DB-configurable) |
| Event source | `/api/chips/update` + `/api/mp/settle` (existing validated event stream) |
| Daily login | Folded into streak system; day-1 reward = 1000 chips for migration continuity |
| Streak curve | 7-day cycle: `[1000, 1250, 1500, 2000, 2500, 3500, 5000]`, then resets to day 1 |
| Reroll | One daily swap per period; replacement drawn from non-active pool |
| Claim atomicity | In-SQL `changes() = 1` cascade in one D1 batch (matching `chip-sync-batch-sql.ts` pattern); grant statement gated on claim statement's `changes()` |
| Claim scope | Current period only — server computes periodKey, not the client |
| Deploy migration | Seed `login_streak` from old `mission` table (gated on streak row not existing) to prevent double-claim on deploy day |
| Streak display | Effective streak computed on read (continuing vs broken) so the board never shows a stale streak |
| Atomicity mechanism | Raw D1 `dbBinding.batch()` for multi-statement atomicity (Drizzle `db` has no `.batch()`); conditional gates via `WHERE changes() = 1` in SQL |
| netChipsEarned | Dropped for MVP — no starter/reroll mission uses it and the spec was self-contradictory |
| Icons | Emoji from `GAME_TYPE_ICONS` (game-stats/constants.ts), not DecoIcon names (DecoIcon only has 6 generic names) |

## Architecture

### Module structure

The existing `src/lib/missions.ts` (single file, 208 lines) is replaced by a modular directory:

```
src/lib/missions/
├── registry.ts          # MissionDefinition[] + MissionMetric union
├── periods.ts           # getDailyPeriodKey, getWeeklyPeriodKey, next-reset timestamps
├── progress.ts          # applyMissionProgress(), getBoardState(), claim flow
├── streak.ts            # streak continuation/breakage logic + reward curve
├── reroll.ts            # reroll validation + replacement selection
├── types.ts             # shared interfaces (BoardState, MissionView, GameEvent, etc.)
└── *.test.ts            # unit tests for each module
```

### New files

```
src/pages/missions/index.astro           # Board page (streak banner + daily grid + weekly card)
src/pages/api/missions/board.ts           # GET — full board state
src/pages/api/missions/claim.ts           # POST — claim a quest reward
src/pages/api/missions/claim-login.ts     # POST — claim daily login streak reward
src/pages/api/missions/reroll.ts          # POST — swap one uncompleted daily quest
src/pages/api/missions/progress.ts        # DELETE — dev-only reset (gated by import.meta.env.DEV)
src/lib/missions/registry.ts
src/lib/missions/periods.ts
src/lib/missions/progress.ts
src/lib/missions/streak.ts
src/lib/missions/reroll.ts
src/lib/missions/types.ts
src/lib/missions/*.test.ts
e2e/missions.spec.ts                      # E2E: complete, claim, streak, reroll, post-reset
```

### Removed files

- `src/lib/missions.ts` — replaced by the `src/lib/missions/` directory.
- `src/pages/missions/daily.astro` — replaced by `src/pages/missions/index.astro`.
- `src/pages/api/missions/daily-login.ts` — replaced by `/api/missions/board` + `/api/missions/claim-login`.

### Integration touchpoints (existing files)

- `src/pages/api/chips/update.ts` — a single call to `applyMissionProgress` just before the final `return buildSuccessResponse(...)` (line ~1601). This is naturally replay-safe because all receipt-replay branches return early (lines 1139/1181/1332/1374). Only called when `outcome` is present and `gameType` is a valid game (same guard as `recordGameRound`). Built from already-validated fields. Wrapped in try/catch so failures never break chip sync. Note: `recordGameRound` only runs in the legacy no-syncId branch (line 1545) — most games go through `applyChipSyncBatch` (line 1285) — so the call must NOT be tied to `recordGameRound`.
- `src/pages/api/mp/settle.ts` — after the settle batch, for each newly-applied entry (not idempotent replays), call `applyMissionProgress` with `{ gameType: 'poker_mp', outcome, handCount: 1, winsIncrement, lossesIncrement, delta }` for the `mpHandsCompleted` metric.
- `src/db/schema.ts` — add three new tables (see Data Model below) via Drizzle migration (`bun run db:generate` + `bun run db:migrate:local`). The new tables are created by migration SQL, not runtime DDL. The old `ensureMissionSchema()` runtime CREATE TABLE in `missions.ts` is removed.
- `src/layouts/AppLayout.astro` — update nav links from `/missions/daily` → `/missions` (header line 73 + footer line 111).
- `src/pages/index.astro` — update CTA buttons from `/missions/daily` → `/missions` (lines 153, 219).
- `e2e/global-setup.ts` — update navigation from `/missions/daily` → `/missions` (line 49).

## Data Model

### `mission_progress` table

Per-user, per-mission, per-period progress tracking.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | text NOT NULL | FK → user(id) ON DELETE CASCADE |
| `missionDefId` | text NOT NULL | References code registry id (validated at read time) |
| `periodKey` | text NOT NULL | `'2026-07-26'` (daily) / `'2026-W30'` (weekly) |
| `progress` | integer NOT NULL DEFAULT 0 | Clamped at target |
| `metadataJson` | text | For `gamesTried`: `["blackjack","poker"]` distinct set |
| `completedAt` | integer (timestamp) | Set when progress first reaches target; null before |
| `claimedAt` | integer (timestamp) | Set when reward claimed; null before |

Primary key: `(userId, missionDefId, periodKey)`.

**Lazy reset**: on read, query for the row matching the *current* periodKey. If no row exists (new period), progress is 0, not started. Old-period rows remain harmlessly (bounded growth: ~5 daily missions × 365 days = ~1800 rows/user/year; ~1 weekly × 52 weeks = 52 rows/user/year).

Drizzle definition:

```typescript
export const missionProgress = sqliteTable(
	'mission_progress',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		missionDefId: text('missionDefId').notNull(),
		periodKey: text('periodKey').notNull(),
		progress: integer('progress').notNull().default(0),
		metadataJson: text('metadataJson'),
		completedAt: integer('completedAt', { mode: 'timestamp' }),
		claimedAt: integer('claimedAt', { mode: 'timestamp' }),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.missionDefId, table.periodKey] }),
	}),
);
```

### `login_streak` table

7-day login streak tracking.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | text PRIMARY KEY | FK → user(id) ON DELETE CASCADE |
| `currentStreak` | integer NOT NULL DEFAULT 0 | Current consecutive-day count |
| `longestStreak` | integer NOT NULL DEFAULT 0 | All-time best |
| `lastClaimPeriodKey` | text NOT NULL DEFAULT `''` | Daily key of last claim; empty = never claimed |

Drizzle definition:

```typescript
export const loginStreak = sqliteTable(
	'login_streak',
	{
		userId: text('userId')
			.primaryKey()
			.references(() => user.id, { onDelete: 'cascade' }),
		currentStreak: integer('currentStreak').notNull().default(0),
		longestStreak: integer('longestStreak').notNull().default(0),
		lastClaimPeriodKey: text('lastClaimPeriodKey').notNull().default(''),
	},
);
```

### `mission_override` table

Reroll tracking — records when a daily mission was swapped for a different one.

| Column | Type | Notes |
|--------|------|-------|
| `userId` | text NOT NULL | FK → user(id) ON DELETE CASCADE |
| `periodKey` | text NOT NULL | Daily period key when reroll occurred |
| `originalMissionDefId` | text NOT NULL | The mission that was swapped out |
| `replacementMissionDefId` | text NOT NULL | The mission swapped in |
| `rerolledAt` | integer NOT NULL (timestamp) | When the reroll happened |

Primary key: `(userId, periodKey, originalMissionDefId)`.

Reroll-used check: count of overrides for the current daily periodKey ≥ 1.

Drizzle definition:

```typescript
export const missionOverride = sqliteTable(
	'mission_override',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		periodKey: text('periodKey').notNull(),
		originalMissionDefId: text('originalMissionDefId').notNull(),
		replacementMissionDefId: text('replacementMissionDefId').notNull(),
		rerolledAt: integer('rerolledAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.periodKey, table.originalMissionDefId] }),
	}),
);
```

### Existing `mission` table

The old `mission` table (`userId`, `missionId`, `completedDate`) is read once during deploy-day seeding (see Migration section), then left in place — harmless, no longer read or written after seeding. Can be dropped in a future cleanup migration. The table is created by the initial Drizzle migration (`drizzle/0000_powerful_wrecking_crew.sql`), not only by runtime DDL, so it is safe to query during the seeding backfill.

## Mission Registry

### Types

```typescript
// src/lib/missions/types.ts

type MissionMetric =
	| { kind: 'handsPlayed'; gameType?: string }   // gameType omitted = any game; string (not GameType) so poker_mp is expressible
	| { kind: 'roundsWon'; gameType?: string }
	| { kind: 'spinsCompleted' }                      // slots only (roulette is server-settled, see note)
	| { kind: 'mpHandsCompleted' }
	| { kind: 'gamesTried' };                         // distinct gameTypes (metadataJson)

interface MissionDefinition {
	id: string;              // e.g. 'daily-blackjack-5'
	title: string;
	description: string;
	period: 'daily' | 'weekly';
	metric: MissionMetric;
	target: number;
	rewardChips: number;
	icon: string;            // Emoji from GAME_TYPE_ICONS (game-stats/constants.ts) or generic emoji
}
```

### Event type (shared)

```typescript
interface MissionGameEvent {
	gameType: string;       // 'blackjack' | 'poker' | 'baccarat' | 'craps' | 'slots' | 'roulette' | 'keno' | 'poker_mp'
	outcome: 'win' | 'loss' | 'push' | null;
	handCount: number;
	winsIncrement: number;
	lossesIncrement: number;
	delta: number;
}
```

### Metric → event field mapping

| Metric | Increment | Condition |
|--------|-----------|-----------|
| `handsPlayed` | `event.handCount` | `event.gameType` matches `metric.gameType` (or any if omitted) |
| `roundsWon` | `event.winsIncrement` (fallback: `outcome === 'win' ? 1 : 0`) | `event.gameType` matches |
| `spinsCompleted` | `event.handCount` | `event.gameType === 'slots'` |
| `mpHandsCompleted` | `1` | `event.gameType === 'poker_mp'` |
| `gamesTried` | `1` | `event.gameType` not already in `metadataJson` array. Note: `'poker'` and `'poker_mp'` are distinct gameTypes for variety tracking. |

> **Roulette note**: Roulette is server-settled via `/api/roulette/spin` (not `/api/chips/update`). For MVP, `spinsCompleted` only counts slots. Wiring roulette's spin endpoint to call `applyMissionProgress` is a small follow-up (the spin handler already has `netDelta` and `handCount=1`).

> **handCount semantics**: `handCount` means different things per game. Blackjack sends one per split hand (a single round with two splits sends `handCount=3`). Slots coalesces up to `MAX_SLOTS_SYNC_HANDS_PER_REQUEST` spins per request. Missions that count `handsPlayed[gameType]` will complete faster than the mission title implies for these games. Document the actual semantics in the UI tooltip, not the title.

Progress is clamped at `target` (never over-counts). `completedAt` is set the moment `progress >= target`, via an atomic conditional update (only set if currently null).

### Starter mission set

**Daily quests:**

| id | title | metric | target | reward |
|----|-------|--------|--------|--------|
| `daily-blackjack-5` | Blackjack Streak | `handsPlayed[blackjack]` | 5 | 500 |
| `daily-win-3` | Three Wins | `roundsWon` (any) | 3 | 750 |
| `daily-slots-20` | Spin to Win | `spinsCompleted` | 20 | 500 |
| `daily-mp-1` | Social Player | `mpHandsCompleted` | 1 | 1000 |

**Weekly goal:**

| id | title | metric | target | reward |
|----|-------|--------|--------|--------|
| `weekly-games-3` | Variety Seeker | `gamesTried` | 3 | 2000 |

## Period Key Computation

All period logic uses UTC. Lives in `src/lib/missions/periods.ts` as pure functions.

```typescript
function getDailyPeriodKey(date = new Date()): string {
	return date.toISOString().slice(0, 10); // 'YYYY-MM-DD' in UTC
}

function getWeeklyPeriodKey(date = new Date()): string {
	// ISO 8601 week: Monday-based, 'YYYY-WNN'
	const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = (tmp.getUTCDay() + 6) % 7; // Mon=0..Sun=6
	tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3); // nearest Thursday
	const weekNum =
		1 + Math.round((tmp.getTime() - Date.UTC(tmp.getUTCFullYear(), 0, 4)) / 604800000);
	return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

function getDailyPeriodKeyForYesterday(date = new Date()): string {
	const d = new Date(date);
	d.setUTCDate(d.getUTCDate() - 1);
	return getDailyPeriodKey(d);
}

function getNextDailyReset(date = new Date()): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + 1);
	next.setUTCHours(0, 0, 0, 0);
	return next;
}

function getNextWeeklyReset(date = new Date()): Date {
	const next = new Date(date);
	const dayNum = (next.getUTCDay() + 6) % 7; // Mon=0
	const daysUntilMonday = dayNum === 0 ? 7 : 7 - dayNum;
	next.setUTCDate(next.getUTCDate() + daysUntilMonday);
	next.setUTCHours(0, 0, 0, 0);
	return next;
}
```

## Streak System

The daily login reward becomes a **streak claim**, separate from gameplay missions.

### Logic

On claim (`POST /api/missions/claim-login`):

1. Compute `today = getDailyPeriodKey()`, `yesterday = getDailyPeriodKeyForYesterday()`.
2. Load (or create) the user's `login_streak` row.
3. If `lastClaimPeriodKey === today` → idempotent no-op, return current state with `status: 'already-claimed'`.
4. If `lastClaimPeriodKey === yesterday` → `currentStreak += 1` (streak continues).
5. Otherwise → `currentStreak = 1` (streak broken or first-ever claim).
6. `longestStreak = max(longestStreak, currentStreak)`.
7. Compute reward via the day-of-cycle index: `dayOfCycle = ((currentStreak - 1) % 7) + 1`.
8. Grant chips, set `lastClaimPeriodKey = today`.

### Reward curve

Streak day (1-indexed) → reward chips:

| Day | 1 | 2 | 3 | 4 | 5 | 6 | 7 |
|-----|---|---|---|---|---|---|---|
| Reward | 1000 | 1250 | 1500 | 2000 | 2500 | 3500 | 5000 |

```typescript
const STREAK_REWARDS = [1000, 1250, 1500, 2000, 2500, 3500, 5000] as const;

function getStreakReward(currentStreak: number): number {
	const dayOfCycle = ((currentStreak - 1) % STREAK_REWARDS.length) + 1;
	return STREAK_REWARDS[dayOfCycle - 1];
}
```

After day 7, the reward cycles back to day 1 (1000). The streak count keeps climbing for `longestStreak` tracking — only the reward position cycles, not the streak itself.

### Effective streak on read (display)

`getBoardState` computes an **effective streak** for display/preview so the board never shows a stale streak after a gap:

| `lastClaimPeriodKey` | Display | `claimableToday` | `rewardPreview` |
|----------------------|---------|-------------------|-----------------|
| `=== today` | Stored `currentStreak` (claimed) | `false` | 0 |
| `=== yesterday` | Stored `currentStreak` (continuing) | `true` | `getStreakReward(currentStreak + 1)` |
| else (gap or never) | 0 (broken) | `true` | `getStreakReward(1)` = 1000 |

The stored `currentStreak` is only updated on claim. The display uses the effective value above so a user who missed days doesn't see "5-day streak" followed by a reset to 1.

## Reroll Mechanism

### Flow

1. Client `POST /api/missions/reroll` with body `{ missionDefId }`.
2. Server validates:
   - Mission is `period: 'daily'`.
   - No `mission_override` row exists for `(userId, currentDailyPeriodKey, *)` (one reroll per day).
   - Target mission is uncompleted (`completedAt` is null) and unclaimed (`claimedAt` is null) for the current period.
3. Selects a random replacement from daily mission definitions that are **not currently active** (not in the default daily set shown on the board, and not already a replacement target for this period).
4. Writes a `mission_override` row.
5. The swapped-out mission's progress row is orphaned (harmless — it has a different `missionDefId`, so it won't interfere).

### Board rendering with overrides

When building the board state, for each default daily mission definition, check if an override exists where `originalMissionDefId === definition.id` and `periodKey === currentDailyPeriodKey`. If so, replace it with the `replacementMissionDefId`'s definition and progress. The `isOverride: true` flag lets the UI show a reroll indicator.

### Replacement pool

The replacement pool = all daily mission definitions − those currently shown on the board (including any existing overrides). If the pool is empty (all missions already active), the reroll endpoint returns a 409 with `{ error: 'NO_REPLACEMENT_AVAILABLE' }`.

For MVP, the starter set has 4 daily missions. Additional definitions should be added to the registry to give the reroll pool depth (at least 2–3 extra daily missions beyond the default board). These extra missions are defined in the registry but not included in the default board array.

```typescript
// registry.ts
export const DEFAULT_DAILY_MISSIONS: MissionDefinition[] = [ /* 4 starter daily quests */ ];
export const REROLL_POOL_DAILY: MissionDefinition[] = [ /* 2-3 extra daily quests */ ];
export const DEFAULT_WEEKLY_MISSIONS: MissionDefinition[] = [ /* 1 weekly goal */ ];
export const ALL_DAILY_DEFINITIONS = [...DEFAULT_DAILY_MISSIONS, ...REROLL_POOL_DAILY];
```

Extra reroll-pool missions (suggested):

| id | title | metric | target | reward |
|----|-------|--------|--------|--------|
| `daily-craps-3` | Dice Roller | `handsPlayed[craps]` | 3 | 500 |
| `daily-baccarat-3` | Baccarat Round | `handsPlayed[baccarat]` | 3 | 500 |
| `daily-keno-5` | Lucky Numbers | `handsPlayed[keno]` | 5 | 600 |

> Roulette is excluded from the reroll pool because it is server-settled via `/api/roulette/spin` and not yet wired to `applyMissionProgress`. Drawing an uncompletable mission would brick that slot. Add it back once the roulette spin endpoint is wired.

## Progress Application

### `applyMissionProgress()`

Called from `/api/chips/update` and `/api/mp/settle` after a validated round succeeds. Requires the raw D1 binding (`locals.runtime.env.DB`) for atomic batch operations — the Drizzle `db` wrapper has no `.batch()` method (see existing pattern in `chips/update.ts` and `mp/settle.ts`).

**Hot-path budget**: Two D1 reads + one batch write per chip sync. To minimize cost:
1. Skip entirely when `outcome` is absent (`null` or `undefined`) — same guard as `recordGameRound`.
2. Fold the overrides query into the progress query: a single `SELECT` that joins `mission_progress` with `mission_override` for the user and current period keys. Or: issue one combined batch of two read statements (`d1.batch([overridesStmt, progressStmt])`) to avoid sequential round-trips.
3. **Awaited** (blocking the response, same as `recordGameRound`/`checkAndGrantAchievements` today) so progress is consistent when the user navigates to the board. Wrapped in try/catch so failures never break chip sync.

```typescript
async function applyMissionProgress(
	d1: D1Database,
	userId: string,
	event: MissionGameEvent,
): Promise<void> {
	// Early exit: skip when no countable event
	if (!event.outcome) return;

	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();

	// ONE query: load all overrides for (userId, dailyKey)
	const overrides = await getOverrides(d1, userId, dailyKey);
	// Build active daily list (default board with overrides applied)
	const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
	const allWeekly = DEFAULT_WEEKLY_MISSIONS;

	// ONE query: load existing progress rows for all active mission IDs
	// (needed for gamesTried dedup + completedAt conditional)
	const activeDefIds = [...activeDaily, ...allWeekly].map((d) => d.id);
	const existingProgress = await getProgressRows(d1, userId, activeDefIds, dailyKey, weeklyKey);

	// Compute all increments
	const statements: D1PreparedStatement[] = [];
	for (const def of [...activeDaily, ...allWeekly]) {
		const periodKey = def.period === 'daily' ? dailyKey : weeklyKey;
		const existing = existingProgress.get(`${def.id}:${periodKey}`);
		const result = computeIncrement(def, event, existing);
		if (result.amount > 0) {
			statements.push(buildProgressUpsert(d1, userId, def, periodKey, result));
		}
	}

	// Apply all increments in one atomic D1 batch
	if (statements.length > 0) {
		await d1.batch(statements);
	}
}
```

`getActiveDailyMissions` (inline above via `applyOverrides`) returns the current board **with overrides applied** — a swapped-out mission will NOT receive further increments, and the replacement mission WILL.

`computeIncrement` applies the metric mapping table and returns `{ amount, metadata? }`. For `gamesTried`, it checks the existing `metadataJson` array (loaded in the batch query) for dedup. Race note: two parallel game finishes could both see a gameType as absent and both increment — last-write-wins on `metadataJson` may drop a distinct game. This is a rare under-count, acceptable for MVP.

`buildProgressUpsert` produces a raw D1 prepared statement using `INSERT ... ON CONFLICT DO UPDATE` with:
- **Progress clamp**: `SET progress = MIN(progress + amount, target)` so stored progress never exceeds target.
- **Conditional completedAt**: `SET completedAt = CASE WHEN MIN(progress + amount, target) >= target AND completedAt IS NULL THEN ? ELSE completedAt END`.
- **metadataJson merge** for `gamesTried` (only if a new gameType was added).

### Where it's called

**`/api/chips/update.ts`** — in the success path, after the existing `recordGameRound` / `checkAndGrantAchievements` calls. Only when `outcome` is present and `gameType` is valid (same guard as `recordGameRound`). Wrapped in the same try/catch so mission progress failures are caught and logged, never fatal to the chip sync.

**`/api/mp/settle.ts`** — after the settle batch, for each newly-applied entry (skip idempotent replays — they're already in `chip_sync_receipt`). Derive outcome from `entry.delta > 0 ? 'win' : entry.delta < 0 ? 'loss' : 'push'` (same logic the receipt uses). Wrapped in try/catch.

## API Endpoints

### `GET /api/missions/board`

Returns the full board state for the current user.

```typescript
{
	streak: {
		current: number;
		longest: number;
		claimableToday: boolean;
		dayOfCycle: number;        // 1-7
		rewardPreview: number;     // what claiming today would yield
		lastClaimPeriodKey: string;
	};
	daily: MissionView[];          // includes overrides applied
	weekly: MissionView[];
	rerollAvailable: boolean;
	nextDailyReset: string;        // ISO timestamp
	nextWeeklyReset: string;
	chipBalance: number;
}
```

```typescript
interface MissionView {
	missionDefId: string;
	title: string;
	description: string;
	icon: string;
	period: 'daily' | 'weekly';
	progress: number;
	target: number;
	completed: boolean;           // progress >= target
	claimed: boolean;              // claimedAt !== null
	claimable: boolean;            // completed && !claimed
	rewardChips: number;
	isOverride: boolean;           // true if this replaced an original via reroll
}
```

### `POST /api/missions/claim`

Body: `{ missionDefId: string }`.

The server computes the current period key — `periodKey` is NOT accepted from the client. This prevents claiming historical periods and keeps the contract simple: only the current period is claimable.

**Claim algorithm (prevents double-pay under concurrency):**

Uses the same in-SQL `changes() = 1` cascade pattern as the chip-sync batch (`src/lib/chip-sync-batch-sql.ts`). D1 batch executes every statement unconditionally — JS can't gate statement 2 on statement 1's `changes()` after the batch returns. So the gate lives in the SQL.

```sql
-- Step 1: conditional UPDATE — only sets claimedAt if not already claimed
UPDATE mission_progress
SET claimedAt = ?
WHERE userId = ? AND missionDefId = ? AND periodKey = ?
  AND claimedAt IS NULL
  AND progress >= ?;   -- target from registry

-- Step 2: chip grant gated on step 1's changes() — only grants if claim succeeded
UPDATE user SET chipBalance = chipBalance + ? WHERE id = ? AND changes() = 1;
```

Both statements run in one `d1.batch([step1, step2])`. If step 1 affected 0 rows (already claimed or progress < target), `changes()` is 0, and step 2's `WHERE changes() = 1` prevents the chip grant. This is atomic — no crash window between claim and grant.

Idempotent: if already claimed, `changes() = 0` → no grant → returns `{ status: 'already-claimed', rewardChips: 0, chipBalance }` with 200.

If no `mission_progress` row exists at all (never started), `changes() = 0` → returns `{ status: 'not-completed' }`.

### `POST /api/missions/claim-login`

No body needed (uses session user).

**Claim algorithm (prevents double-pay under concurrency):**

Same in-SQL `changes() = 1` cascade pattern. Always uses the `INSERT ... ON CONFLICT DO UPDATE ... WHERE` form — no read-then-branch needed for the race (the WHERE handles it):

```sql
-- Step 1: conditional upsert — only updates if lastClaimPeriodKey != today
INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey)
VALUES (?, ?, ?, ?)
ON CONFLICT (userId) DO UPDATE SET
  currentStreak = excluded.currentStreak,
  longestStreak = excluded.longestStreak,
  lastClaimPeriodKey = excluded.lastClaimPeriodKey
WHERE login_streak.lastClaimPeriodKey != ?;  -- today

-- Step 2: chip grant gated on step 1's changes()
UPDATE user SET chipBalance = chipBalance + ? WHERE id = ? AND changes() = 1;
```

Both statements run in one `d1.batch()`. The read to compute transition values (new streak, reward) happens before the batch — it's not for the race guard, it's to compute the new streak numbers. The WHERE clause on the upsert handles the race.

Idempotent: if `lastClaimPeriodKey === today`, `changes() = 0` → no grant → returns `{ status: 'already-claimed', rewardChips: 0 }` with 200.

Returns: `{ status: 'completed' | 'already-claimed', currentStreak, longestStreak, dayOfCycle, rewardChips, chipBalance }`.

### `POST /api/missions/reroll`

Body: `{ missionDefId: string }`.

Validates and performs the reroll as described in the Reroll Mechanism section.

Returns: `{ status: 'rerolled', originalMissionDefId, replacement: MissionView }`.

Errors: `409 REROLL_USED` (already rerolled today), `409 ALREADY_COMPLETED` (target mission is completed), `409 NO_REPLACEMENT_AVAILABLE` (pool empty).

### `DELETE /api/missions/progress`

Dev-only (gated by `import.meta.env.DEV`, matching the existing `DELETE /api/missions/daily-login` pattern).

Body (all fields optional):
```typescript
{
	resetProgress?: boolean;         // default true — clear progress + overrides
	resetStreak?: boolean;           // default true — clear login_streak row
	seedStreak?: {                   // seed streak state for E2E testing
		lastClaimPeriodKey: string;  // e.g., 'yesterday' → computes yesterday's key
		currentStreak: number;
	};
}
```

Clears progress rows, streak, and overrides for the current user. Used by E2E tests to simulate period transitions and streak scenarios. The `seedStreak` knob lets E2E tests set up "continuing streak" and "broken streak" states without waiting for real time to pass.

### Auth & error conventions

All mission endpoints follow the existing API patterns:

| Scenario | Response |
|----------|----------|
| No session | `401 { error: 'UNAUTHORIZED' }` |
| No DB binding | `500 { error: 'DATABASE_UNAVAILABLE' }` |
| Invalid JSON body | `400 { error: 'INVALID_REQUEST_BODY' }` |
| Mission not found in registry | `400 { error: 'MISSION_NOT_FOUND' }` |
| Conflict (already claimed, reroll used, etc.) | `409 { error: 'CODE' }` with descriptive code |

The `icon` field on `MissionDefinition` must use a valid `DecoIcon` name (see `src/components/DecoIcon.astro` for the allowed set). The registry should be validated against this set at impl time.

**Slots handCount note**: The slots `ChipSyncCoordinator` coalesces multiple spins into a single chip-sync request. The `handCount` field reflects the number of coalesced spins, so `daily-slots-20` counts accurately even when spins are batched.

## UI

### `src/pages/missions/index.astro`

Single board page using `CasinoLayout` and the Art Deco design tokens (`deco-*` classes). Three sections:

1. **Streak banner** — Effective streak display: day-of-cycle (1–7) with flame icon, total streak count as subtitle (e.g., "Day 3 of cycle · 17 day streak"), today's reward preview, and a claim button. Shows longest streak.

2. **Daily quests grid** — Cards for each active daily mission. Each card shows:
   - Icon + title + description
   - Progress bar (`progress / target`)
   - Reward chip amount
   - Claim button (enabled when `claimable`)
   - Reroll icon button (enabled when `rerollAvailable` and mission is uncompleted; clicking shows a confirm, then calls the reroll endpoint)
   - Completed/claimed state styling

3. **Weekly goal card** — Larger card at the bottom with the same progress/claim pattern.

**SSR initial state**: The page loads the initial board state server-side (calling the same `getBoardState()` logic the GET endpoint uses, like `daily.astro` does today) to avoid a flash of empty content. The client `<script>` re-fetches `/api/missions/board` after each claim/reroll to refresh state. Uses `data-testid` attributes throughout for E2E tests.

## Migration

1. **Schema migration**: Edit `src/db/schema.ts` to add the three new tables. Run `bun run db:generate` to produce the migration SQL. Run `bun run db:migrate:local` to apply locally. Tables are created by migration SQL, not runtime DDL — the old `ensureMissionSchema()` runtime CREATE TABLE in `missions.ts` is removed.
2. **Deploy-day seeding** (prevents double-claim): Called once from `claim-login.ts` on the first streak claim request. Gated on `login_streak` row not existing for the user — if the row already exists, the function is a no-op. Only when no streak row exists does it query the old `mission` table for `missionId = 'daily-login'` with `completedDate` today (UTC). If found, it seeds `login_streak` with `lastClaimPeriodKey = today`, `currentStreak = 1`. After the first claim (whether seeded or fresh), the streak row exists and the function never queries the legacy table again.
3. **Code migration**: Create the new `src/lib/missions/` directory with all modules. Update `/api/chips/update.ts` and `/api/mp/settle.ts` to call `applyMissionProgress`. Create the new API endpoints and board page.
4. **Remove old code**: Delete `src/lib/missions.ts`, `src/pages/missions/daily.astro`, and `src/pages/api/missions/daily-login.ts`.
5. **Update nav links**: `src/layouts/AppLayout.astro` (header + footer), `src/pages/index.astro` (CTA buttons), and `e2e/global-setup.ts` — change `/missions/daily` → `/missions`.
6. **Old `mission` table**: left in place (harmless, no longer read or written after the one-time seeding backfill). Can be dropped in a future cleanup migration.
7. **Row retention**: Add `mission_progress` and `mission_override` reaping to the existing hourly cleanup in `src/server/cleanup.ts` (already runs via `wrangler.toml [triggers] crons`). Delete rows where `periodKey` is older than 30 days. This bounds table growth without adding new infrastructure.

## Testing

### Unit tests (Bun, pure functions)

| File | Coverage |
|------|----------|
| `periods.test.ts` | Period key computation at UTC midnight boundary, week transitions (Mon start), ISO week numbering, leap years, next-reset timestamps for daily and weekly |
| `streak.test.ts` | Continuation (yesterday → +1), breakage (gap → reset to 1), same-day idempotency, day-7 → day-1 reward cycle, longestStreak tracking, first-ever claim, reward curve lookup for days 1-14, **effective streak computation for display** (continuing vs broken vs already-claimed) |
| `progress.test.ts` | Each metric kind: correct increment from event fields, progress clamping at target (`MIN(progress + amount, target)`), `completedAt` set exactly once (not re-set on over-count), `gamesTried` deduplication via metadataJson, `netChipsEarned` negative delta handling (floored at 0) |
| `reroll.test.ts` | One-per-period enforcement (count check, not per-mission), uncompleted-only validation, replacement drawn from non-active pool, pool-empty 409, override board rendering, cannot reroll a replacement that is already completed, cannot reroll weekly |
| `claim.test.ts` | Idempotency (double claim = single reward via conditional UPDATE), chips granted exactly once (changes()=1 gate), `claimedAt` set, incomplete mission rejection, **concurrent claim requests** (two parallel claims → only one grants chips) |

DB-touching logic (conditional updates, upserts) tested via the existing `createPostHandler` override pattern — inject a mock/miniflare D1 binding.

### E2E tests (Playwright)

File: `e2e/missions.spec.ts`.

| Test | Steps |
|------|-------|
| Board loads (SSR) | Authenticated user visits `/missions`, sees streak banner + daily grid + weekly card immediately (no empty flash) |
| Streak claim | Claim daily login → balance increases → claim again → idempotent (no double reward) |
| Streak continuation | Use dev `seedStreak` to set `lastClaimPeriodKey=yesterday, currentStreak=2` → board shows "continuing" → claim → streak becomes 3, reward = day-3 amount |
| Streak breakage | Use dev `seedStreak` to set `lastClaimPeriodKey=3-days-ago, currentStreak=5` → board shows "broken" (0) → claim → streak resets to 1, reward = 1000 |
| Quest progress | Play a blackjack hand (via existing game flow) → revisit board → daily-blackjack-5 shows progress 1/5 |
| Quest claim | Use dev reset + simulated progress to complete a quest → claim → balance increases |
| Reroll | Reroll an uncompleted daily quest → original hidden, replacement shown → attempt second reroll → 409 |
| Post-reset | Use dev `resetProgress` → all progress zeroed, board shows fresh state |

E2E tests reuse the existing `e2e/.auth/user.json` global setup for authentication. Streak time-advance scenarios use the dev `seedStreak` knob (not real-time waiting); concurrent-claim safety is covered by unit/integration tests, not E2E.

## Acceptance Criteria Mapping

| Criterion | How satisfied |
|-----------|---------------|
| Progress updated from validated game events, not arbitrary client values | `applyMissionProgress` is called from `/api/chips/update` and `/api/mp/settle` after validation — only when `outcome` is present and `gameType` is valid. Never from client-supplied progress values. |
| Repeated completion/claim cannot duplicate rewards | Conditional `UPDATE ... WHERE claimedAt IS NULL` + chip grant gated on `changes() === 1`, both in one D1 batch. Streak uses `WHERE lastClaimPeriodKey != today`. Concurrent claim requests produce only one grant. |
| Daily/weekly resets consistent across time zones | UTC period keys computed server-side; lazy reset on read; no client timezone involvement. Effective streak on read prevents stale display across missed days. |
| Existing Daily Login migrates without losing functionality | Streak system replaces it; day-1 reward = 1000 chips (same as before). Deploy-day seeding from old `mission` table prevents double-claim. Old table preserved for one-time backfill. |
| Unit tests cover progress, resets, streaks, rerolls, duplicate claims | Test files specified per module above, including concurrent-claim safety and effective-streak display. |
| E2E coverage for completion, claiming, post-reset | `e2e/missions.spec.ts` covers these flows using dev `seedStreak`/`resetProgress` knobs for time-advance scenarios. |
