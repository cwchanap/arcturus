# HPA-198 Three-Card Showdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused Three-Card Showdown game with Ante → Fold/Play gameplay, a minimal shared card/deck primitive, guest-local bankrolls, and the existing authenticated wallet-settlement flow.

**Architecture:** Extract Video Poker's standard 52-card type/deck helper into `src/lib/cards.ts`, then build a self-contained `src/lib/three-card-showdown` rules/state module. The Astro page/client composes existing `CardSlot`, public-game session, wager validation, and wallet gate/recovery APIs; no server route or persistence is added.

**Tech Stack:** Astro 5, TypeScript, Bun tests, Happy DOM, Playwright, existing Cloudflare Worker/D1 wallet APIs.

## Global Constraints

- Hand order is `Straight Flush > Three of a Kind > Straight > Flush > Pair > High Card`.
- `A-K-Q` is highest straight; `A-2-3` is lowest; `K-A-2` is not a straight.
- Dealer qualifies with Queen-high or better.
- MVP has Ante + equal Play only. No Ante Bonus, Pair Plus, Hand Bonus, side bet, AI, ranked mode, history, or replay.
- `MIN_ANTE = 1`, `MAX_ANTE = 100`, `ANTE_OPTIONS = [1, 5, 10, 25, 50, 100]`.
- Deal requires `2 * ante <= balance`, so Play is always affordable after Deal.
- Guest completion is local-only. Authenticated Fold/Play submits exactly one net wallet settlement through the existing gate.
- Register exact label `Three-Card Showdown` and icon `♠️`.
- No database migration, new API endpoint, automatic retry, persisted settlement queue, compatibility alias, generic evaluator, base game class, generic client controller, or Texas Hold'em refactor.

---

## Task 1: Extract the neutral 52-card primitive and keep Video Poker behavior unchanged

**Files:**
- Create: `src/lib/cards.ts`
- Create: `src/lib/cards.test.ts`
- Delete: `src/lib/video-poker/cards.ts`
- Delete: `src/lib/video-poker/cards.test.ts`
- Modify: `src/lib/video-poker/types.ts`
- Modify: `src/lib/video-poker/game.ts`
- Modify: `src/lib/video-poker/client.ts`
- Modify: `src/lib/video-poker/index.ts`
- Modify: any `src/lib/video-poker/*.test.ts` importing the removed local card file/type

**Interfaces:**
- Produces:

```ts
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export interface Card { rank: Rank; suit: Suit }
export function createDeck(): Card[];
export function shuffleDeck(deck: readonly Card[], random?: () => number): Card[];
export function createShuffledDeck(random?: () => number): Card[];
```

- Consumed by: Video Poker and Tasks 2-3.

- [ ] **Step 1: Write the shared deck tests first**

Create `src/lib/cards.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createDeck, shuffleDeck } from './cards';

describe('shared cards', () => {
  test('creates all 52 unique cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((card) => `${card.rank}-${card.suit}`)).size).toBe(52);
    expect(new Set(deck.map((card) => card.suit))).toEqual(
      new Set(['hearts', 'diamonds', 'clubs', 'spades']),
    );
  });

  test('shuffle is injectable and does not mutate the source', () => {
    const deck = createDeck();
    const snapshot = deck.map((card) => ({ ...card }));
    const shuffled = shuffleDeck(deck, () => 0);

    expect(deck).toEqual(snapshot);
    expect(shuffled).toHaveLength(52);
    expect(shuffled.slice(0, 6)).toEqual([
      { rank: 3, suit: 'hearts' },
      { rank: 4, suit: 'hearts' },
      { rank: 5, suit: 'hearts' },
      { rank: 6, suit: 'hearts' },
      { rank: 7, suit: 'hearts' },
      { rank: 8, suit: 'hearts' },
    ]);
  });
});
```

- [ ] **Step 2: Verify the test fails before the shared module exists**

Run:

```bash
bun test src/lib/cards.test.ts
```

Expected: FAIL because `src/lib/cards.ts` is missing.

- [ ] **Step 3: Move the exact neutral implementation into `src/lib/cards.ts`**

```ts
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

export function shuffleDeck(deck: readonly Card[], random: () => number = Math.random): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function createShuffledDeck(random: () => number = Math.random): Card[] {
  return shuffleDeck(createDeck(), random);
}
```

Do not add a barrel, RNG interface, shoe, discard pile, formatter, or evaluator.

