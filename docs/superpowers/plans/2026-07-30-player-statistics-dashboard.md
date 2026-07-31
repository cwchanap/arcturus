# Player Statistics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated all-time casual-play statistics summary to `/profile` and a responsive `/profile/statistics` dashboard covering every canonical game, with deterministic Wins Rank, resilient client loading, and focused automated coverage.

**Architecture:** Existing `game_stats` rows remain the only data source. Shared pure metric and aggregation helpers feed the existing achievement path and the new canonical zero-filled dashboard builder. The profile summary is server-rendered; the detailed page renders a protected shell and fetches an authenticated private JSON contract, with repository SQL, payload validation, DOM rendering, and fetch/retry orchestration kept separate.

**Tech Stack:** Astro 5 SSR on Cloudflare Workers, TypeScript, Drizzle ORM + Cloudflare D1, raw Drizzle `sql`, `bun:test`, `bun:sqlite`, happy-dom, Playwright. Design spec: `docs/superpowers/specs/2026-07-30-player-statistics-dashboard-design.md`.

## Global Constraints

- **Trust domain:** Read only casual all-time `game_stats`. Do not read or merge `ranked_game_stats`, ranked sessions, local storage, chip receipts, or HPA-174 history.
- **Canonical games:** Every response and detailed view contains exactly one entry for each `GAME_TYPES` value in canonical order.
- **Win rate:** `wins / (wins + losses) * 100`; pushes remain in `handsPlayed` and are excluded from the denominator.
- **Overall win rate:** Sum wins and losses first; never average per-game percentages.
- **Most-played tie-break:** Highest `handsPlayed`, then first entry in canonical `GAME_TYPES` order; return `null` when all games have zero hands.
- **Rank metric:** Wins Rank only. Dashboard subjects require `handsPlayed > 0`; the higher-ranked comparison population remains identical to the current wins leaderboard, including any defensive legacy/manual zero-hand rows.
- **Zero-hand rows:** No current production writer creates them. Support is defensive and must not dominate implementation complexity.
- **Rank query:** One correlated-count SQL statement. Keep existing single-game `getUserGameRank` unchanged.
- **Database:** No schema migration and no new production index.
- **Authentication:** `/profile`, `/profile/statistics`, and `/api/profile/statistics` are authenticated-account surfaces. The API never accepts a user ID.
- **Caching:** Authenticated HTML and all API responses use `Cache-Control: private, no-store`.
- **API validation:** The browser validates shape, safe numeric ranges, canonical game membership/order, and rank eligibility. It does not reimplement aggregate formulas or most-played selection.
- **No JavaScript:** `/profile/statistics` includes a `<noscript>` explanation; a permanent skeleton is not acceptable.
- **Formatting:** Profit strings are exactly `+1,200 chips`, `−400 chips`, or `0 chips`. Percentages use one decimal, equivalent to `toFixed(1)`.
- **Accessibility:** Loading uses `aria-busy`; retry and state transitions manage focus; colour never carries profit meaning alone.
- **Testing:** The exact rank SQL must execute against migrated in-memory SQLite. Mock-only tests are insufficient for SQL semantics.
- **E2E scope:** Cover five high-value flows only; keep calculations, exhaustive validation, and formatter edges in unit/integration tests.
- **Runtime:** Cloudflare Workers; use `Astro.locals.runtime.env`, never `process.env` in runtime application code.
- **Tooling:** Use `bun`; tabs, single quotes, semicolons; lint with zero warnings.
- **Scope fence:** Do not implement session history, trends, streaks, drill-down, ranked/casual tabs, or leaderboard eligibility cleanup.

---

## File Structure

| File                                                      | Responsibility                                                                               |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `src/lib/game-stats/aggregation.ts`                       | Shared `calculateWinRate` and `aggregateGameStats` pure helpers                              |
| `src/lib/game-stats/aggregation.test.ts`                  | Metric and aggregate helper coverage, including compatibility cases                          |
| `src/lib/game-stats/game-stats.ts`                        | Delegate `calculateMetrics` to the shared win-rate helper                                    |
| `src/lib/game-stats/game-stats-repository.ts`             | Delegate existing aggregate reduction; add correlated bulk Wins Rank SQL                     |
| `src/lib/game-stats/game-stats-repository.test.ts`        | Repository wrapper/mapping/error tests using existing mock style                             |
| `src/lib/game-stats/game-stats-repository.sqlite.test.ts` | Execute exact rank SQL against migrated `bun:sqlite`                                         |
| `src/lib/game-stats/player-statistics-types.ts`           | Public summary, game-card, dashboard, and source-row contracts                               |
| `src/lib/game-stats/player-statistics.ts`                 | Canonical filtering, duplicate detection, zero-fill, summary building, service orchestration |
| `src/lib/game-stats/player-statistics.test.ts`            | Canonical builder, tie-break, rank, unknown-row, duplicate-row tests                         |
| `src/lib/profile-statistics-loader.ts`                    | Isolated profile-summary loading state and error capture                                     |
| `src/lib/profile-statistics-loader.test.ts`               | Success/failure state tests with injected loader                                             |
| `src/lib/formatting.ts`                                   | Shared count, percentage, and signed-chip formatting                                         |
| `src/lib/formatting.test.ts`                              | Exact formatting contracts                                                                   |
| `src/lib/profile-statistics-payload.ts`                   | Runtime validation for detailed API payloads                                                 |
| `src/lib/profile-statistics-payload.test.ts`              | Shape/domain payload rejection tests                                                         |
| `src/lib/profile-statistics-renderer.ts`                  | DOM rendering for summary and canonical game cards                                           |
| `src/lib/profile-statistics-renderer.test.ts`             | happy-dom rendering and accessible-state tests                                               |
| `src/lib/profile-statistics-client.ts`                    | Fetch, redirect, loading/error/retry, and focus orchestration                                |
| `src/lib/profile-statistics-client.test.ts`               | happy-dom client state-machine tests with stubbed fetch                                      |
| `src/components/profile/PlayerStatisticsSummary.astro`    | Compact server-rendered profile section                                                      |
| `src/pages/profile.astro`                                 | Load and insert summary; set no-store header                                                 |
| `src/pages/profile/statistics.astro`                      | Protected detailed shell, skeleton, noscript fallback, client bootstrap                      |
| `src/pages/api/profile/statistics.ts`                     | Authenticated JSON endpoint with required headers                                            |
| `src/pages/api/profile/statistics.test.ts`                | API status/body/header tests through an injectable handler factory                           |
| `e2e/profile.spec.ts`                                     | Profile placement and detailed-page navigation                                               |
| `e2e/profile-statistics.spec.ts`                          | Populated, empty, retry, and mobile/keyboard flows via API interception                      |

