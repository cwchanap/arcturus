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

- `src/pages/api/chips/update.ts` — after a successful chip sync (where it currently calls `recordGameRound` / `checkAndGrantAchievements`), add a call to `applyMissionProgress(db, userId, event)`. The `event` is built from already-validated fields: `{ gameType, outcome, handCount, winsIncrement, lossesIncrement, delta }`.
- `src/pages/api/mp/settle.ts` — after settling each entry, call `applyMissionProgress` with `{ gameType: 'poker_mp', outcome, handCount: 1, winsIncrement, lossesIncrement, delta }` for the `mpHandsCompleted` metric.
- `src/db/schema.ts` — add three new tables (see Data Model below).
- `src/layouts/AppLayout.astro` — update nav links from `/missions/daily` → `/missions`.

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

The old `mission` table (`userId`, `missionId`, `completedDate`) is left in place — harmless, no longer read or written. Can be dropped in a future cleanup migration. No data migration is needed because the new streak system starts fresh (there is no historical streak data to carry over).

## Mission Registry

### Types

```typescript
// src/lib/missions/types.ts

type MissionMetric =
	| { kind: 'handsPlayed'; gameType?: GameType }   // gameType omitted = any game
	| { kind: 'roundsWon'; gameType?: GameType }
	| { kind: 'spinsCompleted' }                      // slots or roulette
	| { kind: 'mpHandsCompleted' }
	| { kind: 'gamesTried' }                          // distinct gameTypes (metadataJson)
	| { kind: 'netChipsEarned' };                     // sum of delta

interface MissionDefinition {
	id: string;              // e.g. 'daily-blackjack-5'
	title: string;
	description: string;
	period: 'daily' | 'weekly';
	metric: MissionMetric;
	target: number;
	rewardChips: number;
	icon: string;            // DecoIcon name
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
| `spinsCompleted` | `event.handCount` | `event.gameType` is `'slots'` or `'roulette'` |

> **Note**: Roulette is server-settled via `/api/roulette/spin` (not `/api/chips/update`), so roulette spins will only count once that endpoint is also wired to call `applyMissionProgress`. For MVP, `daily-slots-20` works immediately via the chips/update path (slots only). Roulette integration is a follow-up.
| `mpHandsCompleted` | `1` | `event.gameType === 'poker_mp'` |
| `gamesTried` | `1` | `event.gameType` not already in `metadataJson` array |
| `netChipsEarned` | `event.delta` | `event.gameType` matches |

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

function getDailyPeriodKeyForYesterday(): string {
	const d = new Date();
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
| `daily-roulette-5` | Wheel Spinner | `spinsCompleted` (roulette only) | 5 | 600 |

## Progress Application

### `applyMissionProgress()`

Called from `/api/chips/update` and `/api/mp/settle` after a validated round succeeds.

```typescript
async function applyMissionProgress(db: Database, userId: string, event: MissionGameEvent): Promise<void> {
	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();

	// Gather all daily definitions that could match this event
	// (default board + any active overrides for today)
	const activeDaily = getActiveDailyMissions(db, userId, dailyKey);
	// Plus all weekly definitions
	const allWeekly = DEFAULT_WEEKLY_MISSIONS;

	const increments: Array<{ def: MissionDefinition; periodKey: string; amount: number; metadata?: string[] }> = [];

	for (const def of [...activeDaily, ...allWeekly]) {
		const result = computeIncrement(def, event);
		if (result.amount > 0) {
			increments.push({ def, periodKey: def.period === 'daily' ? dailyKey : weeklyKey, ...result });
		}
	}

	// Batch upsert all increments atomically
	for (const inc of increments) {
		await upsertProgress(db, userId, inc.def, inc.periodKey, inc.amount, inc.metadata);
	}
}
```

`getActiveDailyMissions(db, userId, dailyKey)` returns the current board **with overrides applied** — i.e., for each default daily mission, if an override exists for this period, the replacement definition is returned instead. This means a swapped-out mission will NOT receive further increments, and the replacement mission WILL.

`computeIncrement` applies the metric mapping table above and returns `{ amount, metadata? }`. For `gamesTried`, it needs to load the current `metadataJson` from the progress row for that period to check for dedup before deciding whether to increment.

`upsertProgress` uses `INSERT ... ON CONFLICT DO UPDATE` (matching the `game_stats` pattern), with a conditional `completedAt` set: `CASE WHEN progress + amount >= target AND completedAt IS NULL THEN now ELSE completedAt END`. All increments for a single event are collected and applied via `db.batch()` (D1 atomic batch) so either all progress updates succeed or none do.

### Where it's called

**`/api/chips/update.ts`** — in the success path, after the existing `recordGameRound` / `checkAndGrantAchievements` calls (or alongside them). Built from already-validated request fields. The call is wrapped in try/catch so a mission progress failure never breaks a chip sync (matching the existing pattern where stats/achievement errors are caught and logged, not fatal).

**`/api/mp/settle.ts`** — in the settle batch, for each entry that was newly applied (not a replayed idempotent entry), call `applyMissionProgress` with the entry's delta/outcome. This counts toward `mpHandsCompleted`.

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

Body: `{ missionDefId: string, periodKey: string }`.

Validates:
- The mission exists in the registry.
- A progress row exists for `(userId, missionDefId, periodKey)`.
- `progress >= target` (completed).
- `claimedAt` is null (not yet claimed).

On success: grants `rewardChips` (atomic `chipBalance + reward`), sets `claimedAt = now`.

Idempotent: if already claimed, returns `{ status: 'already-claimed', chipBalance }` with 200 (not an error).

Returns: `{ status: 'completed' | 'already-claimed', missionDefId, rewardChips, chipBalance }`.

### `POST /api/missions/claim-login`

No body needed (uses session user).

Runs the streak logic described above. Idempotent: if `lastClaimPeriodKey === today`, returns `{ status: 'already-claimed' }`.

Returns: `{ status: 'completed' | 'already-claimed', currentStreak, longestStreak, dayOfCycle, rewardChips, chipBalance }`.

### `POST /api/missions/reroll`

Body: `{ missionDefId: string }`.

Validates and performs the reroll as described in the Reroll Mechanism section.

Returns: `{ status: 'rerolled', originalMissionDefId, replacement: MissionView }`.

Errors: `409 REROLL_USED` (already rerolled today), `409 ALREADY_COMPLETED` (target mission is completed), `409 NO_REPLACEMENT_AVAILABLE` (pool empty).

### `DELETE /api/missions/progress`

Dev-only (gated by `import.meta.env.DEV`, matching the existing `DELETE /api/missions/daily-login` pattern).

Body: `{ missionDefId?: string }` (optional — if omitted, resets all).

Clears progress rows, streak, and overrides for the current user. Used by E2E tests to simulate period transitions.

## UI

### `src/pages/missions/index.astro`

Single board page using `CasinoLayout` and the Art Deco design tokens (`deco-*` classes). Three sections:

1. **Streak banner** — Current streak count with flame icon (e.g., "3 / 7 day streak"), today's reward preview, and a claim button. Shows longest streak as a subtitle.

2. **Daily quests grid** — Cards for each active daily mission. Each card shows:
   - Icon + title + description
   - Progress bar (`progress / target`)
   - Reward chip amount
   - Claim button (enabled when `claimable`)
   - Reroll icon button (enabled when `rerollAvailable` and mission is uncompleted; clicking shows a confirm, then calls the reroll endpoint)
   - Completed/claimed state styling

3. **Weekly goal card** — Larger card at the bottom with the same progress/claim pattern.

Client script (`<script>` tag) polls `/api/missions/board` on load and after each claim/reroll to refresh state. Uses `data-testid` attributes throughout for E2E tests.

## Migration

1. **Schema migration**: Edit `src/db/schema.ts` to add the three new tables. Run `bun run db:generate` to produce the migration SQL. Run `bun run db:migrate:local` to apply locally.
2. **Code migration**: Create the new `src/lib/missions/` directory with all modules. Update `/api/chips/update.ts` and `/api/mp/settle.ts` to call `applyMissionProgress`. Create the new API endpoints and board page.
3. **Remove old code**: Delete `src/lib/missions.ts`, `src/pages/missions/daily.astro`, and `src/pages/api/missions/daily-login.ts`.
4. **Update nav links**: `src/layouts/AppLayout.astro` — change `/missions/daily` → `/missions` in header and footer.
5. **Old `mission` table**: left in place (harmless, no longer read or written). No data migration needed — the streak system starts fresh.

The existing 1000-chip day-1 streak reward preserves reward continuity for users who were claiming the daily login.

## Testing

### Unit tests (Bun, pure functions)

| File | Coverage |
|------|----------|
| `periods.test.ts` | Period key computation at UTC midnight boundary, week transitions (Mon start), ISO week numbering, leap years, next-reset timestamps for daily and weekly |
| `streak.test.ts` | Continuation (yesterday → +1), breakage (gap → reset to 1), same-day idempotency, day-7 → day-1 reward cycle, longestStreak tracking, first-ever claim, reward curve lookup for days 1-14 |
| `progress.test.ts` | Each metric kind: correct increment from event fields, progress clamping at target, `completedAt` set exactly once (not re-set on over-count), `gamesTried` deduplication via metadataJson, `netChipsEarned` negative delta handling |
| `reroll.test.ts` | One-per-period enforcement, uncompleted-only validation, replacement drawn from non-active pool, pool-empty 409, override board rendering |
| `claim.test.ts` | Idempotency (double claim = single reward), chips granted exactly once, `claimedAt` set, incomplete mission rejection |

DB-touching logic (upserts, reads) tested via the existing `createPostHandler` override pattern — inject a mock/miniflare DB.

### E2E tests (Playwright)

File: `e2e/missions.spec.ts`.

| Test | Steps |
|------|-------|
| Board loads | Authenticated user visits `/missions`, sees streak banner + daily grid + weekly card |
| Streak claim | Claim daily login → balance increases → claim again → idempotent (no double reward) |
| Quest progress | Play a blackjack hand (via existing game flow) → revisit board → daily-blackjack-5 shows progress 1/5 |
| Quest claim | Use dev reset + simulated progress to complete a quest → claim → balance increases |
| Reroll | Reroll an uncompleted daily quest → original hidden, replacement shown → attempt second reroll → 409 |
| Post-reset | Use dev reset endpoint to advance period key → all progress zeroed, streak reset logic |

E2E tests reuse the existing `e2e/.auth/user.json` global setup for authentication.

## Acceptance Criteria Mapping

| Criterion | How satisfied |
|-----------|---------------|
| Progress updated from validated game events, not arbitrary client values | `applyMissionProgress` is called from `/api/chips/update` and `/api/mp/settle` after validation — never from client-supplied progress values |
| Repeated completion/claim cannot duplicate rewards | Idempotent claim endpoints (`claimedAt` check), streak idempotency (`lastClaimPeriodKey` check), atomic conditional updates |
| Daily/weekly resets consistent across time zones | UTC period keys computed server-side; lazy reset on read; no client timezone involvement |
| Existing Daily Login migrates without losing functionality | Streak system replaces it; day-1 reward = 1000 chips (same as before); old `mission` table preserved |
| Unit tests cover progress, resets, streaks, rerolls, duplicate claims | Test files specified per module above |
| E2E coverage for completion, claiming, post-reset | `e2e/missions.spec.ts` covers these flows |