- [ ] **Step 4: Point Video Poker at `../cards` and delete its duplicate**

Use:

```ts
// src/lib/video-poker/types.ts
import type { Card } from '../cards';
```

Remove the local `Suit`, `Rank`, and `Card` declarations.

Use:

```ts
// src/lib/video-poker/game.ts
import { createShuffledDeck, type Card } from '../cards';
```

Use:

```ts
// src/lib/video-poker/client.ts
import type { Card } from '../cards';
```

Remove `Card` from `src/lib/video-poker/index.ts`'s type exports. Update focused tests that imported `./cards` to import `../cards`.

Delete:

```text
src/lib/video-poker/cards.ts
src/lib/video-poker/cards.test.ts
```

Do not add a compatibility re-export.

- [ ] **Step 5: Run shared-card and all Video Poker tests**

```bash
bun test src/lib/cards.test.ts src/lib/video-poker/
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/lib/cards.ts src/lib/cards.test.ts src/lib/video-poker
git commit -m "refactor(cards): share neutral deck primitive"
```

---

## Task 2: Implement three-card ranking, comparison, qualification, and payouts

**Files:**
- Create: `src/lib/three-card-showdown/types.ts`
- Create: `src/lib/three-card-showdown/rules.ts`
- Create: `src/lib/three-card-showdown/rules.test.ts`

**Interfaces:**
- Consumes: `Card` from `src/lib/cards.ts`.
- Produces:

```ts
export const MIN_ANTE = 1;
export const MAX_ANTE = 100;
export const ANTE_OPTIONS = [1, 5, 10, 25, 50, 100] as const;
export function evaluateThreeCardHand(cards: readonly Card[]): ThreeCardHandEvaluation;
export function compareThreeCardHands(left: ThreeCardHandEvaluation, right: ThreeCardHandEvaluation): -1 | 0 | 1;
export function dealerQualifies(evaluation: ThreeCardHandEvaluation): boolean;
export function resolvePlayedHand(playerCards: readonly Card[], dealerCards: readonly Card[], ante: number): ThreeCardShowdownRoundResult;
```

- [ ] **Step 1: Create the domain types**

`src/lib/three-card-showdown/types.ts`:

```ts
import type { Card } from '../cards';

export type ThreeCardHandCategory =
  | 'straight-flush'
  | 'three-of-kind'
  | 'straight'
  | 'flush'
  | 'pair'
  | 'high-card';

export interface ThreeCardHandEvaluation {
  category: ThreeCardHandCategory;
  label: string;
  tieBreakers: readonly number[];
}

export type ThreeCardShowdownPhase = 'betting' | 'decision' | 'complete';
export type ThreeCardShowdownOutcome =
  | 'fold'
  | 'dealer-not-qualified'
  | 'player-win'
  | 'tie'
  | 'dealer-win';

export interface ThreeCardShowdownRoundResult {
  outcome: ThreeCardShowdownOutcome;
  ante: number;
  totalWager: number;
  grossPayout: number;
  netDelta: number;
  dealerQualified: boolean;
  playerHand: readonly Card[];
  dealerHand: readonly Card[];
  playerEvaluation: ThreeCardHandEvaluation;
  dealerEvaluation: ThreeCardHandEvaluation;
}

export interface ThreeCardShowdownState {
  phase: ThreeCardShowdownPhase;
  balance: number;
  ante: number;
  playerHand: readonly Card[];
  dealerHand: readonly Card[];
  result: ThreeCardShowdownRoundResult | null;
}
```

- [ ] **Step 2: Write failing category/tie-break tests**

Use a local helper:

```ts
const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });
```

Pin the non-five-card ordering:

```ts
expect(compareThreeCardHands(
  evaluateThreeCardHand([card(9, 'hearts'), card(8, 'clubs'), card(7, 'spades')]),
  evaluateThreeCardHand([card(14, 'diamonds'), card(9, 'diamonds'), card(4, 'diamonds')]),
)).toBe(1); // Straight beats Flush.
```

Pin straight edge cases:

```ts
expect(evaluateThreeCardHand([
  card(14, 'hearts'), card(13, 'clubs'), card(12, 'spades'),
]).tieBreakers).toEqual([14]);

expect(evaluateThreeCardHand([
  card(14, 'hearts'), card(2, 'clubs'), card(3, 'spades'),
]).tieBreakers).toEqual([3]);

expect(evaluateThreeCardHand([
  card(13, 'hearts'), card(14, 'clubs'), card(2, 'spades'),
]).category).toBe('high-card');
```

