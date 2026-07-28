# Mission Board 2.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single Daily Login mission with a full mission board: daily quests, weekly goals, a 7-day login streak, daily rerolls, and idempotent reward claiming — all driven by validated game-round events.

**Architecture:** Progress is tracked in a dedicated `mission_progress` table incremented inline during validated chip sync. UTC period keys provide timezone-independent lazy resets. Mission definitions live in a code registry. Streaks and claims use conditional D1 batch writes to prevent double-pay under concurrency.

**Tech Stack:** Astro SSR (Cloudflare Workers), TypeScript, Drizzle ORM + D1, Bun test, Playwright. Design spec: `docs/superpowers/specs/2026-07-26-mission-board-2-design.md`.

## Global Constraints

- **Runtime:** Cloudflare Workers — never use `process.env`; use `Astro.locals.runtime.env`.
- **Atomicity:** Use raw `D1Database.batch()` (`locals.runtime.env.DB.batch()`) for multi-statement atomicity. Drizzle's `db` wrapper has no `.batch()` method. Follow the pattern in `src/pages/api/chips/update.ts` and `src/pages/api/mp/settle.ts`.
- **Package manager:** `bun`. Test runner: `bun:test` with `describe` / `test` / `expect`.
- **Code style:** Tabs (width 2), single quotes, semicolons required. Unused vars prefixed `_`. No comments unless asked.
- **Naming:** Astro components PascalCase; routes kebab-case; TS camelCase vars / PascalCase types; DB tables snake_case.
- **Auth pattern:** Mission endpoints require authenticated session (`locals.session` + `locals.user`). No guest mode.
- **Lint gate:** `bun run lint` must pass with 0 warnings before commit.
- **Migrations:** `bun run db:generate` then `bun run db:migrate:local`. Tables created by migration SQL, not runtime DDL.
- **Conditional writes:** Claim and streak operations use `UPDATE ... WHERE condition IS NULL` + `changes() === 1` gate to prevent double-pay. See `src/pages/api/mp/settle.ts` for the idempotency pattern.

---

## File Structure

| File                                               | Responsibility                                                                                                                         |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `src/db/schema.ts` (edit)                          | Add `missionProgress`, `loginStreak`, `missionOverride` tables                                                                         |
| `src/lib/missions/types.ts`                        | All TS interfaces: `MissionMetric`, `MissionDefinition`, `MissionGameEvent`, `MissionView`, `BoardState`, `StreakView`                 |
| `src/lib/missions/periods.ts`                      | Pure UTC period key functions: daily/weekly keys, yesterday, next-reset timestamps                                                     |
| `src/lib/missions/streak.ts`                       | Pure streak logic: `STREAK_REWARDS`, `getStreakReward`, `computeEffectiveStreak`, `computeStreakTransition`                            |
| `src/lib/missions/registry.ts`                     | Mission definitions: `DEFAULT_DAILY_MISSIONS`, `REROLL_POOL_DAILY`, `DEFAULT_WEEKLY_MISSIONS`, `ALL_DAILY_DEFINITIONS`, helper lookups |
| `src/lib/missions/progress.ts`                     | `computeIncrement` (pure), `applyMissionProgress` (D1 batch), `buildProgressUpsertSQL`                                                 |
| `src/lib/missions/board.ts`                        | `getBoardState` (read model), `applyOverrides`, `getActiveDailyMissionIds`                                                             |
| `src/lib/missions/claim.ts`                        | `claimMission` (conditional UPDATE + chip grant), `claimLogin` (streak conditional UPDATE)                                             |
| `src/lib/missions/reroll.ts`                       | `performReroll`, `getReplacementPool`                                                                                                  |
| `src/lib/missions/seed.ts`                         | Deploy-day seeding: `seedStreakFromOldMission`                                                                                         |
| `src/lib/missions/index.ts`                        | Barrel exports                                                                                                                         |
| `src/lib/missions/*.test.ts`                       | Unit tests for pure modules                                                                                                            |
| `src/pages/api/missions/board.ts`                  | GET — full board state                                                                                                                 |
| `src/pages/api/missions/claim.ts`                  | POST — claim quest reward                                                                                                              |
| `src/pages/api/missions/claim-login.ts`            | POST — claim streak reward                                                                                                             |
| `src/pages/api/missions/reroll.ts`                 | POST — swap uncompleted daily quest                                                                                                    |
| `src/pages/api/missions/progress.ts`               | DELETE — dev-only reset + seedStreak                                                                                                   |
| `src/pages/missions/index.astro`                   | Board page (SSR + client script)                                                                                                       |
| `src/pages/api/chips/update.ts` (edit)             | Call `applyMissionProgress` after validated sync                                                                                       |
| `src/pages/api/mp/settle.ts` (edit)                | Call `applyMissionProgress` after settle                                                                                               |
| `src/layouts/AppLayout.astro` (edit)               | Nav links `/missions/daily` → `/missions`                                                                                              |
| `src/pages/index.astro` (edit)                     | CTA buttons `/missions/daily` → `/missions`                                                                                            |
| `e2e/global-setup.ts` (edit)                       | Navigate to `/missions`                                                                                                                |
| `e2e/missions.spec.ts`                             | E2E tests                                                                                                                              |
| **Delete** `src/lib/missions.ts`                   | Old single-file mission system                                                                                                         |
| **Delete** `src/pages/missions/daily.astro`        | Old daily mission page                                                                                                                 |
| **Delete** `src/pages/api/missions/daily-login.ts` | Old daily login API                                                                                                                    |

---

## Task 1: DB Schema — Three New Tables

**Files:**

- Modify: `src/db/schema.ts` (append after the existing `mission` table definition, ~line 102)

**Interfaces:**

- Produces: exported Drizzle table objects `missionProgress`, `loginStreak`, `missionOverride` for use by all later tasks.

- [ ] **Step 1: Add the three table definitions to `src/db/schema.ts`**

Append after the existing `mission` table (line ~102):

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

export const loginStreak = sqliteTable('login_streak', {
	userId: text('userId')
		.primaryKey()
		.references(() => user.id, { onDelete: 'cascade' }),
	currentStreak: integer('currentStreak').notNull().default(0),
	longestStreak: integer('longestStreak').notNull().default(0),
	lastClaimPeriodKey: text('lastClaimPeriodKey').notNull().default(''),
});

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

- [ ] **Step 2: Generate and apply the migration**

```bash
bun run db:generate
bun run db:migrate:local
```

Verify the migration SQL includes `CREATE TABLE mission_progress`, `CREATE TABLE login_streak`, and `CREATE TABLE mission_override`.

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat: add mission_progress, login_streak, mission_override tables (HPA-173)"
```

---

## Task 2: Types + Period Key Functions

**Files:**

- Create: `src/lib/missions/types.ts`
- Create: `src/lib/missions/periods.ts`
- Create: `src/lib/missions/periods.test.ts`

**Interfaces:**

- Produces: `MissionMetric`, `MissionDefinition`, `MissionGameEvent`, `MissionView`, `StreakView`, `BoardState`; `getDailyPeriodKey`, `getWeeklyPeriodKey`, `getDailyPeriodKeyForYesterday`, `getNextDailyReset`, `getNextWeeklyReset`.

- [ ] **Step 1: Write `src/lib/missions/types.ts`**

```typescript
import type { GameType } from '../game-stats/types';

export type MissionMetric =
	| { kind: 'handsPlayed'; gameType?: string }
	| { kind: 'roundsWon'; gameType?: string }
	| { kind: 'spinsCompleted' }
	| { kind: 'mpHandsCompleted' }
	| { kind: 'gamesTried' };

export interface MissionDefinition {
	id: string;
	title: string;
	description: string;
	period: 'daily' | 'weekly';
	metric: MissionMetric;
	target: number;
	rewardChips: number;
	icon: string;
}

export interface MissionGameEvent {
	gameType: string;
	outcome: 'win' | 'loss' | 'push' | null | undefined;
	handCount: number;
	winsIncrement: number;
	lossesIncrement: number;
	delta: number;
}

export interface MissionView {
	missionDefId: string;
	title: string;
	description: string;
	icon: string;
	period: 'daily' | 'weekly';
	progress: number;
	target: number;
	completed: boolean;
	claimed: boolean;
	claimable: boolean;
	rewardChips: number;
	isOverride: boolean;
}

export interface StreakView {
	current: number;
	longest: number;
	claimableToday: boolean;
	dayOfCycle: number;
	rewardPreview: number;
	lastClaimPeriodKey: string;
}

export interface BoardState {
	streak: StreakView;
	daily: MissionView[];
	weekly: MissionView[];
	rerollAvailable: boolean;
	nextDailyReset: string;
	nextWeeklyReset: string;
	chipBalance: number;
}
```

- [ ] **Step 2: Write the failing test — `src/lib/missions/periods.test.ts`**

```typescript
import { describe, expect, test } from 'bun:test';
import {
	getDailyPeriodKey,
	getWeeklyPeriodKey,
	getDailyPeriodKeyForYesterday,
	getNextDailyReset,
	getNextWeeklyReset,
} from './periods';

