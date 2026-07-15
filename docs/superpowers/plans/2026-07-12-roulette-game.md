# Roulette Game Implementation Plan

> **Implementation Deviation Note (2026-07-14):** `GameSettingsManager.ts` was
> planned (Task 5) but **dropped during implementation** — roulette has no
> user-configurable settings, so the module was unnecessary. All references to
> `GameSettingsManager` in this plan (file structure, Task 5, client
> integration) are stale and were not implemented. The `index.ts` re-export
> and `rouletteClient.ts` import were likewise omitted.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a playable European roulette game at `/games/roulette` with server-side atomic settlement, animated CSS/SVG wheel, and full chip/achievement integration.

**Architecture:** The spin endpoint (`POST /api/roulette/spin`) settles atomically — deducts wager, generates the winning number via `crypto.getRandomValues`, computes payouts using shared pure functions, credits balance, writes receipt + stats, all in one D1 batch before revealing the result. Client applies server-returned `newBalance` directly. No separate chip sync call. Guest mode bypasses the server entirely (local settlement).

**Tech Stack:** Astro SSR, Cloudflare Workers, D1 (Drizzle ORM), Bun test runner, Playwright E2E, Tailwind CSS v4

## Global Constraints

- **Runtime:** Cloudflare Workers — use `Astro.locals.runtime.env.DB`, never `process.env`
- **Package manager:** Bun (`bun run`, `bun test`)
- **Dev server port:** 2000 (`http://localhost:2000`)
- **Code style:** Tabs (width 2), single quotes, semicolons required, no `console.log` (warn/error OK)
- **No comments** unless explicitly requested
- **Testing:** Bun for unit tests (`*.test.ts`), Playwright for E2E (`e2e/*.spec.ts`)
- **Lint:** `bun run lint` must pass with 0 warnings
- **Migration:** `bun run db:generate` then `bun run db:migrate:local`

---

## File Structure

```
CREATE:
  src/lib/roulette/types.ts                  # BetType, RouletteBet, SpinResult, GameState, etc.
  src/lib/roulette/constants.ts              # Wheel data, payouts, limits, chip denominations
  src/lib/roulette/betEvaluator.ts           # Pure: doesBetWin, evaluateBets, columnIndexToMod3
  src/lib/roulette/betEvaluator.test.ts      # Comprehensive settlement tests
  src/lib/roulette/RouletteGame.ts           # State machine: betting, spin, settle
  src/lib/roulette/RouletteGame.test.ts      # State management + validation tests
  src/lib/roulette/RouletteUIRenderer.ts     # DOM manipulation: wheel, table, chips, results
  src/lib/roulette/rouletteClient.ts         # Client integration: events, server calls, persistence
  src/lib/roulette/GameSettingsManager.ts    # LocalStorage settings persistence
  src/lib/roulette/index.ts                  # Re-exports
  src/pages/api/roulette/spin.ts             # Server-side atomic settlement endpoint
  src/pages/games/roulette.astro             # Game page
  e2e/roulette.spec.ts                       # Playwright E2E tests

MODIFY:
  src/db/schema.ts                           # Add rouletteRound table, fix stale gameStats comment
  src/lib/game-stats/constants.ts            # Add 'roulette' to GAME_TYPES, LABELS, ICONS
  drizzle/0009_*.sql                         # Auto-generated migration for roulette_round
```

---

### Task 1: Types & Constants

**Files:**

- Create: `src/lib/roulette/types.ts`
- Create: `src/lib/roulette/constants.ts`

**Interfaces:**

- Produces: `BetType`, `RouletteBet`, `BetResult`, `SpinResult`, `GamePhase`, `RouletteGameState`, `RouletteSettings` (types.ts); `WHEEL_ORDER`, `RED_NUMBERS`, `BLACK_NUMBERS`, `PAYOUT_MULTIPLIERS`, `CHIP_DENOMINATIONS`, `MIN_BET`, `MAX_BET_PER_POSITION`, `MAX_TOTAL_BET`, `MAX_ROUND_HISTORY` (constants.ts)

- [ ] **Step 1: Create `types.ts`**

```typescript
export type BetType =
	| 'straight'
	| 'red'
	| 'black'
	| 'odd'
	| 'even'
	| 'low'
	| 'high'
	| 'dozen'
	| 'column';

export interface RouletteBet {
	id: string;
	type: BetType;
	amount: number;
	target?: number;
}

export interface BetResult {
	bet: RouletteBet;
	won: boolean;
	payout: number;
}

export interface SpinResult {
	winningNumber: number;
	bets: RouletteBet[];
	totalBet: number;
	totalPayout: number;
	netDelta: number;
	results: BetResult[];
	timestamp: number;
	syncId: string;
	newBalance?: number;
}

export type GamePhase = 'betting' | 'spinning' | 'settled';

export interface RouletteGameState {
	phase: GamePhase;
	activeBets: RouletteBet[];
	chipBalance: number;
	selectedChipAmount: number;
	lastSpin: SpinResult | null;
	roundHistory: SpinResult[];
	settings: RouletteSettings;
}

export interface RouletteSettings {
	animationSpeed: 'slow' | 'normal' | 'fast';
	soundEnabled: boolean;
}

export interface RouletteGameConfig {
	initialBalance: number;
	settings?: Partial<RouletteSettings>;
}
```

- [ ] **Step 2: Create `constants.ts`**

```typescript
import type { BetType, RouletteSettings } from './types';

export const WHEEL_ORDER = [
	0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36, 11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14,
	31, 9, 22, 18, 29, 7, 28, 12, 35, 3, 26,
] as const;

export const RED_NUMBERS = new Set([
	1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36,
]);

export const BLACK_NUMBERS = new Set([
	2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35,
]);

export const PAYOUT_MULTIPLIERS: Record<BetType, number> = {
	straight: 35,
	red: 1,
	black: 1,
	odd: 1,
	even: 1,
	low: 1,
	high: 1,
	dozen: 2,
	column: 2,
};

export const CHIP_DENOMINATIONS = [1, 5, 10, 25, 50, 100];

export const MIN_BET = 1;
export const MAX_BET_PER_POSITION = 500;
export const MAX_TOTAL_BET = 5000;
export const MAX_ROUND_HISTORY = 20;

export const DEFAULT_SETTINGS: RouletteSettings = {
	animationSpeed: 'normal',
	soundEnabled: true,
};
```

- [ ] **Step 3: Create `index.ts` (re-exports)**

```typescript
export * from './types';
export * from './constants';
export { doesBetWin, evaluateBets } from './betEvaluator';
export { RouletteGame } from './RouletteGame';
export { GameSettingsManager } from './GameSettingsManager';
```

- [ ] **Step 4: Verify type-checking**