Also test Trips, Pair kicker, Flush/High Card lexicographic comparison, and identical-rank hands with different suits comparing equal.

- [ ] **Step 3: Run rules tests and verify failure**

```bash
bun test src/lib/three-card-showdown/rules.test.ts
```

Expected: FAIL because `rules.ts` is not implemented.

- [ ] **Step 4: Implement category evaluation with one fixed strength table**

```ts
const CATEGORY_STRENGTH: Record<ThreeCardHandCategory, number> = {
  'high-card': 0,
  pair: 1,
  flush: 2,
  straight: 3,
  'three-of-kind': 4,
  'straight-flush': 5,
};
```

Implementation must:

- require exactly three cards;
- sort ranks descending;
- treat `14, 3, 2` as A-2-3 with straight-high 3;
- treat ordinary consecutive ranks with `r0 === r1 + 1 && r1 === r2 + 1`;
- detect flush from equal suits;
- detect Pair/Trips from rank counts;
- return tie breakers exactly as specified in the design.

- [ ] **Step 5: Add and implement the Queen-high qualification boundary**

Tests:

```ts
expect(dealerQualifies(evaluateThreeCardHand([
  card(12, 'hearts'), card(7, 'clubs'), card(2, 'spades'),
]))).toBe(true);

expect(dealerQualifies(evaluateThreeCardHand([
  card(11, 'hearts'), card(10, 'clubs'), card(8, 'spades'),
]))).toBe(false);
```

Implementation: any Pair-or-better category qualifies; High Card qualifies when `tieBreakers[0] >= 12`.

- [ ] **Step 6: Add payout tests for all four Play outcomes**

Use Ante 10 and fixed hands. Assert:

```ts
expect(notQualified).toMatchObject({
  outcome: 'dealer-not-qualified',
  totalWager: 20,
  grossPayout: 30,
  netDelta: 10,
  dealerQualified: false,
});

expect(playerWin).toMatchObject({
  outcome: 'player-win', grossPayout: 40, netDelta: 20, dealerQualified: true,
});
expect(tie).toMatchObject({
  outcome: 'tie', grossPayout: 20, netDelta: 0, dealerQualified: true,
});
expect(dealerWin).toMatchObject({
  outcome: 'dealer-win', grossPayout: 0, netDelta: -20, dealerQualified: true,
});
```

- [ ] **Step 7: Implement `resolvePlayedHand()` without bankroll logic**

Evaluate both hands, determine dealer qualification, compare qualified hands, and return frozen copies. Do not mutate either input.

- [ ] **Step 8: Run Task 2 tests**

```bash
bun test src/lib/three-card-showdown/rules.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/lib/three-card-showdown/types.ts src/lib/three-card-showdown/rules.ts src/lib/three-card-showdown/rules.test.ts
git commit -m "feat(three-card-showdown): add hand rules"
```

---

## Task 3: Implement the pure bankroll/deal/decision state machine

**Files:**
- Create: `src/lib/three-card-showdown/game.ts`
- Create: `src/lib/three-card-showdown/game.test.ts`

**Interfaces:**
- Consumes: shared `createShuffledDeck()`, `validateBet()`, Task 2 constants/rules/types.
- Produces:

```ts
export class ThreeCardShowdownGame {
  constructor(initialBalance: number, random?: () => number);
  getState(): Readonly<ThreeCardShowdownState>;
  getAnteError(ante: number): string | null;
  setAnte(ante: number): void;
  deal(): void;
  fold(): ThreeCardShowdownRoundResult;
  play(): ThreeCardShowdownRoundResult;
  resetRound(): void;
  setBalance(balance: number): void;
}
```

- [ ] **Step 1: Write failing initial/deal tests**

```ts
const game = new ThreeCardShowdownGame(100, () => 0);
expect(game.getState()).toMatchObject({ phase: 'betting', balance: 100, ante: 1 });

game.setAnte(10);
game.deal();
expect(game.getState().phase).toBe('decision');
expect(game.getState().balance).toBe(90);
expect(game.getState().playerHand).toEqual([
  { rank: 3, suit: 'hearts' },
  { rank: 4, suit: 'hearts' },
  { rank: 5, suit: 'hearts' },
]);
expect(game.getState().dealerHand).toEqual([
  { rank: 6, suit: 'hearts' },
  { rank: 7, suit: 'hearts' },
  { rank: 8, suit: 'hearts' },
]);
```