---

### Task 1: Extract Shared Metric and Aggregate Helpers

**Files:**

- Create: `src/lib/game-stats/aggregation.ts`
- Create: `src/lib/game-stats/aggregation.test.ts`
- Modify: `src/lib/game-stats/game-stats.ts:32-43`
- Modify: `src/lib/game-stats/game-stats-repository.ts:318-349`
- Modify: `src/lib/game-stats/game-stats.test.ts`
- Modify: `src/lib/game-stats/game-stats-repository.test.ts`

**Interfaces:**

- Produces: `calculateWinRate(totalWins, totalLosses): number`.
- Produces: `aggregateGameStats(stats): GameStatsAggregate`.
- Preserves: `calculateMetrics(stats): GameStatsWithMetrics`.
- Preserves: `getAggregateUserStats(db, userId)` return shape used by achievements.

- [ ] **Step 1: Write failing helper tests in `aggregation.test.ts`**

```typescript
import { describe, expect, test } from 'bun:test';
import { aggregateGameStats, calculateWinRate } from './aggregation';

describe('calculateWinRate', () => {
	test('uses decided hands and excludes pushes', () => {
		expect(calculateWinRate(6, 2)).toBe(75);
	});

	test('returns zero when there are no decided hands', () => {
		expect(calculateWinRate(0, 0)).toBe(0);
	});
});

describe('aggregateGameStats', () => {
	test('sums totals and takes the maximum biggest win', () => {
		expect(
			aggregateGameStats([
				{ totalWins: 3, totalLosses: 2, handsPlayed: 7, biggestWin: 80, netProfit: 20 },
				{ totalWins: 5, totalLosses: 4, handsPlayed: 10, biggestWin: 150, netProfit: -30 },
			]),
		).toEqual({
			totalWins: 8,
			totalLosses: 6,
			totalHandsPlayed: 17,
			biggestWin: 150,
			totalNetProfit: -10,
		});
	});
});
```

- [ ] **Step 2: Run the new tests and verify they fail**

```bash
bun test src/lib/game-stats/aggregation.test.ts
```

Expected: FAIL because `./aggregation` does not exist.

- [ ] **Step 3: Implement `aggregation.ts`**

```typescript
import type { GameStats } from './types';

export type AggregatableGameStats = Pick<
	GameStats,
	'totalWins' | 'totalLosses' | 'handsPlayed' | 'biggestWin' | 'netProfit'
>;

export interface GameStatsAggregate {
	totalWins: number;
	totalLosses: number;
	totalHandsPlayed: number;
	biggestWin: number;
	totalNetProfit: number;
}

export function calculateWinRate(totalWins: number, totalLosses: number): number {
	const decidedHands = totalWins + totalLosses;
	return decidedHands > 0 ? (totalWins / decidedHands) * 100 : 0;
}

export function aggregateGameStats(stats: readonly AggregatableGameStats[]): GameStatsAggregate {
	return stats.reduce<GameStatsAggregate>(
		(aggregate, row) => ({
			totalWins: aggregate.totalWins + row.totalWins,
			totalLosses: aggregate.totalLosses + row.totalLosses,
			totalHandsPlayed: aggregate.totalHandsPlayed + row.handsPlayed,
			biggestWin: Math.max(aggregate.biggestWin, row.biggestWin),
			totalNetProfit: aggregate.totalNetProfit + row.netProfit,
		}),
		{
			totalWins: 0,
			totalLosses: 0,
			totalHandsPlayed: 0,
			biggestWin: 0,
			totalNetProfit: 0,
		},
	);
}
```

- [ ] **Step 4: Refactor existing callers without changing contracts**

In `game-stats.ts`, import `calculateWinRate` and replace the local formula:

```typescript
export function calculateMetrics(stats: GameStats): GameStatsWithMetrics {
	return {
		...stats,
		winRate: calculateWinRate(stats.totalWins, stats.totalLosses),
	};
}
```

In `game-stats-repository.ts`, import `aggregateGameStats` and delegate the existing export:

```typescript
export async function getAggregateUserStats(
	db: Database,
	userId: string,
): Promise<ReturnType<typeof aggregateGameStats>> {
	const allStats = await getAllUserGameStats(db, userId);
	return aggregateGameStats(allStats);
}
```