Run: `bun x tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to roulette files (may show pre-existing errors in other files)

- [ ] **Step 5: Commit**

```bash
git add src/lib/roulette/types.ts src/lib/roulette/constants.ts src/lib/roulette/index.ts
git commit -m "feat(roulette): add types and constants"
```

---

### Task 2: Bet Evaluator (TDD)

**Files:**

- Create: `src/lib/roulette/betEvaluator.ts`
- Test: `src/lib/roulette/betEvaluator.test.ts`

**Interfaces:**

- Consumes: `RouletteBet`, `BetResult`, `BetType` from Task 1; `RED_NUMBERS`, `BLACK_NUMBERS`, `PAYOUT_MULTIPLIERS` from Task 1
- Produces: `doesBetWin(bet, winningNumber) => boolean`, `evaluateBets(bets, winningNumber) => BetResult[]`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/roulette/betEvaluator.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { doesBetWin, evaluateBets } from './betEvaluator';
import type { RouletteBet } from './types';

function makeBet(type: RouletteBet['type'], amount: number, target?: number): RouletteBet {
	return {
		id: 'test-' + type + '-' + (target ?? ''),
		type,
		amount,
		...(target !== undefined ? { target } : {}),
	};
}

describe('doesBetWin', () => {
	describe('straight-up bets', () => {
		for (let n = 0; n <= 36; n++) {
			it(`number ${n} wins on straight-${n}`, () => {
				expect(doesBetWin(makeBet('straight', 1, n), n)).toBe(true);
			});
			it(`number ${n} loses on straight-${(n + 1) % 37}`, () => {
				const other = (n + 1) % 37;
				if (other !== n) {
					expect(doesBetWin(makeBet('straight', 1, n), other)).toBe(false);
				}
			});
		}
	});

	describe('red/black', () => {
		it('red wins on a red number (1)', () => {
			expect(doesBetWin(makeBet('red', 1), 1)).toBe(true);
		});
		it('red loses on a black number (2)', () => {
			expect(doesBetWin(makeBet('red', 1), 2)).toBe(false);
		});
		it('red loses on 0', () => {
			expect(doesBetWin(makeBet('red', 1), 0)).toBe(false);
		});
		it('black wins on a black number (2)', () => {
			expect(doesBetWin(makeBet('black', 1), 2)).toBe(true);
		});
		it('black loses on 0', () => {
			expect(doesBetWin(makeBet('black', 1), 0)).toBe(false);
		});
	});

	describe('odd/even', () => {
		it('odd wins on 1', () => {
			expect(doesBetWin(makeBet('odd', 1), 1)).toBe(true);
		});
		it('odd wins on 35', () => {
			expect(doesBetWin(makeBet('odd', 1), 35)).toBe(true);
		});
		it('odd loses on 2', () => {
			expect(doesBetWin(makeBet('odd', 1), 2)).toBe(false);
		});
		it('odd loses on 0', () => {
			expect(doesBetWin(makeBet('odd', 1), 0)).toBe(false);
		});
		it('even wins on 2', () => {
			expect(doesBetWin(makeBet('even', 1), 2)).toBe(true);
		});
		it('even loses on 0', () => {
			expect(doesBetWin(makeBet('even', 1), 0)).toBe(false);
		});
	});

	describe('low/high', () => {
		it('low wins on 1', () => {
			expect(doesBetWin(makeBet('low', 1), 1)).toBe(true);
		});
		it('low wins on 18', () => {
			expect(doesBetWin(makeBet('low', 1), 18)).toBe(true);
		});
		it('low loses on 19', () => {
			expect(doesBetWin(makeBet('low', 1), 19)).toBe(false);
		});
		it('low loses on 0', () => {
			expect(doesBetWin(makeBet('low', 1), 0)).toBe(false);
		});
		it('high wins on 19', () => {
			expect(doesBetWin(makeBet('high', 1), 19)).toBe(true);
		});
		it('high wins on 36', () => {
			expect(doesBetWin(makeBet('high', 1), 36)).toBe(true);
		});
		it('high loses on 18', () => {
			expect(doesBetWin(makeBet('high', 1), 18)).toBe(false);
		});
		it('high loses on 0', () => {
			expect(doesBetWin(makeBet('high', 1), 0)).toBe(false);
		});
	});

	describe('dozen', () => {
		it('1st dozen (target=0) wins on 1', () => {
			expect(doesBetWin(makeBet('dozen', 1, 0), 1)).toBe(true);
		});
		it('1st dozen wins on 12', () => {
			expect(doesBetWin(makeBet('dozen', 1, 0), 12)).toBe(true);
		});
		it('1st dozen loses on 13', () => {
			expect(doesBetWin(makeBet('dozen', 1, 0), 13)).toBe(false);
		});
		it('2nd dozen (target=1) wins on 13', () => {
			expect(doesBetWin(makeBet('dozen', 1, 1), 13)).toBe(true);
		});
		it('2nd dozen wins on 24', () => {
			expect(doesBetWin(makeBet('dozen', 1, 1), 24)).toBe(true);
		});
		it('2nd dozen loses on 25', () => {
			expect(doesBetWin(makeBet('dozen', 1, 1), 25)).toBe(false);
		});
		it('3rd dozen (target=2) wins on 25', () => {
			expect(doesBetWin(makeBet('dozen', 1, 2), 25)).toBe(true);
		});
		it('3rd dozen wins on 36', () => {
			expect(doesBetWin(makeBet('dozen', 1, 2), 36)).toBe(true);
		});
		it('all dozens lose on 0', () => {
			expect(doesBetWin(makeBet('dozen', 1, 0), 0)).toBe(false);
			expect(doesBetWin(makeBet('dozen', 1, 1), 0)).toBe(false);
			expect(doesBetWin(makeBet('dozen', 1, 2), 0)).toBe(false);
		});
	});

	describe('column', () => {
		it('column 0 wins on 3 (n%3===0)', () => {
			expect(doesBetWin(makeBet('column', 1, 0), 3)).toBe(true);
		});
		it('column 0 wins on 36', () => {
			expect(doesBetWin(makeBet('column', 1, 0), 36)).toBe(true);
		});
		it('column 1 wins on 2 (n%3===2)', () => {
			expect(doesBetWin(makeBet('column', 1, 1), 2)).toBe(true);
		});
		it('column 1 wins on 35', () => {
			expect(doesBetWin(makeBet('column', 1, 1), 35)).toBe(true);
		});
		it('column 2 wins on 1 (n%3===1)', () => {
			expect(doesBetWin(makeBet('column', 1, 2), 1)).toBe(true);
		});
		it('column 2 wins on 34', () => {
			expect(doesBetWin(makeBet('column', 1, 2), 34)).toBe(true);
		});
		it('all columns lose on 0', () => {
			expect(doesBetWin(makeBet('column', 1, 0), 0)).toBe(false);
			expect(doesBetWin(makeBet('column', 1, 1), 0)).toBe(false);
			expect(doesBetWin(makeBet('column', 1, 2), 0)).toBe(false);
		});
	});

	describe('zero handling', () => {
		it('straight-up 0 wins on 0', () => {
			expect(doesBetWin(makeBet('straight', 1, 0), 0)).toBe(true);
		});
		it('straight-up non-zero loses on 0', () => {
			expect(doesBetWin(makeBet('straight', 1, 17), 0)).toBe(false);
		});
	});
});

describe('evaluateBets', () => {
	it('returns payout for a winning straight bet (35:1)', () => {
		const results = evaluateBets([makeBet('straight', 10, 17)], 17);
		expect(results).toHaveLength(1);
		expect(results[0].won).toBe(true);
		expect(results[0].payout).toBe(360); // 10 * (35 + 1)
	});

	it('returns 0 payout for a losing straight bet', () => {
		const results = evaluateBets([makeBet('straight', 10, 17)], 18);
		expect(results[0].won).toBe(false);
		expect(results[0].payout).toBe(0);
	});

	it('returns payout for a winning red bet (1:1)', () => {
		const results = evaluateBets([makeBet('red', 50)], 1);
		expect(results[0].won).toBe(true);
		expect(results[0].payout).toBe(100); // 50 * (1 + 1)
	});

	it('returns payout for a winning dozen bet (2:1)', () => {
		const results = evaluateBets([makeBet('dozen', 50, 0)], 5);
		expect(results[0].won).toBe(true);
		expect(results[0].payout).toBe(150); // 50 * (2 + 1)
	});

	it('handles mixed wins and losses on the same spin', () => {
		const bets = [
			makeBet('straight', 10, 17),
			makeBet('red', 50),
			makeBet('black', 50),
			makeBet('odd', 25),
		];
		const results = evaluateBets(bets, 17); // 17 is red and odd
		expect(results).toHaveLength(4);
		expect(results[0].won).toBe(true); // straight 17
		expect(results[0].payout).toBe(360);
		expect(results[1].won).toBe(true); // red
		expect(results[1].payout).toBe(100);
		expect(results[2].won).toBe(false); // black
		expect(results[2].payout).toBe(0);
		expect(results[3].won).toBe(true); // odd
		expect(results[3].payout).toBe(50);
	});

	it('all bets lose on 0 except straight-0', () => {
		const bets = [
			makeBet('straight', 10, 0),
			makeBet('red', 50),
			makeBet('odd', 25),
			makeBet('dozen', 50, 0),
		];
		const results = evaluateBets(bets, 0);
		expect(results[0].won).toBe(true); // straight 0
		expect(results[0].payout).toBe(360);
		expect(results[1].won).toBe(false); // red
		expect(results[2].won).toBe(false); // odd
		expect(results[3].won).toBe(false); // dozen
	});

	it('net delta = totalPayout - totalBet', () => {
		const bets = [makeBet('straight', 10, 17), makeBet('red', 50)];
		const results = evaluateBets(bets, 17);
		const totalPayout = results.reduce((s, r) => s + r.payout, 0);
		const totalBet = bets.reduce((s, b) => s + b.amount, 0);
		expect(totalPayout).toBe(460); // 360 + 100
		expect(totalBet).toBe(60); // 10 + 50
		expect(totalPayout - totalBet).toBe(400); // net gain
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/roulette/betEvaluator.test.ts`
Expected: FAIL — `Cannot find module './betEvaluator'`

- [ ] **Step 3: Write `betEvaluator.ts`**

```typescript
import type { BetResult, RouletteBet } from './types';
import { BLACK_NUMBERS, PAYOUT_MULTIPLIERS, RED_NUMBERS } from './constants';

export function columnIndexToMod3(index: number): number {
	return [0, 2, 1][index];
}

export function doesBetWin(bet: RouletteBet, winningNumber: number): boolean {
	if (winningNumber === 0) {
		return bet.type === 'straight' && bet.target === 0;
	}
	switch (bet.type) {
		case 'straight':
			return bet.target === winningNumber;
		case 'red':
			return RED_NUMBERS.has(winningNumber);
		case 'black':
			return BLACK_NUMBERS.has(winningNumber);
		case 'odd':
			return winningNumber % 2 === 1;
		case 'even':
			return winningNumber % 2 === 0;
		case 'low':
			return winningNumber >= 1 && winningNumber <= 18;
		case 'high':
			return winningNumber >= 19 && winningNumber <= 36;
		case 'dozen':
			return Math.ceil(winningNumber / 12) === bet.target! + 1;
		case 'column':
			return winningNumber % 3 === columnIndexToMod3(bet.target!);
		default:
			return false;
	}
}

export function evaluateBets(bets: RouletteBet[], winningNumber: number): BetResult[] {
	return bets.map((bet) => {
		const won = doesBetWin(bet, winningNumber);
		const multiplier = PAYOUT_MULTIPLIERS[bet.type];
		return {
			bet,
			won,
			payout: won ? bet.amount * (multiplier + 1) : 0,
		};
	});
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/roulette/betEvaluator.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/roulette/betEvaluator.ts src/lib/roulette/betEvaluator.test.ts
git commit -m "feat(roulette): add bet evaluator with comprehensive tests"
```