- [ ] **Step 2: Pin Ante validation and two-unit affordability**

```ts
const game = new ThreeCardShowdownGame(15);
expect(game.getAnteError(10)).toBe('Ante plus Play wager exceeds available balance');
expect(() => game.setAnte(10)).toThrow('Ante plus Play wager exceeds available balance');
```

Also test non-integer, 0, and 101.

- [ ] **Step 3: Add Fold accounting test**

With balance 100 / Ante 10:

```ts
game.deal();
const result = game.fold();
expect(result).toMatchObject({
  outcome: 'fold', totalWager: 10, grossPayout: 0, netDelta: -10,
});
expect(game.getState()).toMatchObject({ phase: 'complete', balance: 90 });
```

- [ ] **Step 4: Add deterministic Play accounting test**

With `random = () => 0`, player has 3♥4♥5♥ and dealer 6♥7♥8♥, so the dealer wins.

```ts
const game = new ThreeCardShowdownGame(100, () => 0);
game.setAnte(10);
game.deal();
const result = game.play();
expect(result).toMatchObject({
  outcome: 'dealer-win',
  totalWager: 20,
  grossPayout: 0,
  netDelta: -20,
  dealerQualified: true,
});
expect(game.getState()).toMatchObject({ phase: 'complete', balance: 80 });
```

Add one fixture for dealer-not-qualified to assert stake-credit order: 100 → 90 after Deal → 80 after Play stake → 110 after gross payout 30.

- [ ] **Step 5: Run the game tests and verify they fail**

```bash
bun test src/lib/three-card-showdown/game.test.ts
```

Expected: FAIL because `game.ts` is missing.

- [ ] **Step 6: Implement balance normalization and cloning**

Use:

```ts
function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new RangeError('Balance must be a non-negative finite number');
  }
  return Math.trunc(balance);
}
```

`getState()` and returned results must clone hands/evaluations/tie-breaker arrays so callers cannot mutate internal state.

- [ ] **Step 7: Implement `getAnteError()` / `setAnte()`**

Validation order:

1. `Number.isInteger(ante)` else `Ante must be a whole number of chips`;
2. `validateBet(ante, MIN_ANTE, MAX_ANTE)`;
3. `ante * 2 > balance` else `Ante plus Play wager exceeds available balance`.

`setAnte()` is allowed only in `betting`.

- [ ] **Step 8: Implement `deal()`**

Require `betting`, re-check current Ante, create one shuffled deck, take first 3 player + next 3 dealer cards, deduct one Ante, enter `decision`.

- [ ] **Step 9: Implement `fold()` and `play()`**

`fold()`:

- require `decision`;
- evaluate both dealt hands for frozen result data;
- do not deduct a second wager;
- create Fold result and enter `complete`.

`play()`:

- require `decision`;
- subtract the second Ante;
- call `resolvePlayedHand()`;
- credit `grossPayout`;
- enter `complete`.

Both return cloned results and resolve only once.

- [ ] **Step 10: Implement `resetRound()` / `setBalance()` and invalid-transition tests**

`resetRound()` requires `complete`, clears both hands/result, retains selected Ante, returns to `betting`.

`setBalance()` normalizes and changes only balance.

Assert Deal twice, Fold/Play before Deal, Fold/Play twice, and New Round before completion all throw.

- [ ] **Step 11: Run Task 3 tests**

```bash
bun test src/lib/three-card-showdown/game.test.ts src/lib/three-card-showdown/rules.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit Task 3**

```bash
git add src/lib/three-card-showdown/game.ts src/lib/three-card-showdown/game.test.ts
git commit -m "feat(three-card-showdown): add pure game state"
```

---

## Task 4: Register the game and add the page/client on existing shared seams

**Files:**
- Create: `src/lib/three-card-showdown/client.ts`
- Create: `src/lib/three-card-showdown/client.test.ts`
- Create: `src/lib/three-card-showdown/client.init.test.ts`
- Create: `src/lib/three-card-showdown/index.ts`
- Create: `src/pages/games/three-card-showdown.astro`
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.test.ts`
- Modify: `src/pages/index.astro`

**Interfaces:**
- Consumes: Tasks 1-3, `createPublicGameSession`, `CardSlot`, `setSlotState`, wallet gate/recovery API.
- Produces:

