# Roulette Game Design

**Linear Issue**: [HPA-126](https://linear.app/cwchanap/issue/HPA-126/requirement-roulette-game)
**Date**: 2026-07-11
**Status**: Approved

## Overview

Implement a playable European roulette game at `/games/roulette` with a server-randomized spin endpoint, clear betting, reliable chip settlement via the existing `/api/chips/update` pipeline, and a CSS/SVG animated wheel.

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Winning number resolution | Server-randomized spin endpoint | Issue requires client not determine the number; first game with a server-side outcome endpoint. Settlement still trusts client delta (same security posture as other games) |
| Spin idempotency | Stateless random + client localStorage persistence | Simplest server; chip idempotency handled by existing `syncId` + `chip_sync_receipt` system |
| Bet model | Discriminated union by `BetType` | Extensible — adding split/street/corner/line later adds variants + evaluator cases without architecture change |
| Chip accounting | Deduct at spin, credit at settle | Matches issue requirement and existing games' upfront-deduction convention |
| Server validation depth | Validate constraints only; client computes payouts | Server generates number + validates limits; client uses pure `betEvaluator` functions for settlement |
| Wheel visual | Animated CSS/SVG wheel | Polished but manageable; guaranteed landing on correct pocket via computed rotation |

## Module Structure

```
src/lib/roulette/
├── types.ts              # BetType, RouletteBet, RouletteGameState, RoundResult, etc.
├── constants.ts          # Wheel order, colors, payout multipliers, limits, chip denominations
├── betEvaluator.ts       # Pure: doesBetWin(bet, winningNumber), evaluateBets(bets, winningNumber)
├── RouletteGame.ts       # State machine: placeBet, removeBet, clearBets, spin, settle
├── RouletteUIRenderer.ts # DOM updates: wheel, betting table, chip stacks, balance, messages
├── rouletteClient.ts     # Client integration: DOM event wiring, chip sync, session persistence
├── GameSettingsManager.ts # LocalStorage: animation speed, sound, last selected chip
├── index.ts              # Re-exports
├── betEvaluator.test.ts  # Unit tests for all bet types, 0-handling, payouts
└── RouletteGame.test.ts  # Unit tests for bet validation, insufficient balance, duplicate settlement

src/pages/games/roulette.astro   # Game page (CasinoLayout, session, script)
src/pages/api/roulette/spin.ts   # Server endpoint: validate + generate winning number
e2e/roulette.spec.ts             # E2E: place bets, spin, verify settlement, responsive
```

**`rouletteClient.ts` responsibilities** (matches the pattern of `blackjackClient.ts`, `baccaratClient.ts`, `slotsClient.ts`):
- Read `data-*` attributes from the page root element (`data-user-id`, `data-guest-mode`, `data-initial-balance`)
- Instantiate `RouletteGame` with the correct initial balance (guest bankroll from `loadGuestBankroll` or server balance)
- Wire DOM events (chip selection, table clicks, spin/clear/new-round buttons) to `RouletteGame` methods
- Drive `RouletteUIRenderer` updates on state changes
- Run `syncBalance()` after each settled round — with rate-limit/retry handling (see Chip Sync section)
- Persist/restore session state to localStorage for refresh protection
- Handle achievement toast events

**Architectural rules:**
- `betEvaluator.ts` is pure (no class, no DOM) — testable in Bun
- `RouletteGame.ts` manages state and calls the spin endpoint; the UI renderer is a separate class that reads game state and updates the DOM (same separation as blackjack/baccarat)
- No `DeckManager` — roulette has no deck
- No LLM module for MVP (issue doesn't require it; structure allows adding later)
- The spin endpoint is a thin Worker handler: authenticate, validate constraints, return `crypto.getRandomValues()` result. Chip mutation stays in the existing `/api/chips/update` pipeline

### Integration touchpoints (minimal changes to existing files)

1. `src/lib/game-stats/constants.ts` — add `'roulette'` to `GAME_TYPES`, `GAME_TYPE_LABELS`, `GAME_TYPE_ICONS`
2. `src/pages/api/chips/update.ts` — add `roulette` entry to `GAME_LIMITS`
3. `src/db/schema.ts` — update stale `gameStats` table comment (pre-existing, includes `'roulette'` while we're here)
4. `src/pages/index.astro` — already has the Roulette game card (no change needed)

## Bet Model

### Types (`types.ts`)

```typescript
export type BetType =
	| 'straight'    // Single number (0-36)
	| 'red'         // All red numbers
	| 'black'       // All black numbers
	| 'odd'         // 1,3,5,...,35
	| 'even'        // 2,4,6,...,36
	| 'low'         // 1-18
	| 'high'        // 19-36
	| 'dozen'       // 1st/2nd/3rd 12
	| 'column';     // 2:1 column (3 columns)

export interface RouletteBet {
	id: string;          // UUID for bet tracking
	type: BetType;
	amount: number;      // Chips wagered
	target?: number;     // For straight: 0-36. For dozen: 0|1|2 (index). For column: 0|1|2 (index).
}

export interface BetResult {
	bet: RouletteBet;
	won: boolean;
	payout: number;      // Total returned (stake + profit) for wins; 0 for losses
}

export interface SpinResult {
	winningNumber: number;
	bets: RouletteBet[];
	totalBet: number;
	totalPayout: number;
	netDelta: number;    // totalPayout - totalBet
	results: BetResult[];
	timestamp: number;
	syncId: string;
}

export type GamePhase = 'betting' | 'spinning' | 'settled';

export interface RouletteGameState {
	phase: GamePhase;
	activeBets: RouletteBet[];
	chipBalance: number;
	selectedChipAmount: number;
	lastSpin: SpinResult | null;
	roundHistory: SpinResult[];  // Last 20 rounds
	settings: RouletteSettings;
}

export interface RouletteSettings {
	animationSpeed: 'slow' | 'normal' | 'fast';
	soundEnabled: boolean;
}
```

The `target` field disambiguates within a type: `straight` needs the number (0-36), `dozen`/`column` need the index (0, 1, or 2). Outside bets (red/black/odd/even/low/high) have no target. When split/street/corner/line are added later, they become new `BetType` variants with their own `target` encoding — the evaluator just adds new cases.

### Wheel data (`constants.ts`)

```typescript
// European single-zero wheel order (clockwise from 0)
export const WHEEL_ORDER = [0, 32, 15, 19, 4, 21, 2, 25, 17, 34, 6, 27, 13, 36,
	11, 30, 8, 23, 10, 5, 24, 16, 33, 1, 20, 14, 31, 9, 22, 18, 29, 7, 28, 12, 35,
	3, 26] as const;

export const RED_NUMBERS = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
export const BLACK_NUMBERS = new Set([2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35]);

export const PAYOUT_MULTIPLIERS: Record<BetType, number> = {
	straight: 35,   // 35:1 (36x total return including stake)
	red: 1,         // 1:1
	black: 1,
	odd: 1,
	even: 1,
	low: 1,
	high: 1,
	dozen: 2,       // 2:1
	column: 2,
};

export const CHIP_DENOMINATIONS = [1, 5, 10, 25, 50, 100];
export const MIN_BET = 1;
export const MAX_BET_PER_POSITION = 500;
export const MAX_TOTAL_BET = 5000;
export const MAX_ROUND_HISTORY = 20;
```

## Settlement Logic (`betEvaluator.ts` — pure functions)

```typescript
export function doesBetWin(bet: RouletteBet, winningNumber: number): boolean {
	// 0 loses all outside bets; only straight-up 0 wins when the result is 0
	if (winningNumber === 0) {
		return bet.type === 'straight' && bet.target === 0;
	}
	switch (bet.type) {
		case 'straight': return bet.target === winningNumber;
		case 'red':      return RED_NUMBERS.has(winningNumber);
		case 'black':    return BLACK_NUMBERS.has(winningNumber);
		case 'odd':      return winningNumber % 2 === 1;
		case 'even':     return winningNumber % 2 === 0;
		case 'low':      return winningNumber >= 1 && winningNumber <= 18;
		case 'high':     return winningNumber >= 19 && winningNumber <= 36;
		case 'dozen':    return Math.ceil(winningNumber / 12) === (bet.target! + 1);
		case 'column':   return winningNumber % 3 === columnIndexToMod3(bet.target!);
	}
}

export function evaluateBets(bets: RouletteBet[], winningNumber: number): BetResult[] {
	return bets.map(bet => {
		const won = doesBetWin(bet, winningNumber);
		const multiplier = PAYOUT_MULTIPLIERS[bet.type];
		return {
			bet,
			won,
			// Payout = stake + profit. For wins: amount * (multiplier + 1).
			// For losses: 0. Stake was already deducted at spin time.
			payout: won ? bet.amount * (multiplier + 1) : 0,
		};
	});
}
```

**Payout convention:** `payout` is the total return (stake + profit). Since the stake was deducted at spin time, crediting `payout` to the balance gives the correct net: `netDelta = totalPayout - totalBet`. For a winning $1 straight bet: payout = $1 x (35 + 1) = $36 credited, minus $1 deducted = +$35 net. This matches the issue's "include returning the winning stake" requirement.

### Column index mapping

European roulette columns on the felt:
- Column 0 (index): top row = 3, 6, 9, ..., 36 (numbers where `n % 3 === 0`)
- Column 1 (index): middle row = 2, 5, 8, ..., 35 (numbers where `n % 3 === 2`)
- Column 2 (index): bottom row = 1, 4, 7, ..., 34 (numbers where `n % 3 === 1`)

```typescript
function columnIndexToMod3(index: number): number {
	// index 0 -> mod 0, index 1 -> mod 2, index 2 -> mod 1
	return [0, 2, 1][index];
}
```

## Game State Machine

### Phases

- **`betting`** — Table is interactive. Player can place, remove, and clear bets.
- **`spinning`** — Table locked. Spin endpoint called, wheel animating, waiting for result. No bet changes allowed.
- **`settled`** — Result displayed. "New Round" button returns to `betting`.

### `RouletteGame` class — key methods

```typescript
export class RouletteGame {
	private state: RouletteGameState;
	private lastSyncedBalance: number;

	// --- Betting ---
	canPlaceBet(type: BetType, amount: number, target?: number): { ok: boolean; error?: string }
		// Validates: amount >= MIN_BET, amount <= balance,
		// cumulative position total <= MAX_BET_PER_POSITION,
		// total bets <= MAX_TOTAL_BET

	placeBet(type: BetType, amount: number, target?: number): { success: boolean; error?: string }
		// Creates bet with UUID, pushes to activeBets
		// Does NOT deduct from balance yet (deduction at spin)

	removeBet(betId: string): { success: boolean; error?: string }
		// Removes bet from activeBets
		// Does NOT credit balance (was never deducted)

	clearBets(): void
		// Clears all activeBets

	// --- Spin ---
	async spin(): Promise<SpinResult>
		// 1. Validate: at least one bet, phase === 'betting'
		// 2. Generate syncId (crypto.randomUUID())
		// 3. Deduct totalBet from balance: state.chipBalance -= totalBet
		// 4. Persist round state to localStorage (phase: 'spinning', syncId, bets)
		// 5. POST /api/roulette/spin { syncId, totalBet, bets }
		//    (Guests skip this step and generate locally)
		// 6. Receive { winningNumber }
		// 7. Call settle(winningNumber)
		// 8. Persist round state to localStorage (phase: 'settled', full SpinResult)
		// 9. Trigger syncBalance() -- async, non-blocking
		// 10. Return SpinResult

	// --- Settlement ---
	private settle(winningNumber: number): SpinResult
		// evaluateBets(activeBets, winningNumber)
		// Credit totalPayout to balance
		// Move to roundHistory (last 20)
		// Clear activeBets, set phase = 'settled'

	// --- State management ---
	getState(): Readonly<RouletteGameState>
	getBalance(): number
	setBalance(n: number): void  // Server reconciliation
	restoreState(snapshot): boolean  // From localStorage on page load
}
```

### Round flow with refresh protection

```
Player clicks Spin
  |
  +- 1. Deduct totalBet locally
  +- 2. Persist { phase:'spinning', syncId, bets, totalBet } -> localStorage
  +- 3. POST /api/roulette/spin { syncId, totalBet, bets }
  |     +- Server: auth check, validate constraints, generate number, return it
  +- 4. settle(winningNumber) -> credit winnings
  +- 5. Persist { phase:'settled', spinResult } -> localStorage
  +- 6. POST /api/chips/update { delta: netDelta, gameType:'roulette', syncId, ... }
  |     +- Server: syncId idempotency via chip_sync_receipt, GAME_LIMITS check
  +- 7. On success: clear localStorage round state

REFRESH SCENARIOS:
  - During 'betting' (before spin): localStorage has { phase:'betting', activeBets }
    -> On reload: restore active bets to the table
    -> Bets were never deducted from balance (deduction happens at spin)
    -> Balance is server-authoritative (authenticated) or localStorage (guest)
    -> Safe: no void needed, player just resumes where they left off

  - During 'spinning' (step 2-4): localStorage has { phase:'spinning', syncId, bets }
    -> On reload: restore bets, but no chip sync happened -> balance is server-authoritative
    -> Bets are voided gracefully, player keeps their chips
    -> Show "Round interrupted" message, return to betting phase

  - During 'settled' (step 5-7): localStorage has { phase:'settled', spinResult }
    -> On reload: restore result display, retry chip sync with same syncId
    -> /api/chips/update idempotency ensures no double-credit
```

The key insight: chips are only mutated by `/api/chips/update`, which has its own `syncId` + `chip_sync_receipt` idempotency. The spin endpoint never touches chips. So the only window where a refresh matters is between deducting locally and syncing — and in that window, the server balance is untouched, so voiding the round is safe.

## Spin Endpoint (`src/pages/api/roulette/spin.ts`)

```typescript
export const POST: APIRoute = async ({ request, locals }) => {
	// 1. Auth check -- must be logged in
	if (!locals.user) return new Response('Unauthorized', { status: 401 });

	// 2. Parse + validate body
	// Validate: syncId (string, matches /^[A-Za-z0-9_-]{1,128}$/),
	//           totalBet (integer >= 1, <= MAX_TOTAL_BET),
	//           bets (array of valid RouletteBet objects, each amount >= MIN_BET)

	// 3. Validate bet constraints (mirror of client-side rules)
	//    - Each bet amount >= MIN_BET (1)
	//    - Per-position cumulative <= MAX_BET_PER_POSITION (500)
	//    - Total <= MAX_TOTAL_BET (5000)
	//    - At least one bet
	//    - Straight targets are 0-36, dozen/column targets are 0-2
	//    - Outside bet types (red/black/odd/even/low/high) must NOT carry a target;
	//      if present, reject (400) to prevent ambiguous payloads

	// 4. Generate winning number (unbiased)
	const buf = new Uint8Array(1);
	const LIMIT = 222; // 37 * 6 = 222, largest multiple of 37 under 256
	do {
		crypto.getRandomValues(buf);
	} while (buf[0] >= LIMIT);
	const winningNumber = buf[0] % 37;

	// 5. Return result (no chip mutation)
	return new Response(JSON.stringify({
		winningNumber,
		syncId: body.syncId,
		timestamp: Date.now(),
	}), { headers: { 'content-type': 'application/json' } });
};
```

The endpoint is **stateless** — no D1/KV writes. It validates constraints and returns a random number. The `syncId` is echoed back so the client can correlate request/response.

**Guest mode:** guests skip the spin endpoint entirely and generate the number locally with `crypto.getRandomValues()` (same algorithm). This matches how all other games handle guests — no server calls, localStorage-only balance.

**Unbiased random:** `crypto.getRandomValues(new Uint8Array(1))` returns 0–255. Using rejection sampling with limit 222 (37 x 6, the largest multiple of 37 under 256) eliminates modular bias.

## Chip Sync Integration

### Guest mode wiring

The page follows the exact pattern used by blackjack/baccarat/craps/slots. The `.astro` frontmatter uses `createPublicGameSession(user)` to produce `initialBalance`, `clientUserId`, `guestModeValue`, and `balanceAvailableValue`. These are rendered as `data-*` attributes on the root element:

```astro
---
import { createPublicGameSession } from '../../lib/public-game-session';
const user = Astro.locals.user;
const gameSession = createPublicGameSession(user);
const initialBalance = gameSession.initialBalance;
const clientUserId = gameSession.clientUserId;
---
<CasinoLayout title="Roulette - Arcturus Casino">
	<div
		id="roulette-root"
		data-user-id={clientUserId}
		data-guest-mode={gameSession.guestModeValue}
		data-initial-balance={initialBalance}
	>
```

The client (`rouletteClient.ts`) reads these attributes and uses the shared helpers from `public-game-session.ts`:

- `isGuestModeValue(root.dataset.guestMode)` — determines guest vs authenticated mode
- `loadGuestBankroll('roulette', userId, initialBalance)` — restores guest balance from localStorage on page load
- `persistGuestBankroll('roulette', userId, balance)` — saves guest balance after each round
- `shouldSyncAccountChips({ isGuestMode })` — gates whether to call `/api/chips/update` (guests never sync)

### Spin endpoint: guest skip

Guests skip the spin endpoint entirely and generate the number locally with the same unbiased algorithm (`crypto.getRandomValues` with rejection sampling). This matches how all other games handle guests — no server calls, localStorage-only balance.

### Sync flow (authenticated mode)

After settlement, the client syncs via the existing endpoint:

```typescript
POST /api/chips/update
{
	delta: netDelta,           // totalPayout - totalBet
	gameType: 'roulette',
	syncId: spinResult.syncId,
	previousBalance: lastSyncedBalance,
	outcome: netDelta > 0 ? 'win' : netDelta < 0 ? 'loss' : 'push'
}
```

Roulette uses `handCount: 1` (one spin = one round) and does not use `statsDelta` or batching.

### Sync retry and reconciliation

Roulette follows the **baccarat sync pattern** (simpler than craps — no batching, no `statsDelta`, no `pendingRollSyncs` coalescing). The `syncBalance()` function in `rouletteClient.ts` handles:

- **`RATE_LIMITED` (429)**: retry after the `Retry-After` header delay (or 2s default)
- **`BALANCE_MISMATCH` (409)**: rebase `lastSyncedBalance` to the server's `currentBalance`, keep the pending sync for retry
- **`DELTA_EXCEEDS_LIMIT` (400)**: unrecoverable — log error, clear pending sync, show user message (matches craps' unrecoverable 4xx path)
- **5xx server errors**: exponential backoff retry (base 2s, max 30s)
- **Network errors** (`TypeError` from `fetch`): exponential backoff retry
- **Success**: apply server-authoritative balance via `game.setBalance(serverBalance)`, clear pending round from localStorage, dispatch achievement toast if `newAchievements` returned

The pending round state (including `syncId` and full `SpinResult`) is persisted to localStorage until the chip sync succeeds. On page refresh, if a settled-but-unsynced round exists, `rouletteClient.ts` retries the sync with the same `syncId` — the `chip_sync_receipt` idempotency check ensures no double-credit.

### Changes to existing files

**1. `src/pages/api/chips/update.ts`** — add to `GAME_LIMITS`:

```typescript
roulette: {
	// Straight-up 35:1 on max per-position bet (500) = 17,500 profit.
	// Multiple winning positions possible (straight + outside bets on same number),
	// but heavy coverage reduces variance. 50k headroom is generous.
	maxWin: 50000,
	// MAX_TOTAL_BET is 5000 -- maxLoss covers the full-table-bet edge case
	// plus margin for balance rounding.
	maxLoss: 10000,
},
```

**2. `src/lib/game-stats/constants.ts`** — add `'roulette'` to all three registries:

```typescript
export const GAME_TYPES = ['blackjack', 'baccarat', 'craps', 'poker', 'slots', 'roulette'] as const;

export const GAME_TYPE_LABELS = {
	// ...existing...
	roulette: 'Roulette',
};

export const GAME_TYPE_ICONS = {
	// ...existing...
	roulette: '\u{1F3AB}', // 🎫 ticket/admission — closest available roulette emoji
};
```

No changes to `/api/chips/update.ts` logic itself — the existing `syncId` + `chip_sync_receipt` idempotency, `GAME_LIMITS` validation, and achievement checking all work as-is for roulette.

**3. `src/db/schema.ts`** — the `gameStats` table has a stale comment at `schema.ts:118` listing only `'poker' | 'blackjack' | 'baccarat'`. This is pre-existing (not introduced by this spec) but should be updated to include `'craps' | 'slots' | 'roulette'` while we're touching the game type registries.

## UI Design

### Page layout (`roulette.astro`)

```
+-------------------------------------------+
|  CasinoLayout (balance, nav, achievements)|
+----------------------+--------------------+
|                      |  Chip Balance: $1000|
|    ROULETTE WHEEL    |  Total Bet:  $0     |
|    (animated SVG)    |                     |
|                      |  Chip Selector:     |
|   Last: [17 Red]     |  [1][5][10][25]...  |
|                      |                     |
+----------------------+  Active Bets:       |
|  BETTING TABLE       |  - Straight 17: $25 |
|  (number grid +      |  - Red: $10         |
|   outside bets)      |  - Dozen 2: $50     |
|                      |                     |
|                      |  [Clear]  [Spin]    |
+----------------------+--------------------+
        [?] Rules/Help Panel (collapsible)
```

### Wheel component (CSS/SVG)

The wheel is a **static SVG** with 37 pocket segments (red, black, green for 0), rendered once. Animation is a **CSS `transform: rotate()` transition** on the wheel container:

1. Before spin: wheel at rest
2. On spin: compute target rotation = `fullRotations (5 turns) + pocketAngle(winningNumber)`
3. Apply `transition: transform 4s cubic-bezier(...)` for smooth deceleration
4. After transition: highlight the winning pocket, dim others

The pocket angle for each number is derived from its position in `WHEEL_ORDER`:

```typescript
const SEGMENT = 360 / 37; // degrees per pocket
const pocketIndex = WHEEL_ORDER.indexOf(winningNumber);
const pocketAngle = -(pocketIndex * SEGMENT); // negative = clockwise

// CRITICAL: use cumulative rotation, not absolute. CSS transitions take the
// shortest path between two rotation values, so an absolute target would cause
// the wheel to spin backwards on the 2nd+ spin (e.g. from 2140deg back to 1820deg).
// Instead, always add 5 full turns forward from the current rotation.
const currentRotation = wheelEl.dataset.rotation ?? 0;
const targetRotation = Number(currentRotation) + 1800 + pocketAngle;
wheelEl.style.transform = `rotate(${targetRotation}deg)`;
wheelEl.dataset.rotation = String(targetRotation);
```

A fixed pointer/marker at the top of the wheel indicates the result.

### Betting table

Two zones, following standard European roulette felt layout:

**Inside bets area** — 3x12 grid of numbers (1-36) with 0 to the left:

```
 +----+----------------------------------------------+
 | 0  | 3  6  9  12 15 18 21 24 27 30 33 36 | 2:1 |
 |    | 2  5  8  11 14 17 20 23 26 29 32 35 | 2:1 |
 |    | 1  4  7  10 13 16 19 22 25 28 31 34 | 2:1 |
 +----+----------------------------------------------+
```

Clicking a number places a straight-up bet. Column "2:1" buttons at the right edge place column bets.

**Outside bets area** — below the grid:

```
[1st 12] [2nd 12] [3rd 12]          <- dozen bets
[1-18] [Even] [Red] [Black] [Odd] [19-36]  <- even-money bets
```

### Interaction model

- **Select chip denomination** — highlights active denomination (default: 5)
- **Click table position** — places a bet of the selected denomination on that position. If a bet already exists for that position (same type + target), the amount is added to it rather than creating a separate bet. This keeps one bet per position, simplifying per-position max checks and payout display.
- **Right-click or click active bet in sidebar** — removes the entire bet for that position
- **Clear button** — removes all bets, returns to clean state
- **Spin button** — disabled if no bets placed or insufficient balance. Locks table on click.

### Responsive behavior

- **Desktop**: wheel left, controls/table right (side-by-side)
- **Mobile**: stacked vertically — wheel on top (smaller), table + controls below. Table scrolls horizontally if needed. Chip selector wraps.

### Rules/Help panel

Collapsible section at the bottom with bet type explanations and payout table:

| Bet Type | Pays | Example |
|---|---|---|
| Straight Up | 35:1 | Bet on number 17 |
| Red/Black | 1:1 | All red numbers |
| Odd/Even | 1:1 | 1, 3, 5, ... |
| 1-18 / 19-36 | 1:1 | Low or High |
| Dozen | 2:1 | 1st, 2nd, or 3rd 12 |
| Column | 2:1 | 2:1 column button |

Plus a note: *"0 is green. Outside bets lose when 0 hits."*

### `data-testid` inventory

Stable selectors for E2E tests:

| Test ID | Element |
|---|---|
| `roulette-root` | Page root container |
| `roulette-wheel` | Wheel SVG container |
| `wheel-result` | Winning number display |
| `betting-table` | Betting table container |
| `position-{type}-{target}` | Each bettable position (e.g. `position-straight-17`, `position-red`, `position-dozen-1`, `position-column-0`) |
| `chip-{value}` | Chip denomination selector buttons (e.g. `chip-1`, `chip-5`, `chip-100`) |
| `active-bets` | Active bets sidebar container |
| `active-bet-{id}` | Individual active bet entry |
| `total-bet` | Total bet display |
| `chip-balance` | Chip balance display |
| `spin-button` | Spin button |
| `clear-bets-button` | Clear bets button |
| `new-round-button` | New round button (settled phase) |
| `rules-panel` | Rules/help panel container |
| `rules-toggle` | Rules panel expand/collapse button |

### Accessibility

- **Wheel result**: `aria-live="polite"` on the `wheel-result` element so screen readers announce the winning number after each spin
- **Betting table**: keyboard-navigable grid (`role="grid"`, `role="gridcell"`), Enter/Space to place a bet on the focused cell
- **Chip selectors**: standard `<button>` elements, focusable, `aria-pressed` to indicate selected denomination
- **Phase announcements**: `aria-live="polite"` region for phase transitions ("Betting open", "No more bets", "17 Red")
- **Spin/clear buttons**: `aria-disabled` when action unavailable; `aria-busy` on the table during spin

## Testing Strategy

### Unit tests (Bun, pure functions)

**`betEvaluator.test.ts`** — the core settlement correctness tests:
- Every straight-up number 0-36: correct win/lose for matching/non-matching bets
- Red/black: all 18 red numbers win red bets, all 18 black win black bets
- Odd/even: correct classification, 0 loses
- Low/high: boundary checks (1 wins low, 18 wins low, 19 wins high, 36 wins high)
- Dozen: each dozen index, boundary numbers (12 -> 1st dozen, 13 -> 2nd dozen)
- Column: each column index, all three columns
- **0 handling**: straight-up 0 wins on 0, all outside bets lose on 0, straight-up non-0 loses on 0
- Payout correctness: 35:1 returns 36x stake, 2:1 returns 3x, 1:1 returns 2x
- Mixed bets on same spin: multiple wins, multiple losses, all-win, all-lose
- Payout includes stake return (netDelta = payout - totalBet, not payout - 2*totalBet)

**`RouletteGame.test.ts`** — state management and validation:
- `canPlaceBet`: rejects below min (0), rejects above balance, rejects above per-position max, rejects above total max
- `placeBet`: creates bet with valid UUID, amount matches
- `removeBet`: returns correct bet, balance unaffected (bets not deducted until spin)
- `clearBets`: clears all, balance unaffected
- `spin` phase enforcement: can't spin with no bets, can't spin twice
- **Duplicate settlement protection**: settling twice with same winning number doesn't double-credit
- `restoreState`: round-trip serialize/deserialize preserves all fields, rejects corrupted data
- Guest vs authenticated: spin endpoint call skipped for guests

### Integration tests

**Spin endpoint tests:**
- Returns 401 without auth
- Returns 400 for invalid body (missing syncId, bad bets, totalBet < 1)
- Returns winningNumber 0-36
- syncId echoed back
- Rejects totalBet > MAX_TOTAL_BET

**Chip sync tests:**
- Roulette gameType accepted in GAME_LIMITS
- Roulette win/loss/push syncs work with syncId idempotency

### E2E tests (`e2e/roulette.spec.ts`)

Following the established Playwright pattern with shared auth state:
- **Basic flow**: select chip -> place straight-up bet -> spin -> verify result display -> verify balance changes
- **Outside bet**: place red bet, spin, verify win/lose correctly
- **Clear bets**: place multiple bets -> clear -> verify all removed, balance unchanged
- **0 result**: (mock or retry until 0) verify outside bets lose
- **Insufficient balance**: try placing bet above balance -> verify rejection
- **Responsive**: test at mobile viewport, verify layout stacks
- **Rules panel**: open help, verify bet types and payouts listed

### Test coverage map to acceptance criteria

| Acceptance Criteria | Covered By |
|---|---|
| `/games/roulette` shows complete UI | E2E basic flow |
| Place/remove/clear bets | Unit (RouletteGame) + E2E |
| Min bet / max balance validation | Unit (canPlaceBet) |
| Deduct total bet once | Unit (spin method) |
| Credit payout once | Unit (settle) |
| Wheel matches winning number | E2E visual check |
| Outside bets lose on 0 | Unit (betEvaluator, 0 cases) |
| No duplicate settlement | Unit (restoreState) + chip sync idempotency tests |
| Unit tests for all bet types | betEvaluator.test.ts |
| Responsive layout | E2E responsive test |

## Future Extensibility

The bet model is designed so that split, street, corner, and line bets can be added without changing the settlement architecture:

1. Add new `BetType` variants: `'split' | 'street' | 'corner' | 'line'`
2. Define `target` encoding for each (e.g., split = lower of two adjacent numbers; street = first number of the row)
3. Add `doesBetWin` cases for each new type — pure function, no architecture change
4. Add `PAYOUT_MULTIPLIERS` entries: split 17:1, street 11:1, corner 8:1, line 5:1
5. Wire up table click zones for the new positions

The spin endpoint, chip sync, and game state machine all remain unchanged.

## Payout Rules Summary

| Bet Type | Multiplier | Total Return (per $1 stake) | Notes |
|---|---|---|---|
| Straight Up | 35:1 | $36 | Win only on exact number |
| Red/Black | 1:1 | $2 | Lose on 0 |
| Odd/Even | 1:1 | $2 | Lose on 0 |
| Low (1-18) / High (19-36) | 1:1 | $2 | Lose on 0 |
| Dozen (1st/2nd/3rd 12) | 2:1 | $3 | Lose on 0 |
| Column | 2:1 | $3 | Lose on 0 |

All outside bets (red, black, odd, even, low, high, dozen, column) lose when the winning number is 0. Only a straight-up bet on 0 wins when 0 is the result.