---

### Task 3: RouletteGame — Betting Methods (TDD)

**Files:**

- Create: `src/lib/roulette/RouletteGame.ts`
- Test: `src/lib/roulette/RouletteGame.test.ts`

**Interfaces:**

- Consumes: types and constants from Task 1
- Produces: `RouletteGame` class with `canPlaceBet`, `placeBet`, `removeBet`, `clearBets`, `getState`, `getBalance`, `setBalance`

- [ ] **Step 1: Write failing tests for betting methods**

Create `src/lib/roulette/RouletteGame.test.ts`:

```typescript
import { describe, expect, it } from 'bun:test';
import { RouletteGame } from './RouletteGame';
import { MIN_BET, MAX_BET_PER_POSITION, MAX_TOTAL_BET } from './constants';

describe('RouletteGame — betting', () => {
	function newGame(balance = 1000) {
		return new RouletteGame({ initialBalance: balance });
	}

	describe('canPlaceBet', () => {
		it('rejects amount below MIN_BET', () => {
			const game = newGame();
			expect(game.canPlaceBet('straight', 0, 5).ok).toBe(false);
		});

		it('rejects negative amount', () => {
			const game = newGame();
			expect(game.canPlaceBet('red', -5).ok).toBe(false);
		});

		it('rejects amount above balance', () => {
			const game = newGame(100);
			expect(game.canPlaceBet('red', 101).ok).toBe(false);
		});

		it('accepts amount equal to balance', () => {
			const game = newGame(100);
			expect(game.canPlaceBet('red', 100).ok).toBe(true);
		});

		it('rejects when cumulative position total exceeds MAX_BET_PER_POSITION', () => {
			const game = newGame(10000);
			game.placeBet('straight', MAX_BET_PER_POSITION, 17);
			expect(game.canPlaceBet('straight', 1, 17).ok).toBe(false);
		});

		it('rejects when total bets exceed MAX_TOTAL_BET', () => {
			const game = newGame(100000);
			for (let i = 0; i < 10; i++) {
				game.placeBet('straight', 500, i + 1);
			}
			expect(game.canPlaceBet('straight', 1, 20).ok).toBe(false);
		});
	});

	describe('placeBet', () => {
		it('creates a bet with a valid id', () => {
			const game = newGame();
			const result = game.placeBet('red', 50);
			expect(result.success).toBe(true);
			expect(result.bet).toBeDefined();
			expect(result.bet!.id).toBeTruthy();
			expect(result.bet!.type).toBe('red');
			expect(result.bet!.amount).toBe(50);
		});

		it('deducts the amount from chipBalance', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			expect(game.getBalance()).toBe(950);
		});

		it('accumulates amount when placing on same position', () => {
			const game = newGame(1000);
			game.placeBet('straight', 25, 17);
			game.placeBet('straight', 25, 17);
			expect(game.getBalance()).toBe(950);
			const state = game.getState();
			expect(state.activeBets).toHaveLength(1);
			expect(state.activeBets[0].amount).toBe(50);
		});

		it('creates separate bets for different positions', () => {
			const game = newGame(1000);
			game.placeBet('straight', 25, 17);
			game.placeBet('straight', 25, 18);
			expect(game.getBalance()).toBe(950);
			expect(game.getState().activeBets).toHaveLength(2);
		});

		it('returns error on invalid bet', () => {
			const game = newGame(10);
			const result = game.placeBet('red', 500);
			expect(result.success).toBe(false);
			expect(result.error).toBeTruthy();
		});
	});

	describe('removeBet', () => {
		it('removes the bet and refunds the amount', () => {
			const game = newGame(1000);
			const result = game.placeBet('red', 50);
			const betId = result.bet!.id;
			game.removeBet(betId);
			expect(game.getBalance()).toBe(1000);
			expect(game.getState().activeBets).toHaveLength(0);
		});

		it('returns error for non-existent bet', () => {
			const game = newGame();
			const result = game.removeBet('nonexistent');
			expect(result.success).toBe(false);
		});
	});

	describe('clearBets', () => {
		it('removes all bets and refunds total', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.placeBet('straight', 25, 17);
			game.placeBet('dozen', 100, 0);
			game.clearBets();
			expect(game.getBalance()).toBe(1000);
			expect(game.getState().activeBets).toHaveLength(0);
		});
	});

	describe('balance invariant', () => {
		it('balance never goes negative from multiple bets', () => {
			const game = newGame(100);
			game.placeBet('red', 40);
			expect(game.getBalance()).toBe(60);
			game.placeBet('black', 40);
			expect(game.getBalance()).toBe(20);
			const result = game.placeBet('odd', 50);
			expect(result.success).toBe(false);
			expect(game.getBalance()).toBe(20);
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/roulette/RouletteGame.test.ts`
Expected: FAIL — `Cannot find module './RouletteGame'`

- [ ] **Step 3: Write `RouletteGame.ts` (betting methods only)**

```typescript
import {
	DEFAULT_SETTINGS,
	MAX_BET_PER_POSITION,
	MAX_ROUND_HISTORY,
	MAX_TOTAL_BET,
	MIN_BET,
} from './constants';
import type {
	BetType,
	RouletteBet,
	RouletteGameConfig,
	RouletteGameState,
	RouletteSettings,
} from './types';

function newBetId(): string {
	if (typeof globalThis.crypto?.randomUUID === 'function') {
		return globalThis.crypto.randomUUID();
	}
	return `bet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeSettings(input?: Partial<RouletteSettings>): RouletteSettings {
	const merged = { ...DEFAULT_SETTINGS, ...input };
	return {
		animationSpeed:
			merged.animationSpeed === 'slow' || merged.animationSpeed === 'fast'
				? merged.animationSpeed
				: 'normal',
		soundEnabled: typeof merged.soundEnabled === 'boolean' ? merged.soundEnabled : true,
	};
}

function positionKey(type: BetType, target?: number): string {
	return `${type}:${target ?? 'none'}`;
}

export class RouletteGame {
	private state: RouletteGameState;

	constructor(config: RouletteGameConfig) {
		const balance =
			typeof config.initialBalance === 'number' && Number.isFinite(config.initialBalance)
				? Math.max(0, Math.trunc(config.initialBalance))
				: 0;
		this.state = {
			phase: 'betting',
			activeBets: [],
			chipBalance: balance,
			selectedChipAmount: 5,
			lastSpin: null,
			roundHistory: [],
			settings: sanitizeSettings(config.settings),
		};
	}

	getState(): Readonly<RouletteGameState> {
		return {
			...this.state,
			activeBets: this.state.activeBets.map((b) => ({ ...b })),
			roundHistory: this.state.roundHistory.map((s) => ({ ...s })),
		};
	}

	getBalance(): number {
		return this.state.chipBalance;
	}

	setBalance(n: number): void {
		this.state.chipBalance = Math.max(0, Math.trunc(n));
	}

	private getExistingPositionAmount(type: BetType, target?: number): number {
		const key = positionKey(type, target);
		return this.state.activeBets
			.filter((b) => positionKey(b.type, b.target) === key)
			.reduce((sum, b) => sum + b.amount, 0);
	}

	private getTotalBet(): number {
		return this.state.activeBets.reduce((sum, b) => sum + b.amount, 0);
	}

	canPlaceBet(type: BetType, amount: number, target?: number): { ok: boolean; error?: string } {
		if (!Number.isInteger(amount) || amount < MIN_BET) {
			return { ok: false, error: `Minimum bet is ${MIN_BET} chip` };
		}
		if (amount > this.state.chipBalance) {
			return { ok: false, error: 'Insufficient chips' };
		}
		const existingPosition = this.getExistingPositionAmount(type, target);
		if (existingPosition + amount > MAX_BET_PER_POSITION) {
			return {
				ok: false,
				error: `Max ${MAX_BET_PER_POSITION} per position (${MAX_BET_PER_POSITION - existingPosition} remaining)`,
			};
		}
		const totalAfter = this.getTotalBet() + amount;
		if (totalAfter > MAX_TOTAL_BET) {
			return { ok: false, error: `Max total bet is ${MAX_TOTAL_BET}` };
		}
		return { ok: true };
	}