```ts
export function buildThreeCardShowdownSettlementCommand(
  settlementId: string,
  result: Pick<ThreeCardShowdownRoundResult, 'netDelta'>,
): SettleRoundCommand;
export function initThreeCardShowdownClient(): void;
```

- [ ] **Step 1: Register the exact game type and pin it with a focused test**

Append `three-card-showdown` to `GAME_TYPES` and add:

```ts
GAME_TYPE_LABELS['three-card-showdown'] = 'Three-Card Showdown';
GAME_TYPE_ICONS['three-card-showdown'] = '♠️';
```

Add to `src/lib/game-stats/game-stats.test.ts`:

```ts
test('registers Three-Card Showdown as a valid game type', () => {
  expect(isValidGameType('three-card-showdown')).toBe(true);
  expect(GAME_TYPE_LABELS['three-card-showdown']).toBe('Three-Card Showdown');
  expect(GAME_TYPE_ICONS['three-card-showdown']).toBe('♠️');
});
```

Run:

```bash
bun test src/lib/game-stats/game-stats.test.ts
```

Expected: PASS.

- [ ] **Step 2: Write settlement-command mapping tests**

Create `client.test.ts` and assert loss/win/tie:

```ts
expect(buildThreeCardShowdownSettlementCommand('three-card-1', { netDelta: -20 })).toEqual({
  settlementId: 'three-card-1',
  game: 'three-card-showdown',
  delta: -20,
  stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0 },
});

expect(buildThreeCardShowdownSettlementCommand('three-card-2', { netDelta: 20 }).stats)
  .toEqual({ rounds: 1, wins: 1, losses: 0, biggestWin: 20 });

expect(buildThreeCardShowdownSettlementCommand('three-card-3', { netDelta: 0 }).stats)
  .toEqual({ rounds: 1, wins: 0, losses: 0, biggestWin: 0 });
```

- [ ] **Step 3: Implement the game-local command builder**

```ts
export function buildThreeCardShowdownSettlementCommand(
  settlementId: string,
  result: Pick<ThreeCardShowdownRoundResult, 'netDelta'>,
): SettleRoundCommand {
  return {
    settlementId,
    game: 'three-card-showdown',
    delta: result.netDelta,
    stats: {
      rounds: 1,
      wins: result.netDelta > 0 ? 1 : 0,
      losses: result.netDelta < 0 ? 1 : 0,
      biggestWin: Math.max(result.netDelta, 0),
    },
  };
}
```

Do not move this into `wallet`.

- [ ] **Step 4: Create the Astro page with six existing `CardSlot`s**

Use `CasinoLayout` and `createPublicGameSession(Astro.locals.user)`.

Required stable IDs:

```text
three-card-showdown-root
chip-balance
three-card-showdown-status
three-card-showdown-result
three-card-showdown-dealer-slot-0
three-card-showdown-dealer-slot-1
three-card-showdown-dealer-slot-2
three-card-showdown-player-slot-0
three-card-showdown-player-slot-1
three-card-showdown-player-slot-2
three-card-showdown-deal
three-card-showdown-fold
three-card-showdown-play
three-card-showdown-new-round
three-card-showdown-recovery-host
```

Ante buttons use `[data-ante]` and are generated from `ANTE_OPTIONS`.

Static rules copy lists the exact hand order and `Dealer qualifies with Queen-high or better.`

- [ ] **Step 5: Implement client session/card rendering**

Use:

```ts
const GAME_KEY = 'three-card-showdown';
const startingBalance = isGuestMode
  ? loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)
  : initialBalance;
const game = new ThreeCardShowdownGame(startingBalance);
const gate = createSettlementGate();
let serverSyncedBalance = startingBalance;
```

Use local rank formatting `11→J`, `12→Q`, `13→K`, `14→A` and existing:

```ts
setSlotState(slot, 'card', { rank: rankLabel(card.rank), suit: card.suit });
```

Dealer slots:

```text
betting -> placeholder
decision -> facedown
complete -> card
```

Player slots:

```text
betting -> placeholder
decision/complete -> card
```

- [ ] **Step 6: Implement exact phase buttons and result copy**

Visibility:

```text
betting  -> Deal
decision -> Fold + Play
complete -> New Round
```

Result text:

```ts
switch (result.outcome) {
  case 'fold': return `Fold · -${result.ante} net`;
  case 'dealer-not-qualified': return `Dealer does not qualify · +${result.ante} net`;
  case 'player-win': return `Player wins · +${result.netDelta} net`;
  case 'tie': return 'Tie · 0 net';
  case 'dealer-win': return `Dealer wins · ${result.netDelta} net`;
}
```