Keep `getAggregateUserStats` because achievement evaluation uses it.

- [ ] **Step 5: Add compatibility assertions**

Keep current `calculateMetrics` cases and add one assertion that pushes remain excluded. Retain the aggregate shape test and verify `biggestWin` remains the maximum rather than a sum.

- [ ] **Step 6: Run focused tests**

```bash
bun test \
	src/lib/game-stats/aggregation.test.ts \
	src/lib/game-stats/game-stats.test.ts \
	src/lib/game-stats/game-stats-repository.test.ts \
	src/lib/achievements/achievements.test.ts
```

Expected: PASS, including achievement-context aggregate tests.

- [ ] **Step 7: Commit**

```bash
git add \
	src/lib/game-stats/aggregation.ts \
	src/lib/game-stats/aggregation.test.ts \
	src/lib/game-stats/game-stats.ts \
	src/lib/game-stats/game-stats.test.ts \
	src/lib/game-stats/game-stats-repository.ts \
	src/lib/game-stats/game-stats-repository.test.ts
git commit -m "refactor: share game statistics calculations (HPA-171)"
```

---

### Task 2: Build the Canonical Dashboard Read Model

**Files:**

- Create: `src/lib/game-stats/player-statistics-types.ts`
- Create: `src/lib/game-stats/player-statistics.ts`
- Create: `src/lib/game-stats/player-statistics.test.ts`

**Interfaces:**

- Consumes: `calculateWinRate`, `aggregateGameStats`, `GAME_TYPES`, `isValidGameType`.
- Produces: `PlayerStatisticsSummary`, `PlayerGameStatistics`, `PlayerStatisticsDashboard`.
- Produces: `PlayerStatisticsIntegrityError`.
- Produces: `buildPlayerStatisticsDashboard(rows, winsRanks)`.

- [ ] **Step 1: Define dashboard contracts**

```typescript
import type { GameStats, GameType } from './types';

export interface PlayerStatisticsSourceRow extends Omit<GameStats, 'gameType'> {
	gameType: string;
}

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
}

export interface PlayerStatisticsDashboard {
	summary: PlayerStatisticsSummary;
	games: PlayerGameStatistics[];
}
```

Do not add `hasActivity`; renderers derive it from `handsPlayed > 0`.

- [ ] **Step 2: Write failing canonical-builder tests**

Cover zero-fill/order, weighted win rate, canonical most-played tie-break, pushes, unknown rows, duplicate rows, missing ranks, zero-hand ranks, and active zero-win numeric ranks.

```typescript
import { describe, expect, test } from 'bun:test';
import { GAME_TYPES } from './constants';
import {
	PlayerStatisticsIntegrityError,
	buildPlayerStatisticsDashboard,
} from './player-statistics';

const updatedAt = new Date('2026-07-30T00:00:00Z');

test('zero-fills every canonical game in canonical order', () => {
	const dashboard = buildPlayerStatisticsDashboard([], new Map());
	expect(dashboard.games.map((game) => game.gameType)).toEqual([...GAME_TYPES]);
	expect(dashboard.games.every((game) => game.handsPlayed === 0)).toBe(true);
	expect(dashboard.summary.mostPlayedGame).toBeNull();
});

test('uses weighted overall win rate and canonical tie-break', () => {
	const dashboard = buildPlayerStatisticsDashboard([
		{
			userId: 'user-1',
			gameType: 'baccarat',
			totalWins: 1,
			totalLosses: 9,
			handsPlayed: 10,
			biggestWin: 25,
			netProfit: -10,
			updatedAt,
		},
		{
			userId: 'user-1',
			gameType: 'blackjack',
			totalWins: 9,
			totalLosses: 1,
			handsPlayed: 10,
			biggestWin: 100,
			netProfit: 40,
			updatedAt,
		},
	]);

	expect(dashboard.summary.overallWinRate).toBe(50);
	expect(dashboard.summary.mostPlayedGame).toBe('blackjack');
});

test('throws on duplicate canonical rows', () => {
	const row = {
		userId: 'user-1',
		gameType: 'blackjack',
		totalWins: 1,
		totalLosses: 0,
		handsPlayed: 1,
		biggestWin: 10,
		netProfit: 10,
		updatedAt,
	};
	expect(() => buildPlayerStatisticsDashboard([row, row])).toThrow(PlayerStatisticsIntegrityError);
});
```

- [ ] **Step 3: Run and verify failure**

```bash
bun test src/lib/game-stats/player-statistics.test.ts
```

Expected: FAIL because the new module does not exist.

- [ ] **Step 4: Implement the canonical builder**