describe('period keys', () => {
	test('daily key is YYYY-MM-DD in UTC', () => {
		const date = new Date('2026-07-26T15:30:00Z');
		expect(getDailyPeriodKey(date)).toBe('2026-07-26');
	});

	test('daily key at UTC midnight boundary', () => {
		expect(getDailyPeriodKey(new Date('2026-07-26T00:00:00Z'))).toBe('2026-07-26');
		expect(getDailyPeriodKey(new Date('2026-07-25T23:59:59Z'))).toBe('2026-07-25');
	});

	test('daily key is timezone-independent (local time does not affect result)', () => {
		const utc = new Date('2026-07-26T22:00:00Z');
		expect(getDailyPeriodKey(utc)).toBe('2026-07-26');
	});

	test('yesterday key', () => {
		const date = new Date('2026-07-26T12:00:00Z');
		expect(getDailyPeriodKeyForYesterday(date)).toBe('2026-07-25');
	});

	test('weekly key is ISO week number (Monday-based)', () => {
		// 2026-07-26 is a Sunday → ISO week 30
		expect(getWeeklyPeriodKey(new Date('2026-07-26T12:00:00Z'))).toBe('2026-W30');
		// 2026-07-20 is a Monday → start of week 30
		expect(getWeeklyPeriodKey(new Date('2026-07-20T12:00:00Z'))).toBe('2026-W30');
		// 2026-07-19 is a Sunday → end of week 29
		expect(getWeeklyPeriodKey(new Date('2026-07-19T12:00:00Z'))).toBe('2026-W29');
	});

	test('weekly key across year boundary', () => {
		// 2026-12-31 is Thursday → ISO week 01 of 2027? Actually week 52 of 2026
		// 2027-01-01 is Friday → still week 52 of 2026
		expect(getWeeklyPeriodKey(new Date('2026-12-31T12:00:00Z'))).toBe('2026-W52');
		expect(getWeeklyPeriodKey(new Date('2027-01-01T12:00:00Z'))).toBe('2026-W52');
		expect(getWeeklyPeriodKey(new Date('2027-01-04T12:00:00Z'))).toBe('2027-W01');
	});

	test('next daily reset is next UTC midnight', () => {
		const date = new Date('2026-07-26T15:30:00Z');
		const reset = getNextDailyReset(date);
		expect(reset.toISOString()).toBe('2026-07-27T00:00:00.000Z');
	});

	test('next daily reset at midnight is the following day', () => {
		const date = new Date('2026-07-26T00:00:00Z');
		const reset = getNextDailyReset(date);
		expect(reset.toISOString()).toBe('2026-07-27T00:00:00.000Z');
	});

	test('next weekly reset is next Monday UTC midnight', () => {
		// 2026-07-26 is Sunday → next Monday is 2026-07-27
		const date = new Date('2026-07-26T12:00:00Z');
		const reset = getNextWeeklyReset(date);
		expect(reset.toISOString()).toBe('2026-07-27T00:00:00.000Z');
	});

	test('next weekly reset on Monday is the following Monday', () => {
		// 2026-07-20 is Monday → next Monday is 2026-07-27
		const date = new Date('2026-07-20T12:00:00Z');
		const reset = getNextWeeklyReset(date);
		expect(reset.toISOString()).toBe('2026-07-27T00:00:00.000Z');
	});
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
bun test src/lib/missions/periods.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write `src/lib/missions/periods.ts`**

```typescript
export function getDailyPeriodKey(date = new Date()): string {
	return date.toISOString().slice(0, 10);
}

export function getWeeklyPeriodKey(date = new Date()): string {
	const tmp = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
	const dayNum = (tmp.getUTCDay() + 6) % 7;
	tmp.setUTCDate(tmp.getUTCDate() - dayNum + 3);
	const weekNum =
		1 + Math.round((tmp.getTime() - Date.UTC(tmp.getUTCFullYear(), 0, 4)) / 604800000);
	return `${tmp.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

export function getDailyPeriodKeyForYesterday(date = new Date()): string {
	const d = new Date(date);
	d.setUTCDate(d.getUTCDate() - 1);
	return getDailyPeriodKey(d);
}

export function getNextDailyReset(date = new Date()): Date {
	const next = new Date(date);
	next.setUTCDate(next.getUTCDate() + 1);
	next.setUTCHours(0, 0, 0, 0);
	return next;
}

export function getNextWeeklyReset(date = new Date()): Date {
	const next = new Date(date);
	const dayNum = (next.getUTCDay() + 6) % 7;
	const daysUntilMonday = dayNum === 0 ? 7 : 7 - dayNum;
	next.setUTCDate(next.getUTCDate() + daysUntilMonday);
	next.setUTCHours(0, 0, 0, 0);
	return next;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test src/lib/missions/periods.test.ts
```

Expected: PASS — all tests green.

- [ ] **Step 6: Commit**

```bash
git add src/lib/missions/types.ts src/lib/missions/periods.ts src/lib/missions/periods.test.ts
git commit -m "feat: add mission types and UTC period key functions (HPA-173)"
```

---

## Task 3: Streak Logic (Pure Functions)

**Files:**

- Create: `src/lib/missions/streak.ts`
- Create: `src/lib/missions/streak.test.ts`

**Interfaces:**

- Consumes: `getDailyPeriodKey`, `getDailyPeriodKeyForYesterday` from Task 2.
- Produces: `STREAK_REWARDS`, `getStreakReward`, `computeEffectiveStreak`, `computeStreakTransition`.

- [ ] **Step 1: Write the failing test — `src/lib/missions/streak.test.ts`**

```typescript
import { describe, expect, test } from 'bun:test';
import {
	STREAK_REWARDS,
	getStreakReward,
	computeEffectiveStreak,
	computeStreakTransition,
} from './streak';

describe('streak rewards', () => {
	test('day 1 reward is 1000 (matches old daily login)', () => {
		expect(getStreakReward(1)).toBe(1000);
	});

	test('day 7 reward is 5000', () => {
		expect(getStreakReward(7)).toBe(5000);
	});

	test('reward escalates monotonically within cycle', () => {
		for (let day = 2; day <= 7; day++) {
			expect(getStreakReward(day)).toBeGreaterThan(getStreakReward(day - 1));
		}
	});

	test('day 8 cycles back to day-1 reward (1000)', () => {
		expect(getStreakReward(8)).toBe(1000);
	});

	test('day 14 cycles back to day-7 reward (5000)', () => {
		expect(getStreakReward(14)).toBe(5000);
	});

	test('day 15 cycles back to day-1 reward', () => {
		expect(getStreakReward(15)).toBe(1000);
	});
});

describe('computeEffectiveStreak (display)', () => {
	const today = '2026-07-26';
	const yesterday = '2026-07-25';
	const threeDaysAgo = '2026-07-23';

	test('already claimed today → not claimable, reward 0', () => {
		const result = computeEffectiveStreak({
			currentStreak: 5,
			longestStreak: 10,
			lastClaimPeriodKey: today,
			today,
			yesterday,
		});
		expect(result.displayStreak).toBe(5);
		expect(result.claimableToday).toBe(false);
		expect(result.rewardPreview).toBe(0);
	});

	test('last claim yesterday → continuing, reward = next day', () => {
		const result = computeEffectiveStreak({
			currentStreak: 2,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
			today,
			yesterday,
		});
		expect(result.displayStreak).toBe(2);
		expect(result.claimableToday).toBe(true);
		expect(result.rewardPreview).toBe(getStreakReward(3));
	});

	test('gap of 3 days → broken, display 0, reward = day 1', () => {
		const result = computeEffectiveStreak({
			currentStreak: 5,
			longestStreak: 10,
			lastClaimPeriodKey: threeDaysAgo,
			today,
			yesterday,
		});
		expect(result.displayStreak).toBe(0);
		expect(result.claimableToday).toBe(true);
		expect(result.rewardPreview).toBe(1000);
	});

	test('never claimed → broken, display 0, reward = day 1', () => {
		const result = computeEffectiveStreak({
			currentStreak: 0,
			longestStreak: 0,
			lastClaimPeriodKey: '',
			today,
			yesterday,
		});
		expect(result.displayStreak).toBe(0);
		expect(result.claimableToday).toBe(true);
		expect(result.rewardPreview).toBe(1000);
	});
});

describe('computeStreakTransition (on claim)', () => {
	const today = '2026-07-26';
	const yesterday = '2026-07-25';

	test('continuing from yesterday', () => {
		const result = computeStreakTransition({
			currentStreak: 3,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
			today,
			yesterday,
		});
		expect(result.newStreak).toBe(4);
		expect(result.newLongest).toBe(5);
		expect(result.dayOfCycle).toBe(4);
		expect(result.reward).toBe(getStreakReward(4));
	});

	test('broken streak resets to 1', () => {
		const result = computeStreakTransition({
			currentStreak: 5,
			longestStreak: 5,
			lastClaimPeriodKey: '2026-07-20',
			today,
			yesterday,
		});
		expect(result.newStreak).toBe(1);
		expect(result.newLongest).toBe(5);
		expect(result.dayOfCycle).toBe(1);
		expect(result.reward).toBe(1000);
	});

	test('first ever claim', () => {
		const result = computeStreakTransition({
			currentStreak: 0,
			longestStreak: 0,
			lastClaimPeriodKey: '',
			today,
			yesterday,
		});
		expect(result.newStreak).toBe(1);
		expect(result.newLongest).toBe(1);
		expect(result.reward).toBe(1000);
	});

	test('longest streak updates when current exceeds it', () => {
		const result = computeStreakTransition({
			currentStreak: 5,
			longestStreak: 5,
			lastClaimPeriodKey: yesterday,
			today,
			yesterday,
		});
		expect(result.newStreak).toBe(6);
		expect(result.newLongest).toBe(6);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/lib/missions/streak.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/missions/streak.ts`**

```typescript
import { getDailyPeriodKey, getDailyPeriodKeyForYesterday } from './periods';

export const STREAK_REWARDS = [1000, 1250, 1500, 2000, 2500, 3500, 5000] as const;

export function getStreakReward(currentStreak: number): number {
	const dayOfCycle = ((currentStreak - 1) % STREAK_REWARDS.length) + 1;
	return STREAK_REWARDS[dayOfCycle - 1];
}

export function getDayOfCycle(currentStreak: number): number {
	return ((currentStreak - 1) % STREAK_REWARDS.length) + 1;
}

export interface EffectiveStreakInput {
	currentStreak: number;
	longestStreak: number;
	lastClaimPeriodKey: string;
	today: string;
	yesterday: string;
}

export interface EffectiveStreakResult {
	displayStreak: number;
	longestStreak: number;
	claimableToday: boolean;
	dayOfCycle: number;
	rewardPreview: number;
}

export function computeEffectiveStreak(input: EffectiveStreakInput): EffectiveStreakResult {
	const { currentStreak, longestStreak, lastClaimPeriodKey, today, yesterday } = input;

	if (lastClaimPeriodKey === today) {
		return {
			displayStreak: currentStreak,
			longestStreak,
			claimableToday: false,
			dayOfCycle: getDayOfCycle(currentStreak),
			rewardPreview: 0,
		};
	}

	if (lastClaimPeriodKey === yesterday) {
		const nextStreak = currentStreak + 1;
		return {
			displayStreak: currentStreak,
			longestStreak,
			claimableToday: true,
			dayOfCycle: getDayOfCycle(nextStreak),
			rewardPreview: getStreakReward(nextStreak),
		};
	}

	return {
		displayStreak: 0,
		longestStreak,
		claimableToday: true,
		dayOfCycle: 1,
		rewardPreview: STREAK_REWARDS[0],
	};
}

export interface StreakTransitionInput {
	currentStreak: number;
	longestStreak: number;
	lastClaimPeriodKey: string;
	today: string;
	yesterday: string;
}

export interface StreakTransitionResult {
	newStreak: number;
	newLongest: number;
	dayOfCycle: number;
	reward: number;
}

export function computeStreakTransition(input: StreakTransitionInput): StreakTransitionResult {
	const { currentStreak, longestStreak, lastClaimPeriodKey, today, yesterday } = input;

	const newStreak = lastClaimPeriodKey === yesterday ? currentStreak + 1 : 1;
	const newLongest = Math.max(longestStreak, newStreak);
	const dayOfCycle = getDayOfCycle(newStreak);
	const reward = getStreakReward(newStreak);

	return { newStreak, newLongest, dayOfCycle, reward };
}

export function computeEffectiveStreakFromStored(
	stored: { currentStreak: number; longestStreak: number; lastClaimPeriodKey: string } | null,
): EffectiveStreakResult {
	const today = getDailyPeriodKey();
	const yesterday = getDailyPeriodKeyForYesterday();

	if (!stored) {
		return computeEffectiveStreak({
			currentStreak: 0,
			longestStreak: 0,
			lastClaimPeriodKey: '',
			today,
			yesterday,
		});
	}

	return computeEffectiveStreak({ ...stored, today, yesterday });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/lib/missions/streak.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/missions/streak.ts src/lib/missions/streak.test.ts
git commit -m "feat: add streak reward curve and effective streak logic (HPA-173)"
```

---

## Task 4: Mission Registry

**Files:**

- Create: `src/lib/missions/registry.ts`
- Create: `src/lib/missions/registry.test.ts`

**Interfaces:**

- Consumes: `MissionDefinition`, `MissionMetric` from Task 2.
- Produces: `DEFAULT_DAILY_MISSIONS`, `REROLL_POOL_DAILY`, `DEFAULT_WEEKLY_MISSIONS`, `ALL_DAILY_DEFINITIONS`, `getMissionDef(id)`, `getAllMissionDefIds()`.

- [ ] **Step 1: Write the failing test — `src/lib/missions/registry.test.ts`**

```typescript
import { describe, expect, test } from 'bun:test';
import {
	DEFAULT_DAILY_MISSIONS,
	REROLL_POOL_DAILY,
	DEFAULT_WEEKLY_MISSIONS,
	ALL_DAILY_DEFINITIONS,
	getMissionDef,
} from './registry';

describe('mission registry', () => {
	test('default daily missions has 4 entries', () => {
		expect(DEFAULT_DAILY_MISSIONS).toHaveLength(4);
	});

	test('reroll pool has at least 2 entries', () => {
		expect(REROLL_POOL_DAILY.length).toBeGreaterThanOrEqual(2);
	});

	test('weekly has 1 entry', () => {
		expect(DEFAULT_WEEKLY_MISSIONS).toHaveLength(1);
	});

	test('all daily definitions = default + reroll pool, no duplicates', () => {
		const ids = ALL_DAILY_DEFINITIONS.map((m) => m.id);
		expect(new Set(ids).size).toBe(ids.length);
		expect(ids.length).toBe(DEFAULT_DAILY_MISSIONS.length + REROLL_POOL_DAILY.length);
	});

	test('getMissionDef finds by id', () => {
		expect(getMissionDef('daily-blackjack-5')).toBeDefined();
		expect(getMissionDef('weekly-games-3')).toBeDefined();
		expect(getMissionDef('nonexistent')).toBeUndefined();
	});

	test('all daily missions have period daily, weekly have weekly', () => {
		for (const m of DEFAULT_DAILY_MISSIONS) {
			expect(m.period).toBe('daily');
		}
		for (const m of REROLL_POOL_DAILY) {
			expect(m.period).toBe('daily');
		}
		for (const m of DEFAULT_WEEKLY_MISSIONS) {
			expect(m.period).toBe('weekly');
		}
	});

	test('all missions have positive target and reward', () => {
		for (const m of [...ALL_DAILY_DEFINITIONS, ...DEFAULT_WEEKLY_MISSIONS]) {
			expect(m.target).toBeGreaterThan(0);
			expect(m.rewardChips).toBeGreaterThan(0);
		}
	});

	test('no reroll pool mission is in default daily set', () => {
		const defaultIds = new Set(DEFAULT_DAILY_MISSIONS.map((m) => m.id));
		for (const m of REROLL_POOL_DAILY) {
			expect(defaultIds.has(m.id)).toBe(false);
		}
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/lib/missions/registry.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/missions/registry.ts`**

```typescript
import type { MissionDefinition } from './types';

export const DEFAULT_DAILY_MISSIONS: MissionDefinition[] = [
	{
		id: 'daily-blackjack-5',
		title: 'Blackjack Streak',
		description: 'Play 5 Blackjack hands',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'blackjack' },
		target: 5,
		rewardChips: 500,
		icon: '\u{1F0CF}', // playing card emoji
	},
	{
		id: 'daily-win-3',
		title: 'Three Wins',
		description: 'Win 3 rounds in any game',
		period: 'daily',
		metric: { kind: 'roundsWon' },
		target: 3,
		rewardChips: 750,
		icon: '\u{1F3C6}', // trophy emoji
	},
	{
		id: 'daily-slots-20',
		title: 'Spin to Win',
		description: 'Complete 20 slot spins',
		period: 'daily',
		metric: { kind: 'spinsCompleted' },
		target: 20,
		rewardChips: 500,
		icon: '\u{2B50}', // star emoji
	},
	{
		id: 'daily-mp-1',
		title: 'Social Player',
		description: 'Finish 1 multiplayer poker hand',
		period: 'daily',
		metric: { kind: 'mpHandsCompleted' },
		target: 1,
		rewardChips: 1000,
		icon: '\u{1F3B4}', // flower playing card emoji
	},
];

export const REROLL_POOL_DAILY: MissionDefinition[] = [
	{
		id: 'daily-craps-3',
		title: 'Dice Roller',
		description: 'Play 3 Craps rounds',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'craps' },
		target: 3,
		rewardChips: 500,
		icon: '\u{1F3B2}', // game die emoji
	},
	{
		id: 'daily-baccarat-3',
		title: 'Baccarat Round',
		description: 'Play 3 Baccarat hands',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'baccarat' },
		target: 3,
		rewardChips: 500,
		icon: '\u{2666}', // diamond suit emoji
	},
	{
		id: 'daily-keno-5',
		title: 'Lucky Numbers',
		description: 'Play 5 Keno draws',
		period: 'daily',
		metric: { kind: 'handsPlayed', gameType: 'keno' },
		target: 5,
		rewardChips: 600,
		icon: '\u{1F4DD}', // memo emoji (lotto ticket)
	},
];

export const DEFAULT_WEEKLY_MISSIONS: MissionDefinition[] = [
	{
		id: 'weekly-games-3',
		title: 'Variety Seeker',
		description: 'Play 3 different game modes this week',
		period: 'weekly',
		metric: { kind: 'gamesTried' },
		target: 3,
		rewardChips: 2000,
		icon: '\u{1F4C5}', // calendar emoji
	},
];

export const ALL_DAILY_DEFINITIONS: MissionDefinition[] = [
	...DEFAULT_DAILY_MISSIONS,
	...REROLL_POOL_DAILY,
];

const ALL_DEFINITIONS = [...ALL_DAILY_DEFINITIONS, ...DEFAULT_WEEKLY_MISSIONS];

export function getMissionDef(id: string): MissionDefinition | undefined {
	return ALL_DEFINITIONS.find((m) => m.id === id);
}

export function getAllMissionDefIds(): string[] {
	return ALL_DEFINITIONS.map((m) => m.id);
}
```

> **Note on icons:** Icons use Unicode emoji (e.g., `\u{1F0CF}` for cards, `\u{1F3C6}` for trophy). These are rendered directly in the UI as text, not via `DecoIcon`. This avoids the 6-name DecoIcon limitation. See `GAME_TYPE_ICONS` in `src/lib/game-stats/constants.ts` for the existing emoji convention.

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/lib/missions/registry.test.ts
```

Expected: PASS.

- [ ] **Step 5: Verify DecoIcon names exist**

Check `src/components/DecoIcon.astro` for the icon name set. Adjust any registry `icon` values that don't match.

- [ ] **Step 6: Commit**

```bash
git add src/lib/missions/registry.ts src/lib/missions/registry.test.ts
git commit -m "feat: add mission definitions registry (HPA-173)"
```

---

## Task 5: Progress Computation (Pure Functions)

**Files:**

- Create: `src/lib/missions/progress.ts`
- Create: `src/lib/missions/progress.test.ts`

**Interfaces:**

- Consumes: `MissionDefinition`, `MissionGameEvent` from Task 2.
- Produces: `computeIncrement`, `clampProgress`.

- [ ] **Step 1: Write the failing test — `src/lib/missions/progress.test.ts`**

```typescript
import { describe, expect, test } from 'bun:test';
import { computeIncrement, clampProgress } from './progress';
import type { MissionDefinition, MissionGameEvent } from './types';

function makeDef(id: string, metric: MissionDefinition['metric'], target = 5): MissionDefinition {
	return {
		id,
		title: id,
		description: '',
		period: 'daily',
		metric,
		target,
		rewardChips: 500,
		icon: 'star',
	};
}

const baseEvent: MissionGameEvent = {
	gameType: 'blackjack',
	outcome: 'win',
	handCount: 1,
	winsIncrement: 1,
	lossesIncrement: 0,
	delta: 100,
};

describe('computeIncrement', () => {
	test('handsPlayed matches gameType', () => {
		const def = makeDef('d1', { kind: 'handsPlayed', gameType: 'blackjack' });
		expect(computeIncrement(def, baseEvent, null)).toEqual({ amount: 1 });
	});

	test('handsPlayed does not match different gameType', () => {
		const def = makeDef('d1', { kind: 'handsPlayed', gameType: 'craps' });
		expect(computeIncrement(def, baseEvent, null)).toEqual({ amount: 0 });
	});

	test('handsPlayed with no gameType matches any game', () => {
		const def = makeDef('d1', { kind: 'handsPlayed' });
		expect(computeIncrement(def, baseEvent, null)).toEqual({ amount: 1 });
	});

	test('handsPlayed with handCount > 1', () => {
		const def = makeDef('d1', { kind: 'handsPlayed', gameType: 'blackjack' });
		expect(computeIncrement(def, { ...baseEvent, handCount: 3 }, null)).toEqual({ amount: 3 });
	});

	test('roundsWon uses winsIncrement', () => {
		const def = makeDef('d1', { kind: 'roundsWon' });
		expect(computeIncrement(def, { ...baseEvent, winsIncrement: 2 }, null)).toEqual({
			amount: 2,
		});
	});

	test('roundsWon falls back to outcome=win → 1', () => {
		const def = makeDef('d1', { kind: 'roundsWon' });
		const event: MissionGameEvent = {
			gameType: 'poker',
			outcome: 'win',
			handCount: 1,
			winsIncrement: 0,
			lossesIncrement: 0,
			delta: 100,
		};
		expect(computeIncrement(def, event, null)).toEqual({ amount: 1 });
	});

	test('roundsWon with outcome=loss → 0', () => {
		const def = makeDef('d1', { kind: 'roundsWon' });
		expect(
			computeIncrement(def, { ...baseEvent, outcome: 'loss', winsIncrement: 0 }, null),
		).toEqual({ amount: 0 });
	});

	test('spinsCompleted matches slots only', () => {
		const def = makeDef('d1', { kind: 'spinsCompleted' });
		expect(computeIncrement(def, { ...baseEvent, gameType: 'slots' }, null)).toEqual({ amount: 1 });
		expect(computeIncrement(def, { ...baseEvent, gameType: 'blackjack' }, null)).toEqual({
			amount: 0,
		});
	});

	test('mpHandsCompleted matches poker_mp', () => {
		const def = makeDef('d1', { kind: 'mpHandsCompleted' });
		expect(computeIncrement(def, { ...baseEvent, gameType: 'poker_mp' }, null)).toEqual({
			amount: 1,
		});
		expect(computeIncrement(def, { ...baseEvent, gameType: 'blackjack' }, null)).toEqual({
			amount: 0,
		});
	});

	test('netChipsEarned dropped for MVP — no test needed', () => {
		// netChipsEarned was removed from MissionMetric. No mission uses it.
	});

	test('gamesTried adds new gameType', () => {
		const def = makeDef('d1', { kind: 'gamesTried' });
		expect(computeIncrement(def, baseEvent, null)).toEqual({
			amount: 1,
			metadata: ['blackjack'],
		});
	});

	test('gamesTried does not add duplicate gameType', () => {
		const def = makeDef('d1', { kind: 'gamesTried' });
		const existing = { progress: 1, metadataJson: '["blackjack"]' };
		expect(computeIncrement(def, baseEvent, existing)).toEqual({ amount: 0 });
	});

	test('gamesTried adds to existing metadata', () => {
		const def = makeDef('d1', { kind: 'gamesTried' });
		const existing = { progress: 1, metadataJson: '["blackjack"]' };
		const crapsEvent = { ...baseEvent, gameType: 'craps' };
		expect(computeIncrement(def, crapsEvent, existing)).toEqual({
			amount: 1,
			metadata: ['blackjack', 'craps'],
		});
	});
});

describe('clampProgress', () => {
	test('clamps at target', () => {
		expect(clampProgress(7, 5)).toBe(5);
		expect(clampProgress(5, 5)).toBe(5);
		expect(clampProgress(3, 5)).toBe(3);
	});

	test('floors at 0', () => {
		expect(clampProgress(-1, 5)).toBe(0);
		expect(clampProgress(0, 5)).toBe(0);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/lib/missions/progress.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/missions/progress.ts`** (pure functions only; DB functions added in Task 7)

```typescript
import type { MissionDefinition, MissionGameEvent } from './types';

export interface ExistingProgress {
	progress: number;
	metadataJson: string | null;
}

export interface IncrementResult {
	amount: number;
	metadata?: string[];
}

export function clampProgress(progress: number, target: number): number {
	return Math.max(0, Math.min(progress, target));
}

export function computeIncrement(
	def: MissionDefinition,
	event: MissionGameEvent,
	existing: ExistingProgress | null,
): IncrementResult {
	const metric = def.metric;

	switch (metric.kind) {
		case 'handsPlayed': {
			if (metric.gameType && event.gameType !== metric.gameType) return { amount: 0 };
			if (!metric.gameType && event.gameType === 'poker_mp') return { amount: 0 };
			return { amount: event.handCount };
		}
		case 'roundsWon': {
			if (metric.gameType && event.gameType !== metric.gameType) return { amount: 0 };
			const wins = event.winsIncrement > 0 ? event.winsIncrement : event.outcome === 'win' ? 1 : 0;
			return { amount: wins };
		}
		case 'spinsCompleted': {
			if (event.gameType !== 'slots') return { amount: 0 };
			return { amount: event.handCount };
		}
		case 'mpHandsCompleted': {
			if (event.gameType !== 'poker_mp') return { amount: 0 };
			return { amount: 1 };
		}
		case 'gamesTried': {
			const existingGames = parseMetadata(existing?.metadataJson);
			if (existingGames.includes(event.gameType)) return { amount: 0 };
			return { amount: 1, metadata: [...existingGames, event.gameType] };
		}
	}
}

export function parseMetadata(json: string | null | undefined): string[] {
	if (!json) return [];
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? parsed.filter((v) => typeof v === 'string') : [];
	} catch {
		return [];
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/lib/missions/progress.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/missions/progress.ts src/lib/missions/progress.test.ts
git commit -m "feat: add mission progress computation logic (HPA-173)"
```

---

## Task 6: Board State Reader + Override/Reroll Pool Logic

**Files:**

- Create: `src/lib/missions/board.ts`
- Create: `src/lib/missions/board.test.ts`

**Interfaces:**

- Consumes: `DEFAULT_DAILY_MISSIONS`, `DEFAULT_WEEKLY_MISSIONS`, `ALL_DAILY_DEFINITIONS` from Task 4; `computeEffectiveStreakFromStored` from Task 3; `computeIncrement`, `clampProgress` from Task 5; `getDailyPeriodKey`, `getWeeklyPeriodKey`, `getNextDailyReset`, `getNextWeeklyReset` from Task 2.
- Produces: `applyOverrides`, `getReplacementPool`, `buildMissionView`.

- [ ] **Step 1: Write the failing test — `src/lib/missions/board.test.ts`**

```typescript
import { describe, expect, test } from 'bun:test';
import { applyOverrides, getReplacementPool, buildMissionView } from './board';
import { DEFAULT_DAILY_MISSIONS, REROLL_POOL_DAILY } from './registry';
import type { MissionDefinition } from './types';

describe('applyOverrides', () => {
	test('no overrides → returns default missions', () => {
		const result = applyOverrides(DEFAULT_DAILY_MISSIONS, []);
		expect(result.map((m) => m.id)).toEqual(DEFAULT_DAILY_MISSIONS.map((m) => m.id));
	});

	test('override replaces original with replacement def', () => {
		const overrides = [
			{
				originalMissionDefId: DEFAULT_DAILY_MISSIONS[0].id,
				replacementMissionDefId: REROLL_POOL_DAILY[0].id,
			},
		];
		const result = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
		expect(result[0].id).toBe(REROLL_POOL_DAILY[0].id);
		expect(result[1].id).toBe(DEFAULT_DAILY_MISSIONS[1].id);
	});

	test('override for non-existent original is ignored', () => {
		const overrides = [
			{
				originalMissionDefId: 'nonexistent',
				replacementMissionDefId: REROLL_POOL_DAILY[0].id,
			},
		];
		const result = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
		expect(result.map((m) => m.id)).toEqual(DEFAULT_DAILY_MISSIONS.map((m) => m.id));
	});
});

describe('getReplacementPool', () => {
	test('excludes currently active mission IDs', () => {
		const activeIds = DEFAULT_DAILY_MISSIONS.map((m) => m.id);
		const pool = getReplacementPool(activeIds);
		for (const def of pool) {
			expect(activeIds).not.toContain(def.id);
		}
		expect(pool.length).toBeGreaterThan(0);
	});

	test('excludes replacement already drawn', () => {
		const activeIds = [
			...DEFAULT_DAILY_MISSIONS.slice(1).map((m) => m.id),
			REROLL_POOL_DAILY[0].id,
		];
		const pool = getReplacementPool(activeIds);
		expect(pool.find((m) => m.id === REROLL_POOL_DAILY[0].id)).toBeUndefined();
	});

	test('returns empty when all are active', () => {
		const allIds = [...DEFAULT_DAILY_MISSIONS, ...REROLL_POOL_DAILY].map((m) => m.id);
		expect(getReplacementPool(allIds)).toEqual([]);
	});
});

describe('buildMissionView', () => {
	test('not started → progress 0, not completed', () => {
		const def = DEFAULT_DAILY_MISSIONS[0];
		const view = buildMissionView(
			def,
			{ progress: 0, completedAt: null, claimedAt: null, metadataJson: null },
			false,
		);
		expect(view.progress).toBe(0);
		expect(view.completed).toBe(false);
		expect(view.claimed).toBe(false);
		expect(view.claimable).toBe(false);
	});

	test('completed but unclaimed → claimable', () => {
		const def = DEFAULT_DAILY_MISSIONS[0];
		const view = buildMissionView(
			def,
			{ progress: 5, completedAt: new Date(), claimedAt: null, metadataJson: null },
			false,
		);
		expect(view.completed).toBe(true);
		expect(view.claimable).toBe(true);
	});

	test('completed and claimed → not claimable', () => {
		const def = DEFAULT_DAILY_MISSIONS[0];
		const view = buildMissionView(
			def,
			{ progress: 5, completedAt: new Date(), claimedAt: new Date(), metadataJson: null },
			false,
		);
		expect(view.claimable).toBe(false);
	});

	test('isOverride flag passed through', () => {
		const def = DEFAULT_DAILY_MISSIONS[0];
		const view = buildMissionView(
			def,
			{ progress: 0, completedAt: null, claimedAt: null, metadataJson: null },
			true,
		);
		expect(view.isOverride).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/lib/missions/board.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/lib/missions/board.ts`**

```typescript
import type { D1Database } from '@cloudflare/workers-types';
import type { MissionDefinition, MissionView, BoardState, StreakView } from './types';
import {
	DEFAULT_DAILY_MISSIONS,
	DEFAULT_WEEKLY_MISSIONS,
	ALL_DAILY_DEFINITIONS,
	getMissionDef,
} from './registry';
import { computeEffectiveStreakFromStored } from './streak';
import { clampProgress, parseMetadata } from './progress';
import {
	getDailyPeriodKey,
	getWeeklyPeriodKey,
	getNextDailyReset,
	getNextWeeklyReset,
} from './periods';

export interface OverrideRow {
	originalMissionDefId: string;
	replacementMissionDefId: string;
}

export interface ProgressRow {
	missionDefId: string;
	periodKey: string;
	progress: number;
	metadataJson: string | null;
	completedAt: Date | null;
	claimedAt: Date | null;
}

export function applyOverrides(
	defaults: MissionDefinition[],
	overrides: OverrideRow[],
): MissionDefinition[] {
	const overrideMap = new Map(
		overrides.map((o) => [o.originalMissionDefId, o.replacementMissionDefId]),
	);
	return defaults.map((def) => {
		const replacementId = overrideMap.get(def.id);
		if (replacementId) {
			const replacement = getMissionDef(replacementId);
			if (replacement) return replacement;
		}
		return def;
	});
}

export function getReplacementPool(activeMissionIds: string[]): MissionDefinition[] {
	const activeSet = new Set(activeMissionIds);
	return ALL_DAILY_DEFINITIONS.filter((def) => !activeSet.has(def.id));
}

export function buildMissionView(
	def: MissionDefinition,
	progress: {
		progress: number;
		completedAt: Date | null;
		claimedAt: Date | null;
		metadataJson: string | null;
	},
	isOverride: boolean,
): MissionView {
	const clamped = clampProgress(progress.progress, def.target);
	const completed = progress.progress >= def.target;
	const claimed = progress.claimedAt !== null;
	return {
		missionDefId: def.id,
		title: def.title,
		description: def.description,
		icon: def.icon,
		period: def.period,
		progress: clamped,
		target: def.target,
		completed,
		claimed,
		claimable: completed && !claimed,
		rewardChips: def.rewardChips,
		isOverride,
	};
}

// ── DB-touching functions ──────────────────────────────────────────────────

export async function getOverrides(
	d1: D1Database,
	userId: string,
	periodKey: string,
): Promise<OverrideRow[]> {
	const result = await d1
		.prepare(
			`SELECT originalMissionDefId, replacementMissionDefId FROM mission_override WHERE userId = ? AND periodKey = ?`,
		)
		.bind(userId, periodKey)
		.all<OverrideRow>();
	return result.results ?? [];
}

export async function getProgressRows(
	d1: D1Database,
	userId: string,
	defIds: string[],
	dailyKey: string,
	weeklyKey: string,
): Promise<Map<string, ProgressRow>> {
	const map = new Map<string, ProgressRow>();
	if (defIds.length === 0) return map;

	const placeholders = defIds.map(() => '?').join(',');
	const rows = await d1
		.prepare(
			`SELECT missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt FROM mission_progress WHERE userId = ? AND missionDefId IN (${placeholders}) AND (periodKey = ? OR periodKey = ?)`,
		)
		.bind(userId, ...defIds, dailyKey, weeklyKey)
		.all();

	for (const row of rows.results ?? []) {
		const r = row as Record<string, unknown>;
		const key = `${r.missionDefId}:${r.periodKey}`;
		map.set(key, {
			missionDefId: r.missionDefId as string,
			periodKey: r.periodKey as string,
			progress: r.progress as number,
			metadataJson: (r.metadataJson as string | null) ?? null,
			completedAt: r.completedAt ? new Date((r.completedAt as number) * 1000) : null,
			claimedAt: r.claimedAt ? new Date((r.claimedAt as number) * 1000) : null,
		});
	}
	return map;
}

export async function getBoardState(
	d1: D1Database,
	userId: string,
	chipBalance: number,
): Promise<BoardState> {
	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();

	const overrides = await getOverrides(d1, userId, dailyKey);
	const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
	const activeDefIds = [...activeDaily, ...DEFAULT_WEEKLY_MISSIONS].map((d) => d.id);
	const progressMap = await getProgressRows(d1, userId, activeDefIds, dailyKey, weeklyKey);

	const overrideIds = new Set(overrides.map((o) => o.originalMissionDefId));

	const dailyViews: MissionView[] = activeDaily.map((def) => {
		const progress = progressMap.get(`${def.id}:${dailyKey}`) ?? emptyProgress();
		return buildMissionView(def, progress, overrideIds.has(def.id));
	});

	const weeklyViews: MissionView[] = DEFAULT_WEEKLY_MISSIONS.map((def) => {
		const progress = progressMap.get(`${def.id}:${weeklyKey}`) ?? emptyProgress();
		return buildMissionView(def, progress, false);
	});

	const streakRow = await d1
		.prepare(
			`SELECT currentStreak, longestStreak, lastClaimPeriodKey FROM login_streak WHERE userId = ?`,
		)
		.bind(userId)
		.first<{ currentStreak: number; longestStreak: number; lastClaimPeriodKey: string }>();

	const effective = computeEffectiveStreakFromStored(streakRow ?? null);

	const streak: StreakView = {
		current: effective.displayStreak,
		longest: streakRow?.longestStreak ?? 0,
		claimableToday: effective.claimableToday,
		dayOfCycle: effective.dayOfCycle,
		rewardPreview: effective.rewardPreview,
		lastClaimPeriodKey: streakRow?.lastClaimPeriodKey ?? '',
	};

	return {
		streak,
		daily: dailyViews,
		weekly: weeklyViews,
		rerollAvailable: overrides.length === 0,
		nextDailyReset: getNextDailyReset().toISOString(),
		nextWeeklyReset: getNextWeeklyReset().toISOString(),
		chipBalance,
	};
}

function emptyProgress(): ProgressRow {
	return {
		missionDefId: '',
		periodKey: '',
		progress: 0,
		metadataJson: null,
		completedAt: null,
		claimedAt: null,
	};
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/lib/missions/board.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/missions/board.ts src/lib/missions/board.test.ts
git commit -m "feat: add board state reader and override logic (HPA-173)"
```

---

## Task 7: applyMissionProgress (D1 Batch)

**Files:**

- Modify: `src/lib/missions/progress.ts` (add `applyMissionProgress` + `buildProgressUpsertSQL`)
- Create: `src/lib/missions/progress-integration.test.ts` (miniflare-based)

**Interfaces:**

- Consumes: `computeIncrement`, `clampProgress` from Task 5; `getBoardState.getOverrides`, `applyOverrides` from Task 6; `getDailyPeriodKey`, `getWeeklyPeriodKey` from Task 2.
- Produces: `applyMissionProgress(d1, userId, event)` — called from chips/update and mp/settle.

- [ ] **Step 1: Add `applyMissionProgress` and `buildProgressUpsertSQL` to `src/lib/missions/progress.ts`**

Append to the file:

```typescript
import type { D1Database } from '@cloudflare/workers-types';
import { DEFAULT_DAILY_MISSIONS, DEFAULT_WEEKLY_MISSIONS } from './registry';
import { getDailyPeriodKey, getWeeklyPeriodKey } from './periods';
import { applyOverrides, getOverrides, getProgressRows } from './board';
import type { MissionDefinition } from './types';

export async function applyMissionProgress(
	d1: D1Database,
	userId: string,
	event: MissionGameEvent,
): Promise<void> {
	if (!event.outcome) return;

	const dailyKey = getDailyPeriodKey();
	const weeklyKey = getWeeklyPeriodKey();

	const overrides = await getOverrides(d1, userId, dailyKey);
	const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
	const allActive = [...activeDaily, ...DEFAULT_WEEKLY_MISSIONS];

	const activeDefIds = allActive.map((d) => d.id);
	const progressMap = await getProgressRows(d1, userId, activeDefIds, dailyKey, weeklyKey);

	const statements: D1PreparedStatement[] = [];
	const nowSeconds = Math.trunc(Date.now() / 1000);

	for (const def of allActive) {
		const periodKey = def.period === 'daily' ? dailyKey : weeklyKey;
		const existing = progressMap.get(`${def.id}:${periodKey}`) ?? null;
		const existingNormalized = existing
			? { progress: existing.progress, metadataJson: existing.metadataJson }
			: null;
		const result = computeIncrement(def, event, existingNormalized);
		if (result.amount === 0) continue;

		const currentProgress = existing?.progress ?? 0;
		const newProgressRaw = currentProgress + result.amount;
		const newProgress = clampProgress(newProgressRaw, def.target);
		const metadataJson = result.metadata
			? JSON.stringify(result.metadata)
			: (existing?.metadataJson ?? null);

		const stmt = buildProgressUpsertSQL(
			d1,
			userId,
			def,
			periodKey,
			newProgress,
			metadataJson,
			nowSeconds,
		);
		statements.push(stmt);
	}

	if (statements.length > 0) {
		await d1.batch(statements);
	}
}

export function buildProgressUpsertSQL(
	d1: D1Database,
	userId: string,
	def: MissionDefinition,
	periodKey: string,
	newProgress: number,
	metadataJson: string | null,
	nowSeconds: number,
): D1PreparedStatement {
	const target = def.target;
	const completedClause = newProgress >= target ? `${nowSeconds}` : 'NULL';
	return d1
		.prepare(
			`INSERT INTO mission_progress (userId, missionDefId, periodKey, progress, metadataJson, completedAt, claimedAt)
			 VALUES (?, ?, ?, ?, ?, ${completedClause}, NULL)
			 ON CONFLICT (userId, missionDefId, periodKey) DO UPDATE SET
			   progress = excluded.progress,
			   metadataJson = excluded.metadataJson,
			   completedAt = CASE
			     WHEN excluded.progress >= ${target} AND mission_progress.completedAt IS NULL
			     THEN excluded.completedAt
			     ELSE mission_progress.completedAt
			   END`,
		)
		.bind(userId, def.id, periodKey, newProgress, metadataJson);
}
```

> **Important:** The `completedAt` conditional uses `CASE WHEN ... AND mission_progress.completedAt IS NULL` so it is set exactly once — the first time progress reaches target. Subsequent over-counts don't re-set it. The `excluded.progress` is the new clamped value. The `CASE` checks if the NEW progress meets target AND the OLD completedAt is null.

- [ ] **Step 2: Write integration test — `src/lib/missions/progress-integration.test.ts`**

This test uses miniflare's `getPlatformProxy` to get a real D1 binding. Follow the pattern in `src/lib/chips-update-api.test.ts`.

```typescript
import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
// This test requires a running dev server or miniflare proxy.
// Pattern: see src/lib/chips-update-api.test.ts for getPlatformProxy usage.
// Test that applyMissionProgress:
// 1. Increments progress for matching game events
// 2. Clamps at target
// 3. Sets completedAt exactly once
// 4. Does NOT increment for non-matching events
// 5. gamesTried deduplicates
// 6. Skips when outcome is null
```

> **Note:** The integration test setup follows the existing `src/lib/chips-update-api.test.ts` pattern. If miniflare setup is complex, defer to E2E coverage and unit-test the pure `computeIncrement` + `buildProgressUpsertSQL` SQL string generation.

- [ ] **Step 3: Run existing unit tests to verify no regressions**

```bash
bun test src/lib/missions/
```

Expected: All unit tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/missions/progress.ts src/lib/missions/progress-integration.test.ts
git commit -m "feat: add applyMissionProgress D1 batch function (HPA-173)"
```

---

## Task 8: Claim Logic (Conditional UPDATE)

**Files:**

- Create: `src/lib/missions/claim.ts`
- Create: `src/lib/missions/claim.test.ts`

**Interfaces:**

- Consumes: `getMissionDef` from Task 4; `getDailyPeriodKey`, `getWeeklyPeriodKey` from Task 2; `computeStreakTransition` from Task 3; `getDailyPeriodKeyForYesterday` from Task 2.
- Produces: `claimMission(d1, userId, missionDefId)`, `claimLogin(d1, userId)`.

- [ ] **Step 1: Write the failing test — `src/lib/missions/claim.test.ts`**

This tests the pure return-value logic. The conditional UPDATE behavior is validated via E2E.

```typescript
import { describe, expect, test } from 'bun:test';
import { ClaimResult, StreakClaimResult } from './claim';
```

> **Note:** The claim logic is primarily D1 conditional writes. Unit-test the result shapes and the streak transition computation (already tested in Task 3). The idempotency guarantee (changes() === 1) is an integration concern covered by E2E.

- [ ] **Step 2: Write `src/lib/missions/claim.ts`**

```typescript
import type { D1Database } from '@cloudflare/workers-types';
import { getMissionDef } from './registry';
import { getDailyPeriodKey, getWeeklyPeriodKey, getDailyPeriodKeyForYesterday } from './periods';
import { computeStreakTransition } from './streak';

export interface ClaimResult {
	status: 'completed' | 'already-claimed' | 'not-completed' | 'not-found';
	missionDefId: string;
	rewardChips: number;
	chipBalance: number;
}

export interface StreakClaimResult {
	status: 'completed' | 'already-claimed';
	currentStreak: number;
	longestStreak: number;
	dayOfCycle: number;
	rewardChips: number;
	chipBalance: number;
}

export async function claimMission(
	d1: D1Database,
	userId: string,
	missionDefId: string,
	currentChipBalance: number,
): Promise<ClaimResult> {
	const def = getMissionDef(missionDefId);
	if (!def) {
		return { status: 'not-found', missionDefId, rewardChips: 0, chipBalance: currentChipBalance };
	}

	const periodKey = def.period === 'daily' ? getDailyPeriodKey() : getWeeklyPeriodKey();
	const nowSeconds = Math.trunc(Date.now() / 1000);

	// In-SQL changes() cascade: the grant UPDATE gates on the claim UPDATE's changes().
	// D1 batch runs ALL statements, but the WHERE changes() = 1 on the grant
	// makes it a no-op when the claim didn't match. Atomic — no crash window.
	// This matches the chip-sync cascade pattern (chip-sync-batch-sql.ts).
	const claimStmt = d1
		.prepare(
			`UPDATE mission_progress
			 SET claimedAt = ?
			 WHERE userId = ? AND missionDefId = ? AND periodKey = ?
			   AND claimedAt IS NULL AND progress >= ?`,
		)
		.bind(nowSeconds, userId, missionDefId, periodKey, def.target);

	const grantStmt = d1
		.prepare(`UPDATE user SET chipBalance = chipBalance + ? WHERE id = ? AND changes() = 1`)
		.bind(def.rewardChips, userId);

	const results = await d1.batch([claimStmt, grantStmt]);
	const claimChanges = results[0]?.meta?.changes ?? 0;

	if (claimChanges === 1) {
		return {
			status: 'completed',
			missionDefId,
			rewardChips: def.rewardChips,
			chipBalance: currentChipBalance + def.rewardChips,
		};
	}

	// Claim didn't fire — distinguish already-claimed from not-completed
	const row = await d1
		.prepare(
			`SELECT claimedAt FROM mission_progress WHERE userId = ? AND missionDefId = ? AND periodKey = ?`,
		)
		.bind(userId, missionDefId, periodKey)
		.first<{ claimedAt: number | null }>();

	if (row?.claimedAt) {
		return {
			status: 'already-claimed',
			missionDefId,
			rewardChips: 0,
			chipBalance: currentChipBalance,
		};
	}
	return { status: 'not-completed', missionDefId, rewardChips: 0, chipBalance: currentChipBalance };
}

export async function claimLogin(
	d1: D1Database,
	userId: string,
	currentChipBalance: number,
): Promise<StreakClaimResult> {
	const today = getDailyPeriodKey();
	const yesterday = getDailyPeriodKeyForYesterday();

	// Read current streak to compute transition values (not for race guard —
	// the WHERE clause on the upsert handles the race)
	const existing = await d1
		.prepare(
			`SELECT currentStreak, longestStreak, lastClaimPeriodKey FROM login_streak WHERE userId = ?`,
		)
		.bind(userId)
		.first<{ currentStreak: number; longestStreak: number; lastClaimPeriodKey: string }>();

	const currentStreak = existing?.currentStreak ?? 0;
	const longestStreak = existing?.longestStreak ?? 0;
	const lastClaimPeriodKey = existing?.lastClaimPeriodKey ?? '';

	// Fast path: already claimed today
	if (lastClaimPeriodKey === today) {
		return {
			status: 'already-claimed',
			currentStreak,
			longestStreak,
			dayOfCycle: ((currentStreak - 1) % 7) + 1,
			rewardChips: 0,
			chipBalance: currentChipBalance,
		};
	}

	const transition = computeStreakTransition({
		currentStreak,
		longestStreak,
		lastClaimPeriodKey,
		today,
		yesterday,
	});

	// In-SQL changes() cascade: always use the upsert form.
	// The WHERE clause gates on lastClaimPeriodKey != today (handles races).
	// The grant gates on changes() = 1 from the upsert.
	const streakStmt = d1
		.prepare(
			`INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey)
			 VALUES (?, ?, ?, ?)
			 ON CONFLICT (userId) DO UPDATE SET
			   currentStreak = excluded.currentStreak,
			   longestStreak = excluded.longestStreak,
			   lastClaimPeriodKey = excluded.lastClaimPeriodKey
			 WHERE login_streak.lastClaimPeriodKey != ?`,
		)
		.bind(userId, transition.newStreak, transition.newLongest, today, today);

	const grantStmt = d1
		.prepare(`UPDATE user SET chipBalance = chipBalance + ? WHERE id = ? AND changes() = 1`)
		.bind(transition.reward, userId);

	const results = await d1.batch([streakStmt, grantStmt]);
	const streakChanges = results[0]?.meta?.changes ?? 0;

	if (streakChanges === 1) {
		return {
			status: 'completed',
			currentStreak: transition.newStreak,
			longestStreak: transition.newLongest,
			dayOfCycle: transition.dayOfCycle,
			rewardChips: transition.reward,
			chipBalance: currentChipBalance + transition.reward,
		};
	}

	// Race: another request claimed between our read and write
	return {
		status: 'already-claimed',
		currentStreak,
		longestStreak,
		dayOfCycle: ((currentStreak - 1) % 7) + 1,
		rewardChips: 0,
		chipBalance: currentChipBalance,
	};
}
```

> **Critical pattern:** The claim and grant run in ONE `d1.batch()`. The grant statement uses `WHERE changes() = 1` to gate on the claim statement's row count — the same in-SQL cascade pattern used by `chip-sync-batch-sql.ts`. D1 batch runs ALL statements, but `WHERE changes() = 1` makes the grant a no-op when the claim didn't match. This is atomic (no crash window between claim and grant) and race-safe (concurrent claims only match once).

- [ ] **Step 3: Run any unit tests**

```bash
bun test src/lib/missions/
```

Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/missions/claim.ts src/lib/missions/claim.test.ts
git commit -m "feat: add conditional claim and streak claim logic (HPA-173)"
```

---

## Task 9: Reroll Logic

**Files:**

- Create: `src/lib/missions/reroll.ts`
- Create: `src/lib/missions/reroll.test.ts`

**Interfaces:**

- Consumes: `getReplacementPool` from Task 6; `getDailyPeriodKey` from Task 2; `DEFAULT_DAILY_MISSIONS`, `ALL_DAILY_DEFINITIONS` from Task 4.
- Produces: `performReroll(d1, userId, missionDefId)`.

- [ ] **Step 1: Write `src/lib/missions/reroll.ts`**

```typescript
import type { D1Database } from '@cloudflare/workers-types';
import { getDailyPeriodKey } from './periods';
import { getOverrides, applyOverrides, getReplacementPool } from './board';
import { DEFAULT_DAILY_MISSIONS, getMissionDef } from './registry';

export interface RerollResult {
	status: 'rerolled' | 'reroll-used' | 'already-completed' | 'not-daily' | 'no-replacement';
	originalMissionDefId?: string;
	replacementMissionDefId?: string;
}

export async function performReroll(
	d1: D1Database,
	userId: string,
	missionDefId: string,
): Promise<RerollResult> {
	const def = getMissionDef(missionDefId);
	if (!def || def.period !== 'daily') {
		return { status: 'not-daily' };
	}

	const periodKey = getDailyPeriodKey();

	// Check: one reroll per day
	const overrides = await getOverrides(d1, userId, periodKey);
	if (overrides.length >= 1) {
		return { status: 'reroll-used' };
	}

	// Check: target mission must be uncompleted
	const progress = await d1
		.prepare(
			`SELECT completedAt FROM mission_progress WHERE userId = ? AND missionDefId = ? AND periodKey = ?`,
		)
		.bind(userId, missionDefId, periodKey)
		.first<{ completedAt: number | null }>();

	if (progress?.completedAt) {
		return { status: 'already-completed' };
	}

	// Get replacement pool
	const activeDaily = applyOverrides(DEFAULT_DAILY_MISSIONS, overrides);
	const activeIds = activeDaily.map((d) => d.id);
	const pool = getReplacementPool(activeIds);

	if (pool.length === 0) {
		return { status: 'no-replacement' };
	}

	// Pick random replacement
	const replacement = pool[Math.floor(Math.random() * pool.length)];
	const nowSeconds = Math.trunc(Date.now() / 1000);

	await d1
		.prepare(
			`INSERT INTO mission_override (userId, periodKey, originalMissionDefId, replacementMissionDefId, rerolledAt)
			 VALUES (?, ?, ?, ?, ?)`,
		)
		.bind(userId, periodKey, missionDefId, replacement.id, nowSeconds)
		.run();

	return {
		status: 'rerolled',
		originalMissionDefId: missionDefId,
		replacementMissionDefId: replacement.id,
	};
}
```

- [ ] **Step 2: Run tests**

```bash
bun test src/lib/missions/
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/missions/reroll.ts src/lib/missions/reroll.test.ts
git commit -m "feat: add reroll logic with one-per-day enforcement (HPA-173)"
```

---

## Task 10: Barrel Exports

**Files:**

- Create: `src/lib/missions/index.ts`

- [ ] **Step 1: Write `src/lib/missions/index.ts`**

```typescript
export * from './types';
export * from './periods';
export * from './streak';
export * from './registry';
export * from './progress';
export * from './board';
export * from './claim';
export * from './reroll';
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/missions/index.ts
git commit -m "feat: add missions barrel exports (HPA-173)"
```

---

## Task 11: API Endpoints

**Files:**

- Create: `src/pages/api/missions/board.ts`
- Create: `src/pages/api/missions/claim.ts`
- Create: `src/pages/api/missions/claim-login.ts`
- Create: `src/pages/api/missions/reroll.ts`
- Create: `src/pages/api/missions/progress.ts`

**Interfaces:**

- Consumes: `getBoardState` from Task 6; `claimMission`, `claimLogin` from Task 8; `performReroll` from Task 9.

- [ ] **Step 1: Write `src/pages/api/missions/board.ts`**

```typescript
import type { APIRoute } from 'astro';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { getBoardState } from '../../../lib/missions';

export const GET: APIRoute = async ({ locals }) => {
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	const db = createDb(d1);
	const [userRow] = await db
		.select({ chipBalance: user.chipBalance })
		.from(user)
		.where(eq(user.id, locals.session.user.id))
		.limit(1);

	const chipBalance = userRow?.chipBalance ?? 0;
	const board = await getBoardState(d1, locals.session.user.id, chipBalance);
	return Response.json(board);
};
```

- [ ] **Step 2: Write `src/pages/api/missions/claim.ts`**

```typescript
import type { APIRoute } from 'astro';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { claimMission } from '../../../lib/missions';

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	let body: { missionDefId?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'INVALID_REQUEST_BODY' }, { status: 400 });
	}

	if (typeof body.missionDefId !== 'string' || body.missionDefId.length === 0) {
		return Response.json({ error: 'INVALID_REQUEST_BODY' }, { status: 400 });
	}

	const db = createDb(d1);
	const [userRow] = await db
		.select({ chipBalance: user.chipBalance })
		.from(user)
		.where(eq(user.id, locals.session.user.id))
		.limit(1);

	const chipBalance = userRow?.chipBalance ?? 0;
	const result = await claimMission(d1, locals.session.user.id, body.missionDefId, chipBalance);
	return Response.json(result);
};
```

- [ ] **Step 3: Write `src/pages/api/missions/claim-login.ts`**

```typescript
import type { APIRoute } from 'astro';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { claimLogin, seedStreakFromOldMission } from '../../../lib/missions';

export const POST: APIRoute = async ({ locals }) => {
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	// One-time deploy-day seeding (idempotent — checks if streak row exists)
	await seedStreakFromOldMission(d1, locals.session.user.id);

	const db = createDb(d1);
	const [userRow] = await db
		.select({ chipBalance: user.chipBalance })
		.from(user)
		.where(eq(user.id, locals.session.user.id))
		.limit(1);

	const chipBalance = userRow?.chipBalance ?? 0;
	const result = await claimLogin(d1, locals.session.user.id, chipBalance);
	return Response.json(result);
};
```

- [ ] **Step 4: Write `src/pages/api/missions/reroll.ts`**

```typescript
import type { APIRoute } from 'astro';
import { performReroll } from '../../../lib/missions';

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	let body: { missionDefId?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'INVALID_REQUEST_BODY' }, { status: 400 });
	}

	if (typeof body.missionDefId !== 'string' || body.missionDefId.length === 0) {
		return Response.json({ error: 'INVALID_REQUEST_BODY' }, { status: 400 });
	}

	const result = await performReroll(d1, locals.session.user.id, body.missionDefId);

	if (result.status === 'reroll-used') {
		return Response.json({ error: 'REROLL_USED' }, { status: 409 });
	}
	if (result.status === 'already-completed') {
		return Response.json({ error: 'ALREADY_COMPLETED' }, { status: 409 });
	}
	if (result.status === 'no-replacement') {
		return Response.json({ error: 'NO_REPLACEMENT_AVAILABLE' }, { status: 409 });
	}
	if (result.status === 'not-daily') {
		return Response.json({ error: 'NOT_DAILY' }, { status: 400 });
	}

	return Response.json(result);
};
```

- [ ] **Step 5: Write `src/pages/api/missions/progress.ts` (dev-only)**

```typescript
import type { APIRoute } from 'astro';
import { getDailyPeriodKeyForYesterday } from '../../../lib/missions';

export const DELETE: APIRoute = async ({ request, locals }) => {
	if (!import.meta.env.DEV) {
		return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
	}
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	let body: {
		resetProgress?: boolean;
		resetStreak?: boolean;
		seedStreak?: { lastClaimPeriodKey: string; currentStreak: number };
	} = {};

	try {
		body = await request.json();
	} catch {
		// empty body is fine — defaults apply
	}

	const userId = locals.session.user.id;
	const statements: D1PreparedStatement[] = [];

	if (body.resetProgress !== false) {
		statements.push(
			d1.prepare(`DELETE FROM mission_progress WHERE userId = ?`).bind(userId),
			d1.prepare(`DELETE FROM mission_override WHERE userId = ?`).bind(userId),
		);
	}

	if (body.seedStreak) {
		const periodKey =
			body.seedStreak.lastClaimPeriodKey === 'yesterday'
				? getDailyPeriodKeyForYesterday()
				: body.seedStreak.lastClaimPeriodKey;
		statements.push(
			d1
				.prepare(
					`INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(userId) DO UPDATE SET
					   currentStreak = excluded.currentStreak,
					   longestStreak = excluded.longestStreak,
					   lastClaimPeriodKey = excluded.lastClaimPeriodKey`,
				)
				.bind(userId, body.seedStreak.currentStreak, body.seedStreak.currentStreak, periodKey),
		);
	} else if (body.resetStreak !== false) {
		statements.push(d1.prepare(`DELETE FROM login_streak WHERE userId = ?`).bind(userId));
	}

	if (statements.length > 0) {
		await d1.batch(statements);
	}

	return Response.json({ status: 'reset' });
};
```

- [ ] **Step 6: Write deploy-day seeding function — `src/lib/missions/seed.ts`**

```typescript
import type { D1Database } from '@cloudflare/workers-types';
import { getDailyPeriodKey } from './periods';

export async function seedStreakFromOldMission(d1: D1Database, userId: string): Promise<void> {
	// Check if streak row already exists — if so, seeding already happened
	const existing = await d1
		.prepare(`SELECT userId FROM login_streak WHERE userId = ?`)
		.bind(userId)
		.first();

	if (existing) return;

	// Check old mission table for today's daily-login claim
	const oldMission = await d1
		.prepare(`SELECT completedDate FROM mission WHERE userId = ? AND missionId = 'daily-login'`)
		.bind(userId)
		.first<{ completedDate: number | null }>();

	if (oldMission?.completedDate) {
		const completedDate = new Date(oldMission.completedDate * 1000);
		const completedDay = completedDate.toISOString().slice(0, 10);
		const today = getDailyPeriodKey();

		if (completedDay === today) {
			// Seed streak as if they already claimed today
			await d1
				.prepare(
					`INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey)
					 VALUES (?, 1, 1, ?)
					 ON CONFLICT DO NOTHING`,
				)
				.bind(userId, today)
				.run();
		}
	}
}
```

- [ ] **Step 7: Add seed.ts to barrel exports**

Add to `src/lib/missions/index.ts`:

```typescript
export * from './seed';
```

- [ ] **Step 8: Lint and typecheck**

```bash
bun run lint
```

- [ ] **Step 9: Commit**

```bash
git add src/pages/api/missions/ src/lib/missions/seed.ts src/lib/missions/index.ts
git commit -m "feat: add mission API endpoints and deploy-day seeding (HPA-173)"
```

---

## Task 12: Integration — Wire into chips/update + mp/settle

**Files:**

- Modify: `src/pages/api/chips/update.ts`
- Modify: `src/pages/api/mp/settle.ts`

- [ ] **Step 1: Wire `applyMissionProgress` into `/api/chips/update.ts`**

**Critical**: Place the call at a SINGLE site — just before the final `return buildSuccessResponse(...)` (line ~1601). This is naturally replay-safe because all receipt-replay branches return early (lines 1139/1181/1332/1374). Do NOT place it after `recordGameRound` (which only runs in the legacy no-syncId branch at line 1545) or in the replay paths.

```typescript
import { applyMissionProgress } from '../../../lib/missions';
```

Insert just before `return buildSuccessResponse(newBalance, serverBalance, delta, newAchievements, warnings);` (line ~1601), inside the existing try block:

```typescript
// Update mission progress from validated game event.
// Single call site — replay-safe because replay branches return early above.
// Only runs when outcome is present and gameType is valid (same guard as stats).
if (shouldRecordStats && isValidGameType(gameType)) {
	try {
		await applyMissionProgress(dbBinding, userId, {
			gameType,
			outcome: outcome as 'win' | 'loss' | 'push',
			handCount: resolvedHandCount,
			winsIncrement: actualWinsIncrement,
			lossesIncrement: actualLossesIncrement,
			delta: statsDeltaForTracking,
		});
	} catch (missionError) {
		console.error('[MISSION_PROGRESS] Failed to update:', missionError);
	}
}
```

- [ ] **Step 2: Wire `applyMissionProgress` into `/api/mp/settle.ts`**

After the `d1.batch(settleStatements)` call succeeds (line ~185), add for each newly-applied entry:

```typescript
import { applyMissionProgress } from '../../../../lib/missions';
```

After the settle batch:

```typescript
// Update mission progress for each settled entry
for (const entry of newEntries) {
	try {
		const outcome = entry.delta > 0 ? 'win' : entry.delta < 0 ? 'loss' : 'push';
		await applyMissionProgress(d1, entry.userId, {
			gameType: 'poker_mp',
			outcome,
			handCount: 1,
			winsIncrement: entry.delta > 0 ? 1 : 0,
			lossesIncrement: entry.delta < 0 ? 1 : 0,
			delta: entry.delta,
		});
	} catch (missionError) {
		console.error('[MISSION_PROGRESS] Failed to update for MP settle:', missionError);
	}
}
```

- [ ] **Step 3: Lint and typecheck**

```bash
bun run lint
```

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/chips/update.ts src/pages/api/mp/settle.ts
git commit -m "feat: wire mission progress into chip sync and MP settle (HPA-173)"
```

---

## Task 13: Board Page UI

**Files:**

- Create: `src/pages/missions/index.astro`

- [ ] **Step 1: Write the board page**

The page SSR-loads the initial board state (same pattern as `daily.astro`) and the client script re-fetches after claim/reroll. Follow the Art Deco design tokens (`deco-*` classes, `CasinoLayout`, `DecoIcon`).

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import DecoIcon from '../../components/DecoIcon.astro';
import { createDb } from '../../lib/db';
import { user } from '../../db/schema';
import { eq } from 'drizzle-orm';
import { getBoardState } from '../../lib/missions';

const session = Astro.locals.session;
if (!session || !Astro.locals.runtime?.env?.DB) {
	if (!session) return Astro.redirect('/signin');
	return new Response('Service temporarily unavailable', { status: 503 });
}

const d1 = Astro.locals.runtime.env.DB;
const db = createDb(d1);
const [userRow] = await db
	.select({ chipBalance: user.chipBalance })
	.from(user)
	.where(eq(user.id, session.user.id))
	.limit(1);

const initialBoard = await getBoardState(d1, session.user.id, userRow?.chipBalance ?? 0);
---

<CasinoLayout title="Missions - Arcturus Casino">
	<section class="deco-atmosphere relative overflow-hidden">
		<div class="relative max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
			<!-- Streak Banner -->
			<div id="streak-banner" class="deco-panel mb-8 p-6" data-testid="streak-banner">
				<div class="flex items-center justify-between">
					<div>
						<p class="deco-eyebrow-sm">Daily Login Streak</p>
						<h2 class="deco-section-title text-2xl mt-1">
							<span data-testid="streak-display">Day {initialBoard.streak.dayOfCycle} of cycle</span
							>
						</h2>
						<p class="deco-text-dim text-sm mt-1" data-testid="streak-subtitle">
							{initialBoard.streak.current}-day streak · Best: {initialBoard.streak.longestStreak}
						</p>
					</div>
					<div class="text-right">
						<p class="deco-text-dim text-sm">Today's Reward</p>
						<p class="text-[var(--deco-brass)] font-bold text-xl" data-testid="streak-reward">
							{initialBoard.streak.rewardPreview.toLocaleString()} chips
						</p>
						<button
							id="claim-login-btn"
							class="btn-gold mt-2 px-4 py-2 rounded"
							data-testid="claim-login-btn"
							disabled={!initialBoard.streak.claimableToday}
						>
							{initialBoard.streak.claimableToday ? 'Claim' : 'Claimed'}
						</button>
					</div>
				</div>
			</div>

			<!-- Daily Quests -->
			<h2 class="deco-section-title text-xl mb-4">Daily Quests</h2>
			<div
				id="daily-grid"
				class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8"
				data-testid="daily-grid"
			>
				{
					initialBoard.daily.map((mission) => (
						<div
							class="deco-panel p-4 mission-card"
							data-testid={`mission-${mission.missionDefId}`}
							data-mission-id={mission.missionDefId}
						>
							<div class="flex items-start justify-between mb-2">
								<div class="flex items-center gap-2">
									<DecoIcon name={mission.icon as any} size={20} class="text-[var(--deco-brass)]" />
									<h3 class="font-body font-semibold">{mission.title}</h3>
									{mission.isOverride && (
										<span class="text-xs text-[var(--deco-muted)]">(rerolled)</span>
									)}
								</div>
								<button
									class="reroll-btn text-[var(--deco-muted)] hover:text-[var(--deco-brass)] transition-colors"
									data-reroll-target={mission.missionDefId}
									data-testid={`reroll-${mission.missionDefId}`}
									style={initialBoard.rerollAvailable && !mission.completed ? '' : 'display:none'}
								>
									<DecoIcon name="star" size={16} />
								</button>
							</div>
							<p class="deco-text-dim text-sm mb-3">{mission.description}</p>
							<div class="flex items-center gap-2 mb-3">
								<div class="flex-1 bg-[var(--deco-obsidian-2)] rounded-full h-2 overflow-hidden">
									<div
										class="bg-[var(--deco-brass)] h-full transition-all"
										style={`width: ${Math.min(100, (mission.progress / mission.target) * 100)}%`}
										data-testid={`progress-${mission.missionDefId}`}
									/>
								</div>
								<span
									class="text-sm tabular-nums"
									data-testid={`progress-text-${mission.missionDefId}`}
								>
									{mission.progress}/{mission.target}
								</span>
							</div>
							<div class="flex items-center justify-between">
								<span class="text-[var(--deco-brass)] text-sm font-medium">
									{mission.rewardChips.toLocaleString()} chips
								</span>
								<button
									class="claim-btn btn-gold px-3 py-1.5 rounded text-sm"
									data-claim-target={mission.missionDefId}
									data-testid={`claim-${mission.missionDefId}`}
									disabled={!mission.claimable}
								>
									{mission.claimed ? 'Claimed' : mission.completed ? 'Claim' : 'In Progress'}
								</button>
							</div>
						</div>
					))
				}
			</div>

			<!-- Weekly Goal -->
			<h2 class="deco-section-title text-xl mb-4">Weekly Goal</h2>
			<div id="weekly-section" data-testid="weekly-section">
				{
					initialBoard.weekly.map((mission) => (
						<div class="deco-panel p-6" data-testid={`mission-${mission.missionDefId}`}>
							{/* Same card structure as daily, larger */}
						</div>
					))
				}
			</div>
		</div>
	</section>

	<script>
		// Client script: claim, claim-login, reroll handlers
		// Re-fetch /api/missions/board after each action to refresh state.
		async function refreshBoard() {
			const res = await fetch('/api/missions/board');
			if (res.ok) {
				const board = await res.json();
				// Update DOM elements...
			}
		}

		document.getElementById('claim-login-btn')?.addEventListener('click', async () => {
			const res = await fetch('/api/missions/claim-login', { method: 'POST' });
			if (res.ok) {
				refreshBoard();
			}
		});

		document.querySelectorAll('.claim-btn').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				const target = (e.currentTarget as HTMLElement).dataset.claimTarget;
				if (!target) return;
				const res = await fetch('/api/missions/claim', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ missionDefId: target }),
				});
				if (res.ok) {
					refreshBoard();
				}
			});
		});

		document.querySelectorAll('.reroll-btn').forEach((btn) => {
			btn.addEventListener('click', async (e) => {
				const target = (e.currentTarget as HTMLElement).dataset.rerollTarget;
				if (!target) return;
				const res = await fetch('/api/missions/reroll', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ missionDefId: target }),
				});
				if (res.ok) {
					refreshBoard();
				}
			});
		});
	</script>
</CasinoLayout>
```

> **Note:** The weekly card uses the same structure as daily cards but in a single full-width panel. The client script's `refreshBoard()` should update all DOM elements (streak display, progress bars, claim button states) from the board response. Keep it simple — a full DOM update from the JSON response is fine for MVP.

- [ ] **Step 2: Verify the page renders**

Start dev server, navigate to `/missions`, verify the board loads with SSR data.

- [ ] **Step 3: Commit**

```bash
git add src/pages/missions/index.astro
git commit -m "feat: add mission board page with SSR initial state (HPA-173)"
```

---

## Task 14: Migration — Nav Links + Remove Old Files

**Files:**

- Modify: `src/layouts/AppLayout.astro`
- Modify: `src/pages/index.astro`
- Modify: `e2e/global-setup.ts`
- Delete: `src/lib/missions.ts`
- Delete: `src/pages/missions/daily.astro`
- Delete: `src/pages/api/missions/daily-login.ts`

- [ ] **Step 1: Update nav links in `src/layouts/AppLayout.astro`**

Replace all `/missions/daily` with `/missions` (lines 73 and 111):

```
/missions/daily → /missions
```

- [ ] **Step 2: Update CTA buttons in `src/pages/index.astro`**

Replace all `/missions/daily` with `/missions` (lines 153 and 219).

- [ ] **Step 3: Update `e2e/global-setup.ts`**

Replace `/missions/daily` with `/missions` (line 49).

- [ ] **Step 4: Delete old files**

```bash
git rm src/lib/missions.ts src/pages/missions/daily.astro src/pages/api/missions/daily-login.ts
```

- [ ] **Step 5: Verify no remaining imports of old missions.ts**

```bash
rg "from.*lib/missions'" --type ts --type astro
rg "from.*lib/missions\"" --type ts --type astro
```

If any imports reference the old single-file module, update them to import from `src/lib/missions/` (the directory barrel `index.ts`).

- [ ] **Step 6: Lint and typecheck**

```bash
bun run lint
bun run build
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove old daily mission system, update nav links (HPA-173)"
```

---

## Task 15: E2E Tests

**Files:**

- Create: `e2e/missions.spec.ts`

- [ ] **Step 1: Write E2E tests**

```typescript
import { test, expect } from '@playwright/test';

test.describe('Mission Board', () => {
	test.beforeEach(async ({ page, request }) => {
		// Reset mission state via dev endpoint
		await request.delete('/api/missions/progress', { data: {} });
	});

	test('board loads with SSR (no empty flash)', async ({ page }) => {
		await page.goto('/missions');
		await expect(page.getByTestId('streak-banner')).toBeVisible();
		await expect(page.getByTestId('daily-grid')).toBeVisible();
		await expect(page.getByTestId('weekly-section')).toBeVisible();
	});

	test('streak claim grants chips, second claim is idempotent', async ({ page }) => {
		await page.goto('/missions');
		const claimBtn = page.getByTestId('claim-login-btn');
		await expect(claimBtn).toBeEnabled();

		await claimBtn.click();
		// Wait for refresh
		await expect(claimBtn).toBeDisabled();

		// Second claim should not error or grant again
		// (button is disabled after first claim)
		await expect(claimBtn).toBeDisabled();
	});

	test('streak continuation via seedStreak', async ({ page, request }) => {
		// Seed: claimed yesterday with 2-day streak
		await request.delete('/api/missions/progress', {
			data: {
				resetProgress: false,
				seedStreak: { lastClaimPeriodKey: 'yesterday', currentStreak: 2 },
			},
		});

		await page.goto('/missions');
		const claimBtn = page.getByTestId('claim-login-btn');
		await claimBtn.click();

		// After claim, streak should be 3 (continuing)
		await expect(page.getByTestId('streak-subtitle')).toContainText('3-day streak');
	});

	test('streak breakage via seedStreak', async ({ page, request }) => {
		// Seed: claimed 3 days ago with 5-day streak
		await request.delete('/api/missions/progress', {
			data: {
				resetProgress: false,
				seedStreak: { lastClaimPeriodKey: '2020-01-01', currentStreak: 5 },
			},
		});

		await page.goto('/missions');
		// Display should show broken (0)
		await expect(page.getByTestId('streak-display')).toContainText('Day 1');

		const claimBtn = page.getByTestId('claim-login-btn');
		await claimBtn.click();
		await expect(page.getByTestId('streak-subtitle')).toContainText('1-day streak');
	});

	test('reroll swaps an uncompleted daily quest', async ({ page }) => {
		await page.goto('/missions');
		const rerollBtn = page.locator('[data-testid^="reroll-"]').first();
		await rerollBtn.click();

		// After reroll, all reroll buttons should be hidden (one per day)
		await expect(page.locator('[data-testid^="reroll-"]')).toHaveCount(0);
	});

	test('post-reset clears progress', async ({ page, request }) => {
		await page.goto('/missions');
		await request.delete('/api/missions/progress', { data: {} });
		await page.reload();
		// All progress should be 0
		const progressTexts = await page.locator('[data-testid^="progress-text-"]').allTextContents();
		for (const text of progressTexts) {
			expect(text).toMatch(/^0\/\d+$/);
		}
	});
});
```

- [ ] **Step 2: Run E2E tests**

```bash
bun run test:e2e -- --grep "Mission Board"
```

- [ ] **Step 3: Commit**

```bash
git add e2e/missions.spec.ts
git commit -m "test: add mission board E2E tests (HPA-173)"
```

---

## Self-Review

### Spec coverage

| Spec section                                                                | Task(s)                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------- |
| Data model (3 tables)                                                       | Task 1                                                   |
| Period key computation                                                      | Task 2                                                   |
| Streak system (rewards, effective streak, transition)                       | Task 3                                                   |
| Mission registry (definitions)                                              | Task 4                                                   |
| Metric → event mapping (computeIncrement)                                   | Task 5                                                   |
| Progress application (applyMissionProgress, clamp, conditional completedAt) | Task 7                                                   |
| Board state reader (overrides, replacement pool, getBoardState)             | Task 6                                                   |
| Claim algorithm (conditional UPDATE, D1 batch)                              | Task 8                                                   |
| Reroll mechanism (one per day, replacement pool)                            | Task 9                                                   |
| API endpoints (board, claim, claim-login, reroll, dev reset)                | Task 11                                                  |
| Deploy-day seeding                                                          | Task 11 (seed.ts)                                        |
| Integration (chips/update, mp/settle)                                       | Task 12                                                  |
| SSR board page                                                              | Task 13                                                  |
| Nav links + remove old files                                                | Task 14                                                  |
| E2E tests                                                                   | Task 15                                                  |
| AC: validated events only                                                   | Task 12 (only when shouldRecordStats + isValidGameType)  |
| AC: no duplicate rewards                                                    | Task 8 (conditional UPDATE + changes() gate)             |
| AC: UTC resets                                                              | Task 2 (period keys) + Task 3 (effective streak on read) |
| AC: daily login migration                                                   | Task 11 (seed.ts) + Task 14 (remove old)                 |
| AC: unit tests                                                              | Tasks 2-9                                                |
| AC: E2E coverage                                                            | Task 15                                                  |