Deal renders `getAnteError()` and never relies on catch for expected affordability errors.

- [ ] **Step 7: Wire guest completion and authenticated settlement**

Fold/Play completion:

1. call pure `fold()` or `play()`;
2. render completed round;
3. guest: `persistGuestBankroll(GAME_KEY, clientUserId, game.getState().balance)` and make no wallet call;
4. authenticated: call

```ts
gate.settle(
  buildThreeCardShowdownSettlementCommand(
    newSettlementId('three-card-showdown'),
    round,
  ),
);
```

5. successful settlement adopts `result.balance` through `game.setBalance()` and updates both balance surfaces.

New Round is disabled whenever authenticated `gate.isBlocked`.

- [ ] **Step 8: Reuse existing Retry/Reset controls**

Use exact IDs:

```text
three-card-showdown-settlement-recovery
three-card-showdown-retry-settlement
three-card-showdown-reset-settlement
```

Retry disables Retry+Reset while `gate.retry()` is in flight, then adopts the returned balance.

Reset:

```ts
gate.reset();
game.setBalance(serverSyncedBalance);
if (game.getState().phase === 'complete') game.resetRound();
```

Then hide recovery and render betting state.

- [ ] **Step 9: Add focused Happy DOM composition tests**

`client.init.test.ts` must cover:

- guest Deal: player slots become `card`, dealer slots become `facedown`;
- deterministic guest Play with `Math.random=0`: result `Dealer wins · -20 net`, balance 980 from a 1000 start / Ante 10, dealer slots reveal, guest storage is written, no wallet fetch;
- authenticated 503 settlement: recovery visible and New Round disabled;
- Retry: second command exactly equals first and returned balance updates `#chip-balance` + `[data-chip-balance]`;
- Reset: restores `serverSyncedBalance` and betting phase.

Do not duplicate settlement-gate internal unit tests.

Run:

```bash
bun test src/lib/three-card-showdown/client.test.ts src/lib/three-card-showdown/client.init.test.ts
```

Expected: PASS.

- [ ] **Step 10: Add the narrow public barrel**

`src/lib/three-card-showdown/index.ts`:

```ts
export { ThreeCardShowdownGame } from './game';
export {
  ANTE_OPTIONS,
  compareThreeCardHands,
  dealerQualifies,
  evaluateThreeCardHand,
} from './rules';
export { initThreeCardShowdownClient } from './client';
export type {
  ThreeCardHandEvaluation,
  ThreeCardShowdownRoundResult,
  ThreeCardShowdownState,
} from './types';
```

- [ ] **Step 11: Add one normal lobby card**

Modify `src/pages/index.astro` following the adjacent Video Poker/Sic Bo card markup:

```text
label: Three-Card Showdown
href: /games/three-card-showdown
icon/theme: existing card-game presentation
```

Do not extract a lobby-card component.

- [ ] **Step 12: Run Task 4 validation**

```bash
bun test src/lib/three-card-showdown/ src/lib/game-stats/game-stats.test.ts
bun run build
```

Expected: PASS.

- [ ] **Step 13: Commit Task 4**

```bash
git add src/lib/three-card-showdown src/pages/games/three-card-showdown.astro src/lib/game-stats src/pages/index.astro
git commit -m "feat(three-card-showdown): add playable game"
```

---

## Task 5: Add the two browser acceptance flows and finish repository validation

**Files:**
- Create: `e2e/three-card-showdown.spec.ts`
- Modify: `e2e/profile-statistics.spec.ts`

**Interfaces:**
- Consumes: `/games/three-card-showdown`, existing `createIsolatedPage()` helper.
- Produces no runtime interface.

- [ ] **Step 1: Add the deterministic guest Play E2E**

Use guest storage state and before navigation:

```ts
await page.addInitScript(() => {
  Math.random = () => 0;
});
```

Navigate to `/games/three-card-showdown`, select `[data-ante="10"]`, then Deal.

Assert:

```ts
await expect(page.getByTestId('three-card-showdown-root'))
  .toHaveAttribute('data-guest-mode', 'true');
await expect(page.getByTestId('chip-balance')).toContainText('1,000');
await expect(page.locator('[id^="three-card-showdown-player-slot-"]'))
  .toHaveCount(3);
await expect(page.locator('[id^="three-card-showdown-player-slot-"][data-slot-state="card"]'))
  .toHaveCount(3);
await expect(page.locator('[id^="three-card-showdown-dealer-slot-"][data-slot-state="facedown"]'))
  .toHaveCount(3);
```