```typescript
import { aggregateGameStats, calculateWinRate } from './aggregation';
import { GAME_TYPES, isValidGameType } from './constants';
import type { GameType } from './types';
import type {
	PlayerGameStatistics,
	PlayerStatisticsDashboard,
	PlayerStatisticsSourceRow,
	PlayerStatisticsSummary,
} from './player-statistics-types';

export class PlayerStatisticsIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'PlayerStatisticsIntegrityError';
	}
}

const EMPTY_TOTALS = {
	totalWins: 0,
	totalLosses: 0,
	handsPlayed: 0,
	biggestWin: 0,
	netProfit: 0,
} as const;

function buildSummary(games: readonly PlayerGameStatistics[]): PlayerStatisticsSummary {
	const aggregate = aggregateGameStats(games);
	const mostPlayedGame = games.reduce<GameType | null>((current, game) => {
		if (game.handsPlayed === 0) return current;
		if (current === null) return game.gameType;
		const currentHands = games.find((entry) => entry.gameType === current)?.handsPlayed ?? 0;
		return game.handsPlayed > currentHands ? game.gameType : current;
	}, null);

	return {
		totalHands: aggregate.totalHandsPlayed,
		totalWins: aggregate.totalWins,
		totalLosses: aggregate.totalLosses,
		overallWinRate: calculateWinRate(aggregate.totalWins, aggregate.totalLosses),
		totalNetProfit: aggregate.totalNetProfit,
		mostPlayedGame,
	};
}

export function buildPlayerStatisticsDashboard(
	rows: readonly PlayerStatisticsSourceRow[],
	winsRanks: ReadonlyMap<GameType, number> = new Map(),
): PlayerStatisticsDashboard {
	const byGame = new Map<GameType, PlayerStatisticsSourceRow>();
	for (const row of rows) {
		if (!isValidGameType(row.gameType)) {
			console.warn('[PLAYER_STATISTICS] Ignoring unsupported game type');
			continue;
		}
		if (byGame.has(row.gameType)) {
			throw new PlayerStatisticsIntegrityError(`Duplicate statistics row for ${row.gameType}`);
		}
		byGame.set(row.gameType, row);
	}

	const games = GAME_TYPES.map<PlayerGameStatistics>((gameType) => {
		const row = byGame.get(gameType) ?? EMPTY_TOTALS;
		return {
			gameType,
			totalWins: row.totalWins,
			totalLosses: row.totalLosses,
			handsPlayed: row.handsPlayed,
			winRate: calculateWinRate(row.totalWins, row.totalLosses),
			netProfit: row.netProfit,
			biggestWin: row.biggestWin,
			winsRank: row.handsPlayed > 0 ? (winsRanks.get(gameType) ?? null) : null,
		};
	});

	return { summary: buildSummary(games), games };
}
```

The strict-greater comparison preserves canonical tie-breaking because `games` is already in `GAME_TYPES` order.

- [ ] **Step 5: Run focused tests and commit**

```bash
bun test src/lib/game-stats/aggregation.test.ts src/lib/game-stats/player-statistics.test.ts
git add src/lib/game-stats/player-statistics-types.ts src/lib/game-stats/player-statistics.ts src/lib/game-stats/player-statistics.test.ts
git commit -m "feat: add canonical player statistics read model (HPA-171)"
```

---

### Task 3: Add the Correlated Wins Rank Query with Real SQLite Coverage

**Files:**

- Modify: `src/lib/game-stats/game-stats-repository.ts`
- Modify: `src/lib/game-stats/game-stats-repository.test.ts`
- Create: `src/lib/game-stats/game-stats-repository.sqlite.test.ts`

**Interfaces:**

- Produces: `getBulkUserWinsRanks(db, userId): Promise<Map<GameType, number>>`.
- Preserves: existing `getUserGameRank` behavior for leaderboard callers.

- [ ] **Step 1: Add failing wrapper tests**

Add an `all` stub to the existing repository mock and cover valid row mapping, unknown game types, invalid rank values, and execution errors.

```typescript
const db = {
	all: async () => [
		{ gameType: 'blackjack', winsRank: 2 },
		{ gameType: 'future-game', winsRank: 1 },
	],
} as unknown as Database;

expect(await getBulkUserWinsRanks(db, 'user-1')).toEqual(new Map([['blackjack', 2]]));
```

- [ ] **Step 2: Create a real-SQLite test harness**

```typescript
import { Database as SQLiteDatabase } from 'bun:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import type { Database } from '../db';

function applyCheckedInMigrations(sqlite: SQLiteDatabase): void {
	const migrationDir = join(process.cwd(), 'drizzle');
	const files = readdirSync(migrationDir)
		.filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
		.sort();
	for (const file of files) {
		const source = readFileSync(join(migrationDir, file), 'utf8');
		for (const statement of source.split('--> statement-breakpoint')) {
			const sql = statement.trim();
			if (sql.length > 0) sqlite.run(sql);
		}
	}
}
```

Create a fresh `SQLiteDatabase(':memory:')` per test, apply migrations, seed `user` and `game_stats`, and instantiate:

```typescript
const db = drizzle(sqlite) as unknown as Database;
```

Seed cases proving higher wins, equal-win user-ID tie-break, independent games, active zero wins, excluded zero-hand subjects, zero-hand competitors counted for leaderboard parity, and missing rows.

- [ ] **Step 3: Run and verify failure**

```bash
bun test src/lib/game-stats/game-stats-repository.test.ts src/lib/game-stats/game-stats-repository.sqlite.test.ts
```

Expected: FAIL because `getBulkUserWinsRanks` is not exported.

- [ ] **Step 4: Implement the exact correlated query**

```typescript
interface RawWinsRankRow {
	gameType: string;
	winsRank: number;
}

export async function getBulkUserWinsRanks(
	db: Database,
	userId: string,
): Promise<Map<GameType, number>> {
	const rows = await db.all<RawWinsRankRow>(sql`
		SELECT
			subject.gameType AS gameType,
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
		WHERE subject.userId = ${userId}
			AND subject.handsPlayed > 0
	`);

	const ranks = new Map<GameType, number>();
	for (const row of rows) {
		if (!isValidGameType(row.gameType)) {
			console.warn('[GAME_STATS] Ignoring rank for unsupported game type');
			continue;
		}
		if (!Number.isSafeInteger(row.winsRank) || row.winsRank < 1) {
			throw new Error('Invalid wins rank returned by database');
		}
		ranks.set(row.gameType, row.winsRank);
	}
	return ranks;
}
```