	placeBet(
		type: BetType,
		amount: number,
		target?: number,
	): { success: boolean; error?: string; bet?: RouletteBet } {
		if (this.state.phase !== 'betting') {
			return { success: false, error: 'Cannot place bets during spin' };
		}
		const check = this.canPlaceBet(type, amount, target);
		if (!check.ok) return { success: false, error: check.error };

		const key = positionKey(type, target);
		const existingIdx = this.state.activeBets.findIndex(
			(b) => positionKey(b.type, b.target) === key,
		);

		if (existingIdx >= 0) {
			this.state.activeBets[existingIdx] = {
				...this.state.activeBets[existingIdx],
				amount: this.state.activeBets[existingIdx].amount + amount,
			};
			this.state.chipBalance -= amount;
			return { success: true, bet: { ...this.state.activeBets[existingIdx] } };
		}

		const bet: RouletteBet = {
			id: newBetId(),
			type,
			amount,
			...(target !== undefined ? { target } : {}),
		};
		this.state.activeBets.push(bet);
		this.state.chipBalance -= amount;
		return { success: true, bet };
	}

	removeBet(betId: string): { success: boolean; error?: string } {
		if (this.state.phase !== 'betting') {
			return { success: false, error: 'Cannot remove bets outside betting phase' };
		}
		const idx = this.state.activeBets.findIndex((b) => b.id === betId);
		if (idx === -1) return { success: false, error: 'Bet not found' };
		this.state.chipBalance += this.state.activeBets[idx].amount;
		this.state.activeBets.splice(idx, 1);
		return { success: true };
	}