Click Play. Because random 0 deals player 3♥4♥5♥ and dealer 6♥7♥8♥, assert:

```ts
await expect(page.locator('#three-card-showdown-result'))
  .toHaveText('Dealer wins · -20 net');
await expect(page.getByTestId('chip-balance')).toContainText('980');
await expect(page.locator('[id^="three-card-showdown-dealer-slot-"][data-slot-state="card"]'))
  .toHaveCount(3);
expect(walletRequests).toEqual([]);
```

Click New Round and assert Deal is visible again.

- [ ] **Step 2: Add authenticated 503 → exact-command Retry E2E**

Use `createIsolatedPage()` with a Three-Card-specific email/name prefix and navigation callback.

Intercept `**/api/wallet/settle`:

```ts
const commands: Array<Record<string, unknown>> = [];
await page.route('**/api/wallet/settle', async (route) => {
  const command = route.request().postDataJSON() as Record<string, unknown>;
  commands.push(command);
  if (commands.length === 1) {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'offline' }),
    });
    return;
  }
  const delta = typeof command.delta === 'number' ? command.delta : 0;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ balance: startingBalance + delta, duplicate: false }),
  });
});
```

Complete Deal → Play and assert one command, visible recovery, and disabled New Round. Click Retry and assert:

```ts
expect(commands).toHaveLength(2);
expect(commands[1]).toEqual(commands[0]);
await expect(page.locator('#three-card-showdown-settlement-recovery')).toBeHidden();
await expect(page.locator('#three-card-showdown-new-round')).toBeEnabled();
```

Then assert both local and shared header balances equal `startingBalance + Number(commands[1].delta)`.

- [ ] **Step 3: Update the fixed profile statistics game list**

In `e2e/profile-statistics.spec.ts`, append:

```ts
'three-card-showdown',
```

to `CANONICAL_GAME_TYPES` after `sic-bo`. Existing mapped fixtures/card-count assertions then cover the new registration without adding another profile test.

- [ ] **Step 4: Run new and adjacent E2E serially**

```bash
bunx playwright test e2e/three-card-showdown.spec.ts e2e/video-poker.spec.ts e2e/profile-statistics.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 5: Run complete unit/integration validation**

```bash
bun run test
```

Expected: PASS.

- [ ] **Step 6: Run static validation**

```bash
bun run lint
bun run format:check
bun run build
```

Expected: all PASS.

- [ ] **Step 7: Run full Playwright serially**

```bash
bunx playwright test --workers=1
```

Expected: PASS except repository-documented intentional skips only.

- [ ] **Step 8: Perform the final scope gate**

Inspect the final diff and require all of these to be true:

```text
no schema/migration files changed
no new API route exists
src/lib/poker/** is untouched
no generic evaluator/base game/client controller exists
only Card + deck/shuffle moved out of Video Poker
no side bet/bonus/AI/ranked/history/replay code exists
```

If any condition is false, remove the extra machinery before merge.

- [ ] **Step 9: Commit Task 5**

```bash
git add e2e/three-card-showdown.spec.ts e2e/profile-statistics.spec.ts
git commit -m "test(three-card-showdown): cover guest and wallet flows"
```

---

## Final Review Checklist

- [ ] Shared `src/lib/cards.ts` has exactly two clean consumers: Video Poker and Three-Card Showdown.
- [ ] `src/lib/poker/**` is untouched.
- [ ] Straight beats Flush in all three-card comparison paths.
- [ ] Q-high qualifies and J-high does not.
- [ ] Deal cannot create a state where the equal Play wager is unaffordable.
- [ ] Fold loses one Ante; Play outcomes account for both wagers exactly once.
- [ ] No Ante Bonus or side-bet payout exists.
- [ ] Guest completion makes no wallet request.
- [ ] Authenticated completion creates one settlement command and Retry reuses it unchanged.
- [ ] New Round is blocked while settlement is pending/failed.
- [ ] Reset restores the last authoritative balance and returns to betting.
- [ ] `three-card-showdown` appears in game stats, profile statistics, and lobby surfaces.
- [ ] `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`, selected E2E, and full serial Playwright pass.