Do not add `higher.handsPlayed > 0` and do not refactor `getUserGameRank`.

- [ ] **Step 5: Run and commit**

```bash
bun test src/lib/game-stats/game-stats-repository.test.ts src/lib/game-stats/game-stats-repository.sqlite.test.ts
git add src/lib/game-stats/game-stats-repository.ts src/lib/game-stats/game-stats-repository.test.ts src/lib/game-stats/game-stats-repository.sqlite.test.ts
git commit -m "feat: add bulk player wins ranks (HPA-171)"
```

---

### Task 4: Add Statistics Services and Isolated Profile Loading

**Files:**

- Modify: `src/lib/game-stats/player-statistics.ts`
- Modify: `src/lib/game-stats/player-statistics.test.ts`
- Create: `src/lib/profile-statistics-loader.ts`
- Create: `src/lib/profile-statistics-loader.test.ts`

**Interfaces:**

- Produces: `getPlayerStatisticsSummary(db, userId)`.
- Produces: `getPlayerStatisticsDashboard(db, userId)`.
- Produces: `loadProfileStatisticsState(db, userId, load?)`.

- [ ] **Step 1: Write failing service orchestration tests**

Use a service factory with injected `getAllUserGameStats` and `getBulkUserWinsRanks`. Verify summary performs only the row read, dashboard starts both reads through `Promise.all`, both paths use the same builder, and errors propagate.

- [ ] **Step 2: Implement the service factory**

```typescript
export interface PlayerStatisticsDependencies {
	getAllUserGameStats: typeof getAllUserGameStats;
	getBulkUserWinsRanks: typeof getBulkUserWinsRanks;
}

export function createPlayerStatisticsService(
	overrides: Partial<PlayerStatisticsDependencies> = {},
) {
	const dependencies: PlayerStatisticsDependencies = {
		getAllUserGameStats,
		getBulkUserWinsRanks,
		...overrides,
	};
	return {
		async getPlayerStatisticsSummary(db: Database, userId: string) {
			const rows = await dependencies.getAllUserGameStats(db, userId);
			return buildPlayerStatisticsDashboard(rows).summary;
		},
		async getPlayerStatisticsDashboard(db: Database, userId: string) {
			const [rows, ranks] = await Promise.all([
				dependencies.getAllUserGameStats(db, userId),
				dependencies.getBulkUserWinsRanks(db, userId),
			]);
			return buildPlayerStatisticsDashboard(rows, ranks);
		},
	};
}

const defaultService = createPlayerStatisticsService();
export const { getPlayerStatisticsSummary, getPlayerStatisticsDashboard } = defaultService;
```

- [ ] **Step 3: Write and implement the isolated profile loader**

```typescript
import type { Database } from './db';
import { getPlayerStatisticsSummary } from './game-stats/player-statistics';
import type { PlayerStatisticsSummary } from './game-stats/player-statistics-types';

export type ProfileStatisticsState =
	| { status: 'ready'; summary: PlayerStatisticsSummary }
	| { status: 'error' };

export async function loadProfileStatisticsState(
	db: Database,
	userId: string,
	load: typeof getPlayerStatisticsSummary = getPlayerStatisticsSummary,
): Promise<ProfileStatisticsState> {
	try {
		return { status: 'ready', summary: await load(db, userId) };
	} catch (error) {
		console.error('[PLAYER_STATISTICS] Failed to load profile summary', error);
		return { status: 'error' };
	}
}
```

Test injected success and rejection, and verify the rejection returns `{ status: 'error' }` without throwing.

- [ ] **Step 4: Run and commit**

```bash
bun test src/lib/game-stats/player-statistics.test.ts src/lib/profile-statistics-loader.test.ts
git add src/lib/game-stats/player-statistics.ts src/lib/game-stats/player-statistics.test.ts src/lib/profile-statistics-loader.ts src/lib/profile-statistics-loader.test.ts
git commit -m "feat: add player statistics services (HPA-171)"
```

---

### Task 5: Extend Shared Formatting Utilities

**Files:**

- Modify: `src/lib/formatting.ts`
- Modify: `src/lib/formatting.test.ts`

**Interfaces:**

- Produces: `formatWholeNumber`, `formatPercentage`, `formatSignedChipResult`.
- Preserves existing chip-balance formatter behavior.

- [ ] **Step 1: Write failing exact-output tests**

```typescript
expect(formatSignedChipResult(1200)).toBe('+1,200 chips');
expect(formatSignedChipResult(-400)).toBe('−400 chips');
expect(formatSignedChipResult(0)).toBe('0 chips');
expect(formatWholeNumber(12345)).toBe('12,345');
expect(formatPercentage(50.83333333333333)).toBe('50.8%');
expect(() => formatPercentage(Number.NaN)).toThrow(RangeError);
```

- [ ] **Step 2: Implement the helpers**

```typescript
function requireFinite(value: number): number {
	if (!Number.isFinite(value)) throw new RangeError('Value must be finite');
	return value;
}

export function formatWholeNumber(value: number): string {
	return new Intl.NumberFormat('en-US').format(requireFinite(value));
}

export function formatPercentage(value: number): string {
	return `${requireFinite(value).toFixed(1)}%`;
}

export function formatSignedChipResult(value: number): string {
	const finite = requireFinite(value);
	if (finite === 0) return '0 chips';
	const sign = finite > 0 ? '+' : '−';
	return `${sign}${formatChipBalance(Math.abs(finite))} chips`;
}
```