	clearBets(): void {
		if (this.state.phase !== 'betting') return;
		for (const bet of this.state.activeBets) {
			this.state.chipBalance += bet.amount;
		}
		this.state.activeBets = [];
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/roulette/RouletteGame.test.ts`
Expected: All betting tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/roulette/RouletteGame.ts src/lib/roulette/RouletteGame.test.ts
git commit -m "feat(roulette): add RouletteGame betting methods with balance invariant"
```

---

### Task 4: RouletteGame — Spin, Settle & RestoreState (TDD)

**Files:**

- Modify: `src/lib/roulette/RouletteGame.ts` (add spin/settle/restoreState)
- Modify: `src/lib/roulette/RouletteGame.test.ts` (add spin tests)

**Interfaces:**

- Consumes: `evaluateBets` from Task 2
- Produces: `RouletteGame.spin()`, `RouletteGame.restoreState()`

- [ ] **Step 1: Add failing tests for spin and restoreState**

Append to `src/lib/roulette/RouletteGame.test.ts`:

```typescript
import { evaluateBets } from './betEvaluator';
import type { SpinResult, RouletteGameState } from './types';

describe('RouletteGame — spin & settle (guest mode)', () => {
	function newGame(balance = 1000) {
		return new RouletteGame({ initialBalance: balance });
	}

	describe('spin (guest mode — local settlement)', () => {
		it('rejects spin with no bets', () => {
			const game = newGame();
			expect(() => game.spinGuest(17)).toThrow();
		});

		it('rejects spin during spinning phase', () => {
			const game = newGame();
			game.placeBet('red', 50);
			game.spinGuest(17);
			expect(() => game.spinGuest(17)).toThrow();
		});

		it('deducts total bet and credits payout on settle', () => {
			const game = newGame(1000);
			game.placeBet('straight', 10, 17);
			const result = game.spinGuest(17);
			expect(result.winningNumber).toBe(17);
			expect(result.totalBet).toBe(10);
			expect(result.totalPayout).toBe(360);
			expect(result.netDelta).toBe(350);
			expect(game.getBalance()).toBe(1350); // 1000 - 10 (placeBet) + 360 (settle)
		});

		it('sets phase to settled after spin', () => {
			const game = newGame();
			game.placeBet('red', 10);
			game.spinGuest(1);
			expect(game.getState().phase).toBe('settled');
		});

		it('clears active bets after spin', () => {
			const game = newGame();
			game.placeBet('red', 10);
			game.placeBet('straight', 5, 17);
			game.spinGuest(1);
			expect(game.getState().activeBets).toHaveLength(0);
		});

		it('records spin in roundHistory', () => {
			const game = newGame();
			game.placeBet('red', 10);
			game.spinGuest(1);
			expect(game.getState().roundHistory).toHaveLength(1);
			expect(game.getState().lastSpin).toBeTruthy();
		});

		it('caps roundHistory at MAX_ROUND_HISTORY', () => {
			const game = newGame(100000);
			for (let i = 0; i < 25; i++) {
				game.placeBet('red', 10);
				game.spinGuest(1);
				game.newRound();
			}
			expect(game.getState().roundHistory.length).toBeLessThanOrEqual(20);
		});
	});

	describe('newRound', () => {
		it('resets phase to betting', () => {
			const game = newGame();
			game.placeBet('red', 10);
			game.spinGuest(1);
			game.newRound();
			expect(game.getState().phase).toBe('betting');
		});
	});

	describe('restoreState', () => {
		it('round-trips state through serialization', () => {
			const game = newGame(1000);
			game.placeBet('red', 50);
			game.placeBet('straight', 25, 17);
			const snapshot = game.getState();
			const json = JSON.parse(JSON.stringify(snapshot));

			const game2 = newGame(0);
			expect(game2.restoreState(json)).toBe(true);
			expect(game2.getBalance()).toBe(925);
			expect(game2.getState().activeBets).toHaveLength(2);
			expect(game2.getState().phase).toBe('betting');
		});

		it('rejects corrupted data', () => {
			const game = newGame();
			expect(game.restoreState(null)).toBe(false);
			expect(game.restoreState({})).toBe(false);
			expect(game.restoreState({ phase: 'invalid' })).toBe(false);
		});
	});
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/lib/roulette/RouletteGame.test.ts`
Expected: FAIL — `spinGuest is not a function`

- [ ] **Step 3: Add spin/settle/restoreState methods to `RouletteGame.ts`**

Add these methods to the `RouletteGame` class (inside the class body, after `clearBets`):

```typescript
	newRound(): void {
		for (const bet of this.state.activeBets) {
			this.state.chipBalance += bet.amount;
		}
		this.state.activeBets = [];
		this.state.phase = 'betting';
	}

	beginSpin(): RouletteBet[] {
		if (this.state.phase !== 'betting') {
			throw new Error('Cannot spin outside betting phase');
		}
		if (this.state.activeBets.length === 0) {
			throw new Error('No bets placed');
		}
		const bets = this.state.activeBets.map((b) => ({ ...b }));
		this.state.phase = 'spinning';
		return bets;
	}

	applySettlement(spinResult: SpinResult): void {
		this.state.chipBalance = spinResult.results.reduce(
			(s, r) => s + (r.won ? r.payout : 0),
			Math.max(0, this.state.chipBalance),
		);
		if (spinResult.newBalance !== undefined) {
			this.state.chipBalance = spinResult.newBalance;
		}
		this.state.phase = 'settled';
		this.state.activeBets = [];
		this.state.lastSpin = spinResult;
		this.state.roundHistory.unshift(spinResult);
		if (this.state.roundHistory.length > MAX_ROUND_HISTORY) {
			this.state.roundHistory.length = MAX_ROUND_HISTORY;
		}
	}

	spinGuest(winningNumber: number): SpinResult {
		if (this.state.phase !== 'betting') {
			throw new Error('Cannot spin outside betting phase');
		}
		if (this.state.activeBets.length === 0) {
			throw new Error('No bets placed');
		}
		if (winningNumber < 0 || winningNumber > 36 || !Number.isInteger(winningNumber)) {
			throw new Error('Invalid winning number');
		}

		this.state.phase = 'spinning';

		const bets = this.state.activeBets.map((b) => ({ ...b }));
		const totalBet = bets.reduce((s, b) => s + b.amount, 0);
		const results = evaluateBets(bets, winningNumber);
		const totalPayout = results.reduce((s, r) => s + r.payout, 0);

		this.state.chipBalance += totalPayout;
		this.state.phase = 'settled';
		this.state.activeBets = [];

		const spinResult: SpinResult = {
			winningNumber,
			bets,
			totalBet,
			totalPayout,
			netDelta: totalPayout - totalBet,
			results,
			timestamp: Date.now(),
			syncId: '',
		};

		this.state.lastSpin = spinResult;
		this.state.roundHistory.unshift(spinResult);
		if (this.state.roundHistory.length > MAX_ROUND_HISTORY) {
			this.state.roundHistory.length = MAX_ROUND_HISTORY;
		}

		return spinResult;
	}

	restoreState(snapshot: unknown): boolean {
		if (!snapshot || typeof snapshot !== 'object') return false;
		const s = snapshot as Partial<RouletteGameState>;
		if (s.phase !== 'betting' && s.phase !== 'spinning' && s.phase !== 'settled') return false;
		if (typeof s.chipBalance !== 'number' || !Number.isInteger(s.chipBalance) || s.chipBalance < 0) {
			return false;
		}
		if (!Array.isArray(s.activeBets)) return false;

		this.state = {
			phase: s.phase,
			activeBets: s.activeBets.map((b) => ({ ...b })),
			chipBalance: s.chipBalance,
			selectedChipAmount:
				typeof s.selectedChipAmount === 'number' ? s.selectedChipAmount : this.state.selectedChipAmount,
			lastSpin: s.lastSpin ? { ...s.lastSpin } : null,
			roundHistory: Array.isArray(s.roundHistory) ? s.roundHistory.map((r) => ({ ...r })) : [],
			settings: sanitizeSettings(s.settings),
		};
		return true;
	}
```

Add this import at the top of `RouletteGame.ts` (after existing imports):

```typescript
import { evaluateBets } from './betEvaluator';
import type { SpinResult } from './types';
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/lib/roulette/RouletteGame.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/roulette/RouletteGame.ts src/lib/roulette/RouletteGame.test.ts
git commit -m "feat(roulette): add spin, settle, and restoreState methods"
```

---

### Task 5: GameSettingsManager

**Files:**

- Create: `src/lib/roulette/GameSettingsManager.ts`

- [ ] **Step 1: Create `GameSettingsManager.ts`**

Follow the exact pattern from `src/lib/craps/GameSettingsManager.ts`:

```typescript
import type { RouletteSettings } from './types';
import { DEFAULT_SETTINGS } from './constants';

const STORAGE_KEY = 'roulette-settings';

export class GameSettingsManager {
	private settings: RouletteSettings;

	constructor() {
		this.settings = this.load();
	}

	private validate(raw: unknown): RouletteSettings {
		const s: RouletteSettings = { ...DEFAULT_SETTINGS };
		if (!raw || typeof raw !== 'object') return s;
		const p = raw as Partial<RouletteSettings>;
		if (p.animationSpeed === 'slow' || p.animationSpeed === 'fast') {
			s.animationSpeed = p.animationSpeed;
		}
		if (typeof p.soundEnabled === 'boolean') s.soundEnabled = p.soundEnabled;
		return s;
	}

	private load(): RouletteSettings {
		if (typeof window === 'undefined') return { ...DEFAULT_SETTINGS };
		try {
			const stored = localStorage.getItem(STORAGE_KEY);
			if (stored) return this.validate(JSON.parse(stored));
		} catch {
			// ignore
		}
		return { ...DEFAULT_SETTINGS };
	}

	private save(): void {
		if (typeof window === 'undefined') return;
		try {
			localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
		} catch {
			// ignore
		}
	}

	getSettings(): RouletteSettings {
		return { ...this.settings };
	}

	updateSettings(updates: Partial<RouletteSettings>): RouletteSettings {
		this.settings = this.validate({ ...this.settings, ...updates });
		this.save();
		return this.getSettings();
	}

	resetToDefaults(): RouletteSettings {
		this.settings = { ...DEFAULT_SETTINGS };
		this.save();
		return this.getSettings();
	}
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/roulette/GameSettingsManager.ts
git commit -m "feat(roulette): add GameSettingsManager for settings persistence"
```

---

### Task 6: DB Schema + Migration

**Files:**

- Modify: `src/db/schema.ts` (add `rouletteRound` table, fix stale comment)
- Generate: `drizzle/0009_*.sql`

- [ ] **Step 1: Add `rouletteRound` table to `schema.ts`**

Add after the `mpMembership` table (at the end of the file):

```typescript
export const rouletteRound = sqliteTable(
	'roulette_round',
	{
		syncId: text('syncId').notNull(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		winningNumber: integer('winningNumber').notNull(),
		betsJson: text('betsJson').notNull(),
		totalBet: integer('totalBet').notNull(),
		totalPayout: integer('totalPayout').notNull(),
		netDelta: integer('netDelta').notNull(),
		previousBalance: integer('previousBalance').notNull(),
		newBalance: integer('newBalance').notNull(),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.syncId] }),
	}),
);
```

- [ ] **Step 2: Fix stale `gameStats` comment**

In `src/db/schema.ts`, change line 118 from:

```typescript
gameType: text('gameType').notNull(), // 'poker' | 'blackjack' | 'baccarat'
```

to:

```typescript
gameType: text('gameType').notNull(), // 'poker' | 'blackjack' | 'baccarat' | 'craps' | 'slots' | 'roulette'
```

- [ ] **Step 3: Generate migration**

Run: `bun run db:generate`
Expected: A new file `drizzle/0009_*.sql` is created containing the `CREATE TABLE roulette_round` statement.

- [ ] **Step 4: Apply migration locally**

Run: `bun run db:migrate:local`
Expected: Migration applies successfully.

- [ ] **Step 5: Verify table exists**

Run: `wrangler d1 execute arcturus-db --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name='roulette_round'"`
Expected: Shows the `roulette_round` table.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/0009_*.sql drizzle/meta/
git commit -m "feat(roulette): add roulette_round table + migration"
```

---

### Task 7: Integration Touchpoints

**Files:**

- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/pages/api/chips/update.ts`

- [ ] **Step 1: Update `game-stats/constants.ts`**

Change the three registries:

```typescript
export const GAME_TYPES = ['blackjack', 'baccarat', 'craps', 'poker', 'slots', 'roulette'] as const;
```

```typescript
export const GAME_TYPE_LABELS: Record<(typeof GAME_TYPES)[number], string> = {
	blackjack: 'Blackjack',
	baccarat: 'Baccarat',
	craps: 'Craps',
	poker: 'Poker',
	slots: 'Slots',
	roulette: 'Roulette',
};
```

```typescript
export const GAME_TYPE_ICONS: Record<(typeof GAME_TYPES)[number], string> = {
	blackjack: '\u{1F0CF}',
	baccarat: '\u{1F3B4}',
	craps: '\u{1F3B2}',
	poker: '\u2660\uFE0F',
	slots: '\u{1F3B0}',
	roulette: '\u{1F3AB}',
};
```

- [ ] **Step 2: Do NOT add `roulette` to `GAME_LIMITS` in `chips/update.ts`**

Roulette is server-settled via `/api/roulette/spin` with its own
`ROULETTE_MAX_WIN` / `ROULETTE_MAX_LOSS` audit limits (see
`src/lib/roulette/constants.ts`). The `chips/update.ts` endpoint is
client-authoritative and must NOT accept `roulette` as a `gameType` —
doing so would allow direct chip manipulation bypassing the server-side
settlement. The `GAME_LIMITS` object in `chips/update.ts` intentionally
excludes `roulette` (see the comment at the end of the object).

- [ ] **Step 3: Verify type-checking and lint**

Run: `bun x tsc --noEmit --pretty 2>&1 | grep -i roulette`
Expected: No errors

Run: `bun run lint`
Expected: 0 warnings

- [ ] **Step 4: Commit**

```bash
git add src/lib/game-stats/constants.ts
git commit -m "feat(roulette): register game type in constants"
```

---

### Task 8: Spin Endpoint — Atomic Settlement

**Files:**

- Create: `src/pages/api/roulette/spin.ts`

**Interfaces:**

- Consumes: `evaluateBets` from `src/lib/roulette/betEvaluator.ts`, `ROULETTE_MAX_WIN` / `ROULETTE_MAX_LOSS` from `src/lib/roulette/constants.ts`, `checkAndGrantAchievements`
- Produces: `POST /api/roulette/spin` handler

- [ ] **Step 1: Create the spin endpoint**

Create `src/pages/api/roulette/spin.ts`:

```typescript
import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { evaluateBets } from '../../../lib/roulette/betEvaluator';
import { MAX_BET_PER_POSITION, MAX_TOTAL_BET, MIN_BET } from '../../../lib/roulette/constants';
import type { BetType, RouletteBet } from '../../../lib/roulette/types';
import {
	recordGameRound,
	type GameType,
	type GameRoundOutcome,
} from '../../../lib/game-stats/game-stats';
import { checkAndGrantAchievements } from '../../../lib/achievements/achievements';
import { redactUserId } from '../../../lib/achievements/achievement-repository';
import { isValidGameType } from '../../../lib/game-stats/constants';

const VALID_OUTSIDE_BET_TYPES = new Set<BetType>(['red', 'black', 'odd', 'even', 'low', 'high']);
const VALID_TARGET_BET_TYPES = new Set<BetType>(['straight', 'dozen', 'column']);
const SYNC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function isValidBet(b: unknown): b is RouletteBet {
	if (!b || typeof b !== 'object') return false;
	const bet = b as Record<string, unknown>;
	if (typeof bet.id !== 'string' || !bet.id) return false;
	if (typeof bet.type !== 'string') return false;
	const type = bet.type as BetType;
	if (!VALID_OUTSIDE_BET_TYPES.has(type) && !VALID_TARGET_BET_TYPES.has(type)) {
		return false;
	}
	if (typeof bet.amount !== 'number' || !Number.isInteger(bet.amount) || bet.amount < MIN_BET) {
		return false;
	}
	if (VALID_OUTSIDE_BET_TYPES.has(type) && bet.target !== undefined) {
		return false;
	}
	if (type === 'straight') {
		if (
			typeof bet.target !== 'number' ||
			!Number.isInteger(bet.target) ||
			bet.target < 0 ||
			bet.target > 36
		) {
			return false;
		}
	}
	if (type === 'dozen' || type === 'column') {
		if (typeof bet.target !== 'number' || ![0, 1, 2].includes(bet.target)) {
			return false;
		}
	}
	return true;
}

function generateWinningNumber(): number {
	const buf = new Uint8Array(1);
	const LIMIT = 222;
	do {
		crypto.getRandomValues(buf);
	} while (buf[0] >= LIMIT);
	return buf[0] % 37;
}

const ROULETTE_MAX_WIN = 50000;
const ROULETTE_MAX_LOSS = 10000;
const MIN_UPDATE_INTERVAL_MS = 2000;
const lastUpdateByUser = new Map<string, number>();

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.user) {
		return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const userId = locals.user.id;
	const now = Date.now();

	let body: {
		syncId?: unknown;
		bets?: unknown;
		totalBet?: unknown;
	};
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'INVALID_JSON' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const { syncId, bets: rawBets, totalBet: rawTotalBet } = body;

	if (typeof syncId !== 'string' || !SYNC_ID_RE.test(syncId)) {
		return new Response(JSON.stringify({ error: 'INVALID_SYNC_ID' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	if (!Array.isArray(rawBets) || rawBets.length === 0) {
		return new Response(JSON.stringify({ error: 'INVALID_BETS' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const bets = rawBets.filter(isValidBet);
	if (bets.length !== rawBets.length) {
		return new Response(JSON.stringify({ error: 'INVALID_BETS' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const totalBet = bets.reduce((sum, b) => sum + b.amount, 0);
	if (totalBet < MIN_BET || totalBet > MAX_TOTAL_BET) {
		return new Response(JSON.stringify({ error: 'INVALID_TOTAL_BET' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const positionTotals = new Map<string, number>();
	for (const bet of bets) {
		const key = `${bet.type}:${bet.target ?? 'none'}`;
		positionTotals.set(key, (positionTotals.get(key) ?? 0) + bet.amount);
	}
	for (const total of positionTotals.values()) {
		if (total > MAX_BET_PER_POSITION) {
			return new Response(JSON.stringify({ error: 'POSITION_LIMIT_EXCEEDED' }), {
				status: 400,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	const dbBinding = locals.runtime?.env?.DB;
	if (!dbBinding) {
		return new Response(JSON.stringify({ error: 'DATABASE_UNAVAILABLE' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const existing = await dbBinding
		.prepare(
			'SELECT winningNumber, newBalance, previousBalance, netDelta, betsJson FROM roulette_round WHERE userId = ? AND syncId = ?',
		)
		.bind(userId, syncId)
		.first();

	if (existing) {
		return new Response(
			JSON.stringify({
				winningNumber: existing.winningNumber,
				newBalance: existing.newBalance,
				previousBalance: existing.previousBalance,
				netDelta: existing.netDelta,
				results: evaluateBets(
					JSON.parse(existing.betsJson as string),
					existing.winningNumber as number,
				),
				syncId,
				newAchievements: undefined,
			}),
			{ headers: { 'Content-Type': 'application/json' } },
		);
	}

	const db = createDb(dbBinding);
	const [userRow] = await db
		.select({ chipBalance: user.chipBalance, heldChips: user.heldChips })
		.from(user)
		.where(eq(user.id, userId))
		.limit(1);

	if (!userRow) {
		return new Response(JSON.stringify({ error: 'USER_NOT_FOUND' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const heldChips = Math.trunc(userRow.heldChips ?? 0);
	if (heldChips > 0) {
		return new Response(JSON.stringify({ error: 'MP_ESCROW_ACTIVE' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const previousBalance = Math.trunc(userRow.chipBalance);
	if (totalBet > previousBalance) {
		return new Response(
			JSON.stringify({ error: 'INSUFFICIENT_BALANCE', currentBalance: previousBalance }),
			{ status: 400, headers: { 'Content-Type': 'application/json' } },
		);
	}

	const lastUpdate = lastUpdateByUser.get(userId) ?? 0;
	if (now - lastUpdate < MIN_UPDATE_INTERVAL_MS) {
		const waitTime = Math.ceil((MIN_UPDATE_INTERVAL_MS - (now - lastUpdate)) / 1000);
		return new Response(
			JSON.stringify({ error: 'RATE_LIMITED', message: `Please wait ${waitTime}s` }),
			{
				status: 429,
				headers: { 'Content-Type': 'application/json', 'Retry-After': String(waitTime) },
			},
		);
	}

	const winningNumber = generateWinningNumber();
	const results = evaluateBets(bets, winningNumber);
	const totalPayout = results.reduce((sum, r) => sum + r.payout, 0);
	const netDelta = totalPayout - totalBet;

	if (netDelta > ROULETTE_MAX_WIN || (netDelta < 0 && Math.abs(netDelta) > ROULETTE_MAX_LOSS)) {
		console.warn(`[ROULETTE_AUDIT] User ${redactUserId(userId)} delta ${netDelta} exceeds limits`);
		return new Response(JSON.stringify({ error: 'DELTA_EXCEEDS_LIMIT' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const newBalance = previousBalance + netDelta;
	if (newBalance < 0) {
		return new Response(JSON.stringify({ error: 'INSUFFICIENT_BALANCE' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const nowSeconds = Math.trunc(now / 1000);
	const outcome = netDelta > 0 ? 'win' : netDelta < 0 ? 'loss' : 'push';

	const batchResults = await dbBinding.batch([
		dbBinding
			.prepare('UPDATE user SET chipBalance = ?, updatedAt = ? WHERE id = ? AND chipBalance = ?')
			.bind(newBalance, nowSeconds, userId, previousBalance),
		dbBinding
			.prepare(
				'INSERT INTO roulette_round (syncId, userId, winningNumber, betsJson, totalBet, totalPayout, netDelta, previousBalance, newBalance, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
			)
			.bind(
				syncId,
				userId,
				winningNumber,
				JSON.stringify(bets),
				totalBet,
				totalPayout,
				netDelta,
				previousBalance,
				newBalance,
				nowSeconds,
			),
		dbBinding
			.prepare(
				'INSERT INTO chip_sync_receipt (userId, syncId, gameType, previousBalance, balance, delta, statsDelta, outcome, handCount, winsIncrement, lossesIncrement, biggestWinCandidate, overallRank, achievementPayload, createdAt) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1',
			)
			.bind(
				userId,
				syncId,
				'roulette',
				previousBalance,
				newBalance,
				netDelta,
				netDelta,
				outcome,
				1,
				netDelta > 0 ? 1 : 0,
				netDelta < 0 ? 1 : 0,
				netDelta > 0 ? netDelta : 0,
				null,
				null,
				nowSeconds,
			),
	]);

	const updateResult = batchResults[0] as { meta?: { changes?: number } } | null;
	if ((updateResult?.meta?.changes ?? 0) === 0) {
		return new Response(JSON.stringify({ error: 'CONCURRENT_MODIFICATION' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	lastUpdateByUser.set(userId, now);

	if (netDelta > 0) {
		console.warn(
			`[CHIP_AUDIT] User ${redactUserId(userId)} won ${netDelta} in roulette: ${previousBalance} -> ${newBalance}`,
		);
	}

	let newAchievements: Array<{ id: string; name: string; icon: string }> = [];
	try {
		if (isValidGameType('roulette')) {
			await recordGameRound(db, userId, {
				gameType: 'roulette' as GameType,
				outcome: outcome as GameRoundOutcome,
				chipDelta: netDelta,
				handCount: 1,
				winsIncrement: netDelta > 0 ? 1 : 0,
				lossesIncrement: netDelta < 0 ? 1 : 0,
				biggestWinCandidate: netDelta > 0 ? netDelta : undefined,
			});

			const earned = await checkAndGrantAchievements(db, userId, newBalance, {
				recentWinAmount: netDelta > 0 ? netDelta : undefined,
				gameType: 'roulette' as GameType,
			});
			newAchievements = earned.map((a) => ({ id: a.id, name: a.name, icon: a.icon }));
		}
	} catch (statsError) {
		console.error('[ROULETTE] Stats/achievement error:', statsError);
	}

	return new Response(
		JSON.stringify({
			winningNumber,
			newBalance,
			previousBalance,
			netDelta,
			results,
			syncId,
			newAchievements: newAchievements.length > 0 ? newAchievements : undefined,
		}),
		{ headers: { 'Content-Type': 'application/json' } },
	);
};
```

- [ ] **Step 2: Verify type-checking**

Run: `bun x tsc --noEmit --pretty 2>&1 | grep -E "roulette|spin" `
Expected: No errors

- [ ] **Step 3: Verify lint**

Run: `bun run lint`
Expected: 0 warnings

- [ ] **Step 4: Commit**

```bash
git add src/pages/api/roulette/spin.ts
git commit -m "feat(roulette): add server-side atomic settlement endpoint"
```

---

### Task 9: RouletteUIRenderer

**Files:**

- Create: `src/lib/roulette/RouletteUIRenderer.ts`

This class handles all DOM manipulation. It's tested via E2E (Task 12) since it requires browser DOM.

- [ ] **Step 1: Create `RouletteUIRenderer.ts`**

```typescript
import type { RouletteGameState, SpinResult, RouletteBet } from './types';
import { WHEEL_ORDER, RED_NUMBERS, CHIP_DENOMINATIONS } from './constants';

export class RouletteUIRenderer {
	private wheelEl: HTMLElement;
	private resultEl: HTMLElement;
	private balanceEl: HTMLElement;
	private totalBetEl: HTMLElement;
	private activeBetsEl: HTMLElement;
	private spinBtn: HTMLButtonElement;
	private clearBtn: HTMLButtonElement;
	private newRoundBtn: HTMLButtonElement;
	private phaseEl: HTMLElement;
	private wheelRotation = 0;

	constructor() {
		this.wheelEl = document.getElementById('roulette-wheel')!;
		this.resultEl = document.getElementById('wheel-result')!;
		this.balanceEl = document.getElementById('chip-balance')!;
		this.totalBetEl = document.getElementById('total-bet')!;
		this.activeBetsEl = document.getElementById('active-bets')!;
		this.spinBtn = document.getElementById('spin-button') as HTMLButtonElement;
		this.clearBtn = document.getElementById('clear-bets-button') as HTMLButtonElement;
		this.newRoundBtn = document.getElementById('new-round-button') as HTMLButtonElement;
		this.phaseEl = document.getElementById('game-phase')!;
	}

	update(state: RouletteGameState): void {
		this.balanceEl.textContent = `$${state.chipBalance.toLocaleString()}`;
		const totalBet = state.activeBets.reduce((s, b) => s + b.amount, 0);
		this.totalBetEl.textContent = `$${totalBet.toLocaleString()}`;

		this.renderActiveBets(state.activeBets);

		const canSpin = state.activeBets.length > 0 && state.phase === 'betting';
		this.spinBtn.disabled = !canSpin;
		this.clearBtn.disabled = state.activeBets.length === 0 || state.phase !== 'betting';

		if (state.phase === 'settled') {
			this.newRoundBtn.hidden = false;
			this.spinBtn.hidden = true;
		} else {
			this.newRoundBtn.hidden = true;
			this.spinBtn.hidden = false;
		}

		this.phaseEl.textContent =
			state.phase === 'betting'
				? 'Place Your Bets'
				: state.phase === 'spinning'
					? 'No More Bets'
					: state.phase === 'settled'
						? 'Round Complete'
						: '';

		if (state.phase === 'spinning') {
			this.spinBtn.disabled = true;
		}
	}

	private renderActiveBets(bets: RouletteBet[]): void {
		this.activeBetsEl.innerHTML = '';
		for (const bet of bets) {
			const div = document.createElement('div');
			div.id = `active-bet-${bet.id}`;
			div.className = 'flex items-center justify-between py-1 text-sm';
			const label = this.betLabel(bet);
			div.innerHTML = `<span>${label}</span><span class="text-[var(--deco-brass)]">$${bet.amount}</span>`;
			this.activeBetsEl.appendChild(div);
		}
	}

	private betLabel(bet: RouletteBet): string {
		switch (bet.type) {
			case 'straight':
				return `Straight ${bet.target}`;
			case 'red':
				return 'Red';
			case 'black':
				return 'Black';
			case 'odd':
				return 'Odd';
			case 'even':
				return 'Even';
			case 'low':
				return '1–18';
			case 'high':
				return '19–36';
			case 'dozen':
				return `${['1st', '2nd', '3rd'][bet.target!]} 12`;
			case 'column':
				return `Column ${bet.target! + 1}`;
		}
	}

	animateWheel(winningNumber: number): void {
		const SEGMENT = 360 / 37;
		const pocketIndex = WHEEL_ORDER.indexOf(winningNumber);
		const desiredAngle = -(pocketIndex * SEGMENT);
		const currentAngle = this.wheelRotation % 360;
		let forwardDelta = desiredAngle - currentAngle;
		while (forwardDelta < 0) forwardDelta += 360;
		this.wheelRotation += 5 * 360 + forwardDelta;
		this.wheelEl.style.transform = `rotate(${this.wheelRotation}deg)`;
	}

	showResult(spinResult: SpinResult): void {
		const n = spinResult.winningNumber;
		const color = n === 0 ? 'Green' : RED_NUMBERS.has(n) ? 'Red' : 'Black';
		this.resultEl.textContent = `${n} ${color}`;
		this.resultEl.setAttribute('aria-label', `Winning number: ${n} ${color}`);
	}

	getSelectedChipAmount(): number {
		const selected = document.querySelector('.chip-select.selected') as HTMLElement | null;
		if (selected) return Number(selected.dataset.amount);
		return 5;
	}

	setSelectedChip(amount: number): void {
		document.querySelectorAll('.chip-select').forEach((el) => {
			el.classList.toggle('selected', Number((el as HTMLElement).dataset.amount) === amount);
			(el as HTMLElement).setAttribute(
				'aria-pressed',
				String(Number((el as HTMLElement).dataset.amount) === amount),
			);
		});
	}
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/roulette/RouletteUIRenderer.ts
git commit -m "feat(roulette): add UI renderer with wheel animation"
```

---

### Task 10: rouletteClient.ts — Client Integration

**Files:**

- Create: `src/lib/roulette/rouletteClient.ts`

- [ ] **Step 1: Create `rouletteClient.ts`**

```typescript
import { RouletteGame } from './RouletteGame';
import { RouletteUIRenderer } from './RouletteUIRenderer';
import { GameSettingsManager } from './GameSettingsManager';
import { CHIP_DENOMINATIONS } from './constants';
import type { BetType, SpinResult } from './types';
import { initAchievementToast } from '../achievement-toast';
import {
	isGuestModeValue,
	loadGuestBankroll,
	persistGuestBankroll,
	shouldSyncAccountChips,
	GUEST_CLIENT_USER_ID,
} from '../public-game-session';

export function initRouletteClient(): void {
	const root = document.getElementById('roulette-root');
	if (!root) throw new Error('roulette-root not found');

	const initialBalance = Number(root.dataset.initialBalance ?? 1000);
	const userId = root.dataset.userId ?? GUEST_CLIENT_USER_ID;
	const isGuestMode = isGuestModeValue(root.dataset.guestMode);
	const gameKey = 'roulette';

	const restoredGuestBalance = isGuestMode
		? loadGuestBankroll(gameKey, userId, initialBalance)
		: initialBalance;

	const game = new RouletteGame({ initialBalance: restoredGuestBalance });
	const ui = new RouletteUIRenderer();
	const settings = new GameSettingsManager();
	const sessionKey = `roulette-session:${userId}`;

	restoreSession(game, sessionKey);
	ui.update(game.getState());

	function persistSession(): void {
		if (isGuestMode) {
			persistGuestBankroll(gameKey, userId, game.getBalance());
		}
		try {
			localStorage.setItem(sessionKey, JSON.stringify(game.getState()));
		} catch {
			// ignore
		}
	}

	function updateAndPersist(): void {
		ui.update(game.getState());
		persistSession();
	}

	// Chip selection
	document.querySelectorAll('.chip-select').forEach((btn) => {
		btn.addEventListener('click', () => {
			const amount = Number((btn as HTMLElement).dataset.amount);
			ui.setSelectedChip(amount);
		});
	});

	// Betting table clicks
	document.querySelectorAll<HTMLElement>('[data-bet-type]').forEach((el) => {
		el.addEventListener('click', () => {
			if (game.getState().phase !== 'betting') return;
			const type = el.dataset.betType as BetType;
			const target = el.dataset.betTarget !== undefined ? Number(el.dataset.betTarget) : undefined;
			const amount = ui.getSelectedChipAmount();
			const result = game.placeBet(type, amount, target);
			if (!result.success) {
				showMessage(result.error ?? 'Cannot place bet', 'error');
			}
			updateAndPersist();
		});
	});

	// Remove bet by clicking in sidebar
	document.getElementById('active-bets')?.addEventListener('click', (e) => {
		const target = e.target as HTMLElement;
		const betEntry = target.closest('[id^="active-bet-"]');
		if (!betEntry) return;
		const betId = betEntry.id.replace('active-bet-', '');
		game.removeBet(betId);
		updateAndPersist();
	});

	// Clear bets
	document.getElementById('clear-bets-button')?.addEventListener('click', () => {
		game.clearBets();
		updateAndPersist();
	});

	// Spin
	document.getElementById('spin-button')?.addEventListener('click', async () => {
		if (game.getState().phase !== 'betting') return;
		const syncId =
			typeof crypto !== 'undefined' && crypto.randomUUID
				? crypto.randomUUID()
				: `spin-${Date.now()}-${Math.random().toString(36).slice(2)}`;

		try {
			let spinResult: SpinResult;

			if (shouldSyncAccountChips({ isGuestMode })) {
				// Authenticated: server-side settlement
				// beginSpin validates + locks the table (phase -> 'spinning')
				const bets = game.beginSpin();
				const totalBet = bets.reduce((s, b) => s + b.amount, 0);
				ui.update(game.getState());
				persistSession();

				const response = await fetch('/api/roulette/spin', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ syncId, bets, totalBet }),
				});

				if (!response.ok) {
					const err = await response.json().catch(() => ({}));
					throw new Error(err.error ?? `HTTP ${response.status}`);
				}

				const data = await response.json();
				spinResult = {
					winningNumber: data.winningNumber,
					bets,
					totalBet,
					totalPayout: data.netDelta + totalBet,
					netDelta: data.netDelta,
					results: data.results,
					timestamp: Date.now(),
					syncId,
					newBalance: data.newBalance,
				};

				game.setBalance(data.newBalance);
				game.applySettlement(spinResult);

				if (data.newAchievements?.length) {
					window.dispatchEvent(
						new CustomEvent('achievement-earned', {
							detail: { achievements: data.newAchievements },
						}),
					);
				}
			} else {
				// Guest: local settlement (spinGuest handles begin+settle internally)
				const winningNumber = generateLocalWinningNumber();
				spinResult = game.spinGuest(winningNumber);
				spinResult.syncId = syncId;
			}

			ui.animateWheel(spinResult.winningNumber);
			setTimeout(() => {
				ui.showResult(spinResult);
				ui.update(game.getState());
				persistSession();
			}, 4000);
		} catch (err) {
			console.error('[ROULETTE] Spin failed:', err);
			game.newRound(); // Reset to betting phase
			showMessage('Spin failed. Please try again.', 'error');
			ui.update(game.getState());
			persistSession();
		}
	});

	// New round
	document.getElementById('new-round-button')?.addEventListener('click', () => {
		game.newRound();
		ui.resultEl.textContent = '';
		updateAndPersist();
	});

	// Achievement toast
	const achievementToast = document.getElementById('achievement-toast');
	const achievementIconEl = document.getElementById('achievement-icon');
	const achievementNameEl = document.getElementById('achievement-name');

	if (achievementToast && achievementIconEl && achievementNameEl) {
		const { enqueue } = initAchievementToast(() => ({
			toast: achievementToast as HTMLElement,
			icon: achievementIconEl as HTMLElement,
			name: achievementNameEl as HTMLElement,
		}));
		window.addEventListener('achievement-earned', (e) => {
			const { achievements } = (e as CustomEvent).detail;
			if (Array.isArray(achievements)) enqueue(achievements);
		});
	}

	function showMessage(msg: string, _type: string): void {
		const el = document.getElementById('game-message');
		if (el) {
			el.textContent = msg;
			setTimeout(() => {
				el.textContent = '';
			}, 3000);
		}
	}
}

function generateLocalWinningNumber(): number {
	const buf = new Uint8Array(1);
	const LIMIT = 222;
	do {
		crypto.getRandomValues(buf);
	} while (buf[0] >= LIMIT);
	return buf[0] % 37;
}

function restoreSession(game: RouletteGame, key: string): void {
	try {
		const raw = localStorage.getItem(key);
		if (raw) {
			game.restoreState(JSON.parse(raw));
		}
	} catch {
		// ignore corrupted session
	}
}
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/roulette/rouletteClient.ts
git commit -m "feat(roulette): add client integration with server-side settlement"
```

---

### Task 11: Game Page (`roulette.astro`)

**Files:**

- Create: `src/pages/games/roulette.astro`

- [ ] **Step 1: Create the page**

Create `src/pages/games/roulette.astro` with the full layout, betting table, wheel, chip selector, and script. Follow the pattern from `craps.astro` for the frontmatter and script initialization.

The page must include:

- `CasinoLayout` wrapper
- Root `<div id="roulette-root" data-user-id={clientUserId} data-guest-mode={...} data-initial-balance={...}>`
- Wheel container `<div id="roulette-wheel">` with an SVG or CSS-based wheel
- Result display `<div id="wheel-result" aria-live="polite">`
- Betting table with `data-bet-type` and `data-bet-target` attributes on each clickable position
- Chip selector buttons with `class="chip-select"` and `data-amount`
- Active bets sidebar `<div id="active-bets">`
- Balance display `<span id="chip-balance">`
- Total bet display `<span id="total-bet">`
- Spin button `<button id="spin-button">`
- Clear button `<button id="clear-bets-button">`
- New round button `<button id="new-round-button" hidden>`
- Game phase indicator `<span id="game-phase">`
- Game message area `<div id="game-message">`
- Rules panel `<div id="rules-panel">` with payout table
- Achievement toast elements (same as other games)
- `<script>` importing and calling `initRouletteClient()`

Reference `src/pages/games/craps.astro` lines 1-12 for the exact frontmatter pattern and `src/pages/games/baccarat.astro` for achievement toast DOM structure.

Key data attributes on betting positions:

- Numbers: `data-bet-type="straight" data-bet-target="{number}"`
- Red: `data-bet-type="red"`
- Black: `data-bet-type="black"`
- Odd: `data-bet-type="odd"`
- Even: `data-bet-type="even"`
- Low: `data-bet-type="low"`
- High: `data-bet-type="high"`
- Dozens: `data-bet-type="dozen" data-bet-target="{0|1|2}"`
- Columns: `data-bet-type="column" data-bet-target="{0|1|2}"`

- [ ] **Step 2: Verify dev server starts**

Run: `bun run dev`
Open: `http://localhost:2000/games/roulette`
Expected: Page loads with wheel, betting table, and chip selector visible.

- [ ] **Step 3: Verify lint**

Run: `bun run lint`
Expected: 0 warnings

- [ ] **Step 4: Commit**

```bash
git add src/pages/games/roulette.astro
git commit -m "feat(roulette): add game page with wheel, table, and controls"
```

---

### Task 12: E2E Tests

**Files:**

- Create: `e2e/roulette.spec.ts`

- [ ] **Step 1: Create the E2E test file**

Create `e2e/roulette.spec.ts` following the pattern from `e2e/baccarat.spec.ts`:

```typescript
import { test, expect } from '@playwright/test';

test.describe('Roulette game', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/games/roulette');
	});

	test('displays complete roulette UI', async ({ page }) => {
		await expect(page.locator('#roulette-root')).toBeVisible();
		await expect(page.locator('#roulette-wheel')).toBeVisible();
		await expect(page.locator('#betting-table')).toBeVisible();
		await expect(page.locator('#chip-balance')).toBeVisible();
		await expect(page.locator('#spin-button')).toBeVisible();
	});

	test('can place and clear bets', async ({ page }) => {
		await page.locator('[data-bet-type="red"]').click();
		await expect(page.locator('#total-bet')).not.toContainText('$0');
		await page.locator('#clear-bets-button').click();
		await expect(page.locator('#total-bet')).toContainText('$0');
	});

	test('spin button disabled with no bets', async ({ page }) => {
		await expect(page.locator('#spin-button')).toBeDisabled();
	});

	test('can spin after placing a bet', async ({ page }) => {
		await page.locator('[data-bet-type="red"]').click();
		await expect(page.locator('#spin-button')).toBeEnabled();
		await page.locator('#spin-button').click();
		// Wait for wheel animation + result
		await expect(page.locator('#wheel-result')).not.toContainText('', { timeout: 10000 });
		// New round button should appear
		await expect(page.locator('#new-round-button')).toBeVisible({ timeout: 10000 });
	});

	test('rules panel is accessible', async ({ page }) => {
		await page.locator('#rules-toggle').click();
		await expect(page.locator('#rules-panel')).toBeVisible();
		await expect(page.locator('#rules-panel')).toContainText('35:1');
	});
});
```

- [ ] **Step 2: Run E2E tests**

Run: `bun run test:e2e -- e2e/roulette.spec.ts`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add e2e/roulette.spec.ts
git commit -m "test(roulette): add E2E tests for game flow"
```

---

## Post-Implementation Verification

After all tasks are complete:

- [ ] **Run full unit test suite**: `bun run test`
- [ ] **Run full E2E suite**: `bun run test:e2e`
- [ ] **Run lint**: `bun run lint` (0 warnings)
- [ ] **Run format check**: `bun run format:check`
- [ ] **Manual test**: Visit `/games/roulette`, place bets, spin, verify balance changes correctly
- [ ] **Verify game lobby**: Visit `/` and confirm Roulette card links correctly