Do not change ranked Blackjack's private formatter.

- [ ] **Step 3: Run and commit**

```bash
bun test src/lib/formatting.test.ts
git add src/lib/formatting.ts src/lib/formatting.test.ts
git commit -m "feat: add player statistics formatters (HPA-171)"
```

---

### Task 6: Add the Authenticated API and Runtime Payload Validator

**Files:**

- Create: `src/pages/api/profile/statistics.ts`
- Create: `src/pages/api/profile/statistics.test.ts`
- Create: `src/lib/profile-statistics-payload.ts`
- Create: `src/lib/profile-statistics-payload.test.ts`

**Interfaces:**

- Produces: `GET /api/profile/statistics` returning `{ summary, games }`.
- Produces: `createStatisticsGetHandler(overrides?)`.
- Produces: `parsePlayerStatisticsDashboard(value)`.

- [ ] **Step 1: Write payload-validator tests**

Build a canonical seven-game payload. Test acceptance plus rejection of reordered/missing/duplicate/unknown games, negative or fractional counts, unsafe integers, percentages outside `[0, 100]`, non-positive ranks, and ranks on zero-hand games. Do not recompute aggregates or most-played selection in this layer.

- [ ] **Step 2: Implement the Zod validator**

```typescript
import { z } from 'zod';
import { GAME_TYPES } from './game-stats/constants';
import type { PlayerStatisticsDashboard } from './game-stats/player-statistics-types';

const safeInteger = z.number().refine(Number.isSafeInteger, 'Expected a safe integer');
const nonNegativeSafeInteger = safeInteger.refine((value) => value >= 0, 'Expected >= 0');
const percentage = z.number().finite().min(0).max(100);
const gameType = z.enum(GAME_TYPES);

const summarySchema = z
	.object({
		totalHands: nonNegativeSafeInteger,
		totalWins: nonNegativeSafeInteger,
		totalLosses: nonNegativeSafeInteger,
		overallWinRate: percentage,
		totalNetProfit: safeInteger,
		mostPlayedGame: gameType.nullable(),
	})
	.strict();

const gameSchema = z
	.object({
		gameType,
		totalWins: nonNegativeSafeInteger,
		totalLosses: nonNegativeSafeInteger,
		handsPlayed: nonNegativeSafeInteger,
		winRate: percentage,
		netProfit: safeInteger,
		biggestWin: nonNegativeSafeInteger,
		winsRank: safeInteger.refine((value) => value > 0).nullable(),
	})
	.strict();

const dashboardSchema = z
	.object({ summary: summarySchema, games: z.array(gameSchema) })
	.strict()
	.superRefine((dashboard, context) => {
		if (dashboard.games.length !== GAME_TYPES.length) {
			context.addIssue({ code: 'custom', message: 'Expected every canonical game' });
			return;
		}
		for (const [index, expected] of GAME_TYPES.entries()) {
			const game = dashboard.games[index];
			if (game?.gameType !== expected) {
				context.addIssue({ code: 'custom', message: 'Games must use canonical order' });
			}
			if (game?.handsPlayed === 0 && game.winsRank !== null) {
				context.addIssue({ code: 'custom', message: 'Zero-hand games must be unranked' });
			}
		}
	});

export function parsePlayerStatisticsDashboard(value: unknown): PlayerStatisticsDashboard {
	return dashboardSchema.parse(value) as PlayerStatisticsDashboard;
}
```

- [ ] **Step 3: Write API handler tests**

Use an injectable factory. Cover success, `401`, missing DB `500`, thrown service `500`, JSON content type, `private, no-store`, and absence of any user-selectable request input.

- [ ] **Step 4: Implement the route**

```typescript
function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set('content-type', 'application/json');
	headers.set('cache-control', 'private, no-store');
	return new Response(JSON.stringify(body), { ...init, headers });
}

export function createStatisticsGetHandler(
	overrides: Partial<StatisticsRouteDependencies> = {},
): APIRoute {
	const dependencies = { createDb, getPlayerStatisticsDashboard, ...overrides };
	return async ({ locals }) => {
		if (!locals.session) return jsonResponse({ error: 'Unauthorized' }, { status: 401 });
		const binding = locals.runtime?.env?.DB ?? null;
		if (!binding) {
			return jsonResponse({ error: 'Unable to load player statistics' }, { status: 500 });
		}
		try {
			const dashboard = await dependencies.getPlayerStatisticsDashboard(
				dependencies.createDb(binding),
				locals.session.user.id,
			);
			return jsonResponse(dashboard);
		} catch (error) {
			console.error('[PLAYER_STATISTICS] API load failed', error);
			return jsonResponse({ error: 'Unable to load player statistics' }, { status: 500 });
		}
	};
}

export const GET = createStatisticsGetHandler();
```

- [ ] **Step 5: Run and commit**

```bash
bun test src/lib/profile-statistics-payload.test.ts src/pages/api/profile/statistics.test.ts
git add src/lib/profile-statistics-payload.ts src/lib/profile-statistics-payload.test.ts src/pages/api/profile/statistics.ts src/pages/api/profile/statistics.test.ts
git commit -m "feat: add player statistics API contract (HPA-171)"
```

---

### Task 7: Add the Server-Rendered Profile Summary

**Files:**

- Create: `src/components/profile/PlayerStatisticsSummary.astro`
- Modify: `src/pages/profile.astro:1-72,137-191`
- Modify: `e2e/profile.spec.ts`

**Interfaces:**

- Consumes: `ProfileStatisticsState`, shared formatting, game labels.
- Produces: compact `Player Performance` section after Account Details/Casino Tips and before AI Rival Settings.

- [ ] **Step 1: Create the summary component**

```astro
---
import { GAME_TYPE_LABELS } from '../../lib/game-stats/constants';
import type { ProfileStatisticsState } from '../../lib/profile-statistics-loader';
import { formatPercentage, formatSignedChipResult, formatWholeNumber } from '../../lib/formatting';

interface Props {
	state: ProfileStatisticsState;
}
const { state } = Astro.props;
---

<section class="deco-panel mt-8 p-6" aria-labelledby="player-performance-heading">
	<div class="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
		<div>
			<p class="deco-eyebrow-sm">All-time casual play</p>
			<h2 id="player-performance-heading" class="deco-section-title text-lg">Player Performance</h2>
		</div>
		<a href="/profile/statistics" class="deco-link">View detailed statistics</a>
	</div>
	{
		state.status === 'error' ? (
			<p class="mt-6" role="status" style="color: var(--deco-rose)">
				Player statistics are temporarily unavailable.
			</p>
		) : (
			<dl class="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
				<div>
					<>
						<dt class="deco-eyebrow-sm">Total Hands</dt>
						<dd>{formatWholeNumber(state.summary.totalHands)}</dd>
					</>
				</div>
				<div>
					<>
						<dt class="deco-eyebrow-sm">Most Played</dt>
						<dd>
							{state.summary.mostPlayedGame
								? GAME_TYPE_LABELS[state.summary.mostPlayedGame]
								: 'No games played yet'}
						</dd>
					</>
				</div>
				<div>
					<>
						<dt class="deco-eyebrow-sm">Overall Win Rate</dt>
						<dd>{formatPercentage(state.summary.overallWinRate)}</dd>
					</>
				</div>
				<div>
					<>
						<dt class="deco-eyebrow-sm">Net Profit</dt>
						<dd>{formatSignedChipResult(state.summary.totalNetProfit)}</dd>
					</>
				</div>
			</dl>
		)
	}
</section>
```

Apply the existing `deco-stat-value`, spacing, and `tabular-nums` classes to the four `<dd>` values in the implementation.

- [ ] **Step 2: Wire the loader and no-store header**

Immediately after the existing unauthenticated redirect guard:

```typescript
Astro.response.headers.set('Cache-Control', 'private, no-store');
let playerStatisticsState: ProfileStatisticsState = { status: 'error' };
```

Inside the existing `if (dbBinding)` block, reuse the existing `db`:

```typescript
playerStatisticsState = await loadProfileStatisticsState(db, user.id);
```

Render `<PlayerStatisticsSummary state={playerStatisticsState} />` immediately after the Account Details/Casino Tips grid and before AI Rival Settings.

- [ ] **Step 3: Add the focused profile E2E case**

Assert the summary is visible, contains `All-time casual play`, links to `/profile/statistics`, and appears between `Casino Tips` and `AI Rival Settings` in `main h2` text order.

- [ ] **Step 4: Run and commit**

```bash
bun run lint
bun run build
bunx playwright test e2e/profile.spec.ts --grep "performance summary"
git add src/components/profile/PlayerStatisticsSummary.astro src/pages/profile.astro e2e/profile.spec.ts
git commit -m "feat: add profile performance summary (HPA-171)"
```

---

### Task 8: Build the Detailed Renderer and Client State Machine

**Files:**

- Create: `src/lib/profile-statistics-renderer.ts`
- Create: `src/lib/profile-statistics-renderer.test.ts`
- Create: `src/lib/profile-statistics-client.ts`
- Create: `src/lib/profile-statistics-client.test.ts`
- Create: `src/pages/profile/statistics.astro`

**Interfaces:**

- Produces: `renderPlayerStatisticsDashboard(root, dashboard)`.
- Produces: `initPlayerStatisticsClient(root, options?)`.

- [ ] **Step 1: Write happy-dom renderer tests**

Follow the Window setup pattern in `src/lib/ranked/blackjack/ui.test.ts`. Assert canonical card order, active numeric rank, zero-hand `Not played yet`/`Unranked`, signed profit text, and rank/play URLs.

- [ ] **Step 2: Implement the renderer with safe DOM APIs**

Use `document.createElement`, `textContent`, and `setAttribute`, never API-value interpolation into `innerHTML`. Render into:

```text
[data-statistics-summary]
[data-statistics-games]
[data-statistics-empty]
```

Each card uses `data-testid="statistics-card-<gameType>"` and renders icon, label, derived status, all approved metrics, Wins Rank, leaderboard link, and play link.

- [ ] **Step 3: Write client state-machine tests**

With happy-dom and injected `fetchImpl`/`redirect`, cover success, `401`, network/500/malformed payload, retry success focus, and retry failure focus.

- [ ] **Step 4: Implement the client**

```typescript
export interface ProfileStatisticsClientOptions {
	fetchImpl?: typeof fetch;
	redirect?: (href: string) => void;
}

export async function initPlayerStatisticsClient(
	root: HTMLElement,
	options: ProfileStatisticsClientOptions = {},
): Promise<void> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const redirect = options.redirect ?? ((href) => window.location.assign(href));
	const loading = root.querySelector<HTMLElement>('[data-statistics-loading]');
	const error = root.querySelector<HTMLElement>('[data-statistics-error]');
	const content = root.querySelector<HTMLElement>('[data-statistics-content]');
	const retry = root.querySelector<HTMLButtonElement>('[data-statistics-retry]');
	const heading = root.querySelector<HTMLElement>('[data-statistics-heading]');
	if (!loading || !error || !content || !retry || !heading) {
		throw new Error('Player statistics shell is incomplete');
	}

	const load = async (focusAfterRetry: boolean): Promise<void> => {
		loading.hidden = false;
		error.hidden = true;
		content.hidden = true;
		root.setAttribute('aria-busy', 'true');
		try {
			const response = await fetchImpl('/api/profile/statistics', {
				credentials: 'same-origin',
				cache: 'no-store',
			});
			if (response.status === 401) {
				redirect('/signin');
				return;
			}
			if (!response.ok) throw new Error('Statistics request failed');
			const dashboard = parsePlayerStatisticsDashboard(await response.json());
			renderPlayerStatisticsDashboard(root, dashboard);
			loading.hidden = true;
			content.hidden = false;
			root.setAttribute('aria-busy', 'false');
			if (focusAfterRetry) heading.focus();
		} catch (loadError) {
			console.error('[PLAYER_STATISTICS] Client load failed', loadError);
			loading.hidden = true;
			error.hidden = false;
			root.setAttribute('aria-busy', 'false');
			if (focusAfterRetry) error.focus();
		}
	};

	retry.addEventListener('click', () => void load(true));
	await load(false);
}
```

- [ ] **Step 5: Create the protected Astro shell**

Redirect unauthenticated users, set `private, no-store`, render a focusable heading, skeleton, error state, content containers, and:

```astro
<noscript>
	<style>
		[data-statistics-loading] {
			display: none !important;
		}
	</style>
	<p class="deco-panel mt-6 p-4">JavaScript is required to load detailed player statistics.</p>
</noscript>
```

Use `aria-busy="true"`, labelled skeleton cards for every canonical game, and reduced-motion handling. The page script calls `initPlayerStatisticsClient`.

- [ ] **Step 6: Run and commit**

```bash
bun test src/lib/profile-statistics-payload.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
bun run lint
bun run build
git add src/lib/profile-statistics-renderer.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.ts src/lib/profile-statistics-client.test.ts src/pages/profile/statistics.astro
git commit -m "feat: add detailed player statistics dashboard (HPA-171)"
```

---

### Task 9: Add Focused End-to-End Coverage and Run Full Verification

**Files:**

- Modify: `e2e/profile.spec.ts`
- Create: `e2e/profile-statistics.spec.ts`
- Modify: detail-page/renderer selectors only when required by the assertions below

**Interfaces:**

- Produces: five high-value browser flows without production-only failure hooks.

- [ ] **Step 1: Build a canonical intercepted API fixture**

Define the seven game types locally in canonical order. Build a fixture where Blackjack has 20 hands, `#3`, and `+800 chips`; Baccarat has 5 hands, `#18`, and `−200 chips`; every remaining game is zero-filled and unranked. The summary totals are 25 hands, 10 wins, 10 losses, 50%, and +600 chips.

- [ ] **Step 2: Test the populated dashboard**

Intercept `**/api/profile/statistics` before navigation, return the fixture, and assert canonical card order, representative values, one rank link, and one play link.

- [ ] **Step 3: Test the all-empty dashboard**

Return all seven zero-filled games. Assert the invitation remains alongside the complete grid and every card is `Not played yet`/`Unranked`.

- [ ] **Step 4: Test failure then retry**

Use a request counter: first intercepted API request returns 500, second returns the populated fixture. Assert error visibility, retry, successful render, and heading focus after retry.

- [ ] **Step 5: Add mobile/keyboard smoke coverage**

Use a `375x667` viewport, tab through representative navigation, and assert:

```typescript
expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
	true,
);
```

Do not assert pixel coordinates or exact column counts.

- [ ] **Step 6: Run focused and full verification**

```bash
bunx playwright test e2e/profile.spec.ts e2e/profile-statistics.spec.ts
bun run format:check
bun run lint
bun run test
bun run build
bun run test:e2e
```

Expected: all commands exit 0, with only existing intentional Playwright skips.

- [ ] **Step 7: Review scope and commit**

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Confirm no schema/migration, ranked-statistics, HPA-174, leaderboard-eligibility, or local-storage changes.

```bash
git add e2e/profile.spec.ts e2e/profile-statistics.spec.ts src/
git commit -m "test: cover player statistics dashboard flows (HPA-171)"
```

If the working tree is clean after verification, do not create an empty commit.

---

## Plan Completion Checklist

- [ ] Every design-spec requirement maps to a task above.
- [ ] Existing achievement aggregates still use `getAggregateUserStats` and preserve behavior.
- [ ] The dashboard builder filters unknown rows before aggregation and throws only on duplicate canonical rows.
- [ ] The client validates rendering safety without duplicating server formulas.
- [ ] The exact rank SQL is executed in migrated in-memory SQLite.
- [ ] Profile and detail HTML plus API responses are private and non-cacheable.
- [ ] Detailed page has loading, retry, focus, all-empty, and no-JavaScript states.
- [ ] Only five high-value Playwright flows are added.
- [ ] Full verification is run before implementation completion is claimed.
