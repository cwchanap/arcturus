# HPA-198 Three-Card Showdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused Three-Card Showdown game with Ante → Fold/Play gameplay, a minimal shared card/deck primitive, guest-local bankrolls, and the existing authenticated wallet-settlement flow.

**Architecture:** Extract Video Poker's standard 52-card type/deck helper into `src/lib/cards.ts`, while preserving Video Poker's existing `types.ts` card-type surface. Build a self-contained `src/lib/three-card-showdown` rules/state module. The Astro page/client copies the existing Video Poker/Sic Bo composition seams literally: public-session root dataset, `CardSlot`/`setSlotState`, wallet gate/recovery, authoritative balance adoption, and achievement forwarding.

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
- `three-card-showdown` becomes the tenth `GAME_TYPES` entry.
- No database migration, new API endpoint, automatic retry, persisted settlement queue, generic evaluator, base game class, generic client controller, paytable engine, or Texas Hold'em/Blackjack card refactor.

---

## Task 1: Extract the neutral 52-card primitive without breaking Video Poker's type surface

**Files:**
- Create: `src/lib/cards.ts`
- Create: `src/lib/cards.test.ts`
- Delete: `src/lib/video-poker/cards.ts`
- Delete: `src/lib/video-poker/cards.test.ts`
- Modify: `src/lib/video-poker/types.ts`
- Modify: `src/lib/video-poker/game.ts`
- Modify: `src/lib/video-poker/client.ts`
- Modify: `src/lib/video-poker/index.ts`
- Test: `src/lib/video-poker/evaluator.test.ts`
- Test: all other `src/lib/video-poker/*.test.ts`

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

- Preserves: `Card`, `Rank`, and `Suit` remain importable from `src/lib/video-poker/types.ts`.
- Consumed by: Video Poker and Tasks 2-3.

- [ ] **Step 1: Write the shared-card tests**

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

  test('constant-zero Fisher-Yates is pinned and source stays unchanged', () => {
    const deck = createDeck();
    const snapshot = deck.map((card) => ({ ...card }));
    const shuffled = shuffleDeck(deck, () => 0);

    expect(deck).toEqual(snapshot);
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

- [ ] **Step 2: Verify the new test fails before `cards.ts` exists**

Run:

```bash
bun test src/lib/cards.test.ts
```

Expected: FAIL because `src/lib/cards.ts` does not exist.

- [ ] **Step 3: Move only the neutral implementation into `src/lib/cards.ts`**

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

Do not add a barrel, RNG interface, shoe, formatter, evaluator, or adapter for Poker/Blackjack.

- [ ] **Step 4: Preserve Video Poker's existing `types.ts` card imports**

Replace the local `Suit`, `Rank`, and `Card` declarations in `src/lib/video-poker/types.ts` with:

```ts
import type { Card } from '../cards';
export type { Card, Rank, Suit } from '../cards';
```

Keep `Card` used locally by `VideoPokerRoundResult` / `VideoPokerState`.

This is required because `src/lib/video-poker/evaluator.test.ts` currently imports:

```ts
import type { Card, Rank, Suit } from './types';
```

Do not create or keep `src/lib/video-poker/cards.ts` as a compatibility wrapper.

- [ ] **Step 5: Point Video Poker implementations at `../cards`**

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

Keep the current `src/lib/video-poker/index.ts` type export through `./types`, so its existing `Card` export continues to resolve through the new owner.

Delete:

```text
src/lib/video-poker/cards.ts
src/lib/video-poker/cards.test.ts
```

Update any focused test that imported `./cards` to import `../cards`.

- [ ] **Step 6: Run shared-card and all Video Poker tests**

```bash
bun test src/lib/cards.test.ts src/lib/video-poker/
```

Expected: PASS, including `evaluator.test.ts` importing `Card`, `Rank`, and `Suit` from `./types`.

- [ ] **Step 7: Commit Task 1**

```bash
git add src/lib/cards.ts src/lib/cards.test.ts src/lib/video-poker
git commit -m "refactor(cards): share neutral deck primitive"
```

---

## Task 2: Implement pure three-card ranking, comparison, qualification, and payouts

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
export function resolvePlayedHand(
  playerCards: readonly Card[],
  dealerCards: readonly Card[],
  ante: number,
): ThreeCardShowdownRoundResult;
```

- [ ] **Step 1: Create the Three-Card-only types**

Create `src/lib/three-card-showdown/types.ts`:

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

- [ ] **Step 2: Write ranking and comparison tests before rules code**

Use a small card helper and pin the important ordering:

```ts
const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });

expect(evaluateThreeCardHand([c(10, 'hearts'), c(11, 'hearts'), c(12, 'hearts')]).category)
  .toBe('straight-flush');
expect(evaluateThreeCardHand([c(9, 'hearts'), c(9, 'clubs'), c(9, 'spades')]).category)
  .toBe('three-of-kind');
expect(evaluateThreeCardHand([c(7, 'hearts'), c(8, 'clubs'), c(9, 'spades')]).category)
  .toBe('straight');
expect(evaluateThreeCardHand([c(14, 'hearts'), c(9, 'hearts'), c(4, 'hearts')]).category)
  .toBe('flush');
```

Add assertions for:

```text
Straight > Flush
A-K-Q straightHigh = 14
A-2-3 straightHigh = 3
K-A-2 = High Card/Flush, not Straight
Pair uses [pairRank, kicker]
High Card/Flush compare ranks descending
same ranks with different suits tie
```

- [ ] **Step 3: Write dealer qualification tests**

```ts
expect(dealerQualifies(evaluateThreeCardHand([c(12, 'hearts'), c(9, 'clubs'), c(4, 'spades')]))).toBe(true);
expect(dealerQualifies(evaluateThreeCardHand([c(11, 'hearts'), c(9, 'clubs'), c(4, 'spades')]))).toBe(false);
expect(dealerQualifies(evaluateThreeCardHand([c(2, 'hearts'), c(2, 'clubs'), c(3, 'spades')]))).toBe(true);
```

- [ ] **Step 4: Write all Play payout tests**

For Ante 10, pin:

```ts
expect(resolvePlayedHand(player, nonQualifyingDealer, 10)).toMatchObject({
  outcome: 'dealer-not-qualified', totalWager: 20, grossPayout: 30, netDelta: 10,
});
expect(resolvePlayedHand(winningPlayer, qualifyingDealer, 10)).toMatchObject({
  outcome: 'player-win', totalWager: 20, grossPayout: 40, netDelta: 20,
});
expect(resolvePlayedHand(tiedPlayer, tiedDealer, 10)).toMatchObject({
  outcome: 'tie', totalWager: 20, grossPayout: 20, netDelta: 0,
});
expect(resolvePlayedHand(losingPlayer, qualifyingDealer, 10)).toMatchObject({
  outcome: 'dealer-win', totalWager: 20, grossPayout: 0, netDelta: -20,
});
```

- [ ] **Step 5: Run rules tests and verify failure**

```bash
bun test src/lib/three-card-showdown/rules.test.ts
```

Expected: FAIL because the rules module does not exist.

- [ ] **Step 6: Implement category strength and straight detection**

Use one local map:

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

Treat sorted ranks `[2, 3, 14]` as straight-high `3`; ordinary consecutive ranks use their highest rank.

- [ ] **Step 7: Implement evaluation, comparison, qualification, and payout resolution**

Requirements:

```text
exactly 3 cards or throw RangeError
Straight Flush > Trips > Straight > Flush > Pair > High Card
compare category strength, then tieBreakers lexicographically
Pair-or-better always qualifies; High Card qualifies at Q-high+
resolvePlayedHand returns frozen hands/evaluations and the payout table above
```

Do not add a generic evaluator or paytable engine.

- [ ] **Step 8: Run Task 2 tests**

```bash
bun test src/lib/three-card-showdown/rules.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 2**

```bash
git add src/lib/three-card-showdown/types.ts src/lib/three-card-showdown/rules.ts src/lib/three-card-showdown/rules.test.ts
git commit -m "feat(three-card-showdown): add pure rules"
```

---

## Task 3: Implement the pure bankroll/deal/decision lifecycle

**Files:**
- Create: `src/lib/three-card-showdown/game.ts`
- Create: `src/lib/three-card-showdown/game.test.ts`

**Interfaces:**
- Consumes: shared `createShuffledDeck`, `validateBet`, Task 2 rule functions/types.
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

- [ ] **Step 1: Write the Deal and state-transition tests**

```ts
const game = new ThreeCardShowdownGame(100, () => 0);
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

Also assert all six cards are unique.

- [ ] **Step 2: Pin two-Ante affordability**

```ts
const game = new ThreeCardShowdownGame(15);
expect(game.getAnteError(10)).toBe('Ante plus Play wager exceeds available balance');
expect(() => game.setAnte(10)).toThrow('Ante plus Play wager exceeds available balance');
```

Add non-integer, 0, and 101 cases.

- [ ] **Step 3: Pin Fold accounting**

```ts
const game = new ThreeCardShowdownGame(100, () => 0);
game.setAnte(10);
game.deal();
const result = game.fold();

expect(result).toMatchObject({ outcome: 'fold', totalWager: 10, grossPayout: 0, netDelta: -10 });
expect(game.getState().phase).toBe('complete');
expect(game.getState().balance).toBe(90);
```

- [ ] **Step 4: Pin Play accounting**

With `random = () => 0`, dealer wins:

```ts
const game = new ThreeCardShowdownGame(100, () => 0);
game.setAnte(10);
game.deal();
const result = game.play();

expect(result.outcome).toBe('dealer-win');
expect(result.netDelta).toBe(-20);
expect(game.getState().balance).toBe(80);
```

Also test a dealer-not-qualified fixture to prove gross payout is credited after the second wager.

- [ ] **Step 5: Run game tests and verify failure**

```bash
bun test src/lib/three-card-showdown/game.test.ts
```

Expected: FAIL because `game.ts` does not exist.

- [ ] **Step 6: Implement balance normalization and Ante validation**

```ts
function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new RangeError('Balance must be a non-negative finite number');
  }
  return Math.trunc(balance);
}
```

`getAnteError()` order:

```text
whole number
validateBet(ante, MIN_ANTE, MAX_ANTE)
ante * 2 > balance -> "Ante plus Play wager exceeds available balance"
```

- [ ] **Step 7: Implement Deal, Fold, and Play**

`deal()`:

```text
require betting
validate selected Ante
create one shuffled deck
player = first 3, dealer = next 3
subtract one Ante
enter decision
```

`fold()`:

```text
require decision
evaluate both dealt hands
no second wager
result netDelta = -ante
enter complete
```

`play()`:

```text
require decision
subtract second equal wager
resolvePlayedHand(...)
credit result.grossPayout
enter complete
```

Return deep-cloned results from Fold/Play and deep-clone hands/results from `getState()`.

- [ ] **Step 8: Implement reset and authoritative balance adoption**

`resetRound()` requires `complete`, clears both hands/result, keeps selected Ante, and returns to `betting`.

`setBalance()` changes only the balance via `normalizeBalance()`.

- [ ] **Step 9: Run Task 3 tests**

```bash
bun test src/lib/three-card-showdown/game.test.ts src/lib/three-card-showdown/rules.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit Task 3**

```bash
git add src/lib/three-card-showdown/game.ts src/lib/three-card-showdown/game.test.ts
git commit -m "feat(three-card-showdown): add pure game state"
```

---

## Task 4: Register the game and add the page/client by copying existing composition seams

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

- [ ] **Step 1: Update the real game registry and its pinned tests**

Append `three-card-showdown` to `GAME_TYPES`, then add:

```ts
GAME_TYPE_LABELS['three-card-showdown'] = 'Three-Card Showdown';
GAME_TYPE_ICONS['three-card-showdown'] = '♠️';
```

In the existing `describe('constants')` coverage, explicitly update the pinned contract:

```ts
expect(GAME_TYPES).toContain('three-card-showdown');
expect(GAME_TYPES.length).toBe(10);
expect(isValidGameType('three-card-showdown')).toBe(true);
expect(GAME_TYPE_LABELS['three-card-showdown']).toBe('Three-Card Showdown');
expect(GAME_TYPE_ICONS['three-card-showdown']).toBe('♠️');
```

Run:

```bash
bun test src/lib/game-stats/game-stats.test.ts
```

Expected: PASS. Do not leave the old `GAME_TYPES.length === 9` assertion behind.

- [ ] **Step 2: Write the settlement-command mapping test**

Create `client.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildThreeCardShowdownSettlementCommand } from './client';

describe('buildThreeCardShowdownSettlementCommand', () => {
  test.each([
    [-20, { wins: 0, losses: 1, biggestWin: 0 }],
    [0, { wins: 0, losses: 0, biggestWin: 0 }],
    [20, { wins: 1, losses: 0, biggestWin: 20 }],
  ] as const)('maps net delta %i to one round', (netDelta, stats) => {
    expect(buildThreeCardShowdownSettlementCommand('three-card-1', { netDelta })).toEqual({
      settlementId: 'three-card-1',
      game: 'three-card-showdown',
      delta: netDelta,
      stats: { rounds: 1, ...stats },
    });
  });
});
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

Do not add settlement mapping to `wallet`.

- [ ] **Step 4: Create the Astro page with the exact public-session root contract**

Use `CasinoLayout`, six existing `CardSlot` instances, and:

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import CardSlot from '../../components/CardSlot.astro';
import { createPublicGameSession } from '../../lib/public-game-session';
import { ANTE_OPTIONS } from '../../lib/three-card-showdown';

const gameSession = createPublicGameSession(Astro.locals.user);
---

<main
  id="three-card-showdown-root"
  data-testid="three-card-showdown-root"
  data-user-id={gameSession.clientUserId}
  data-guest-mode={gameSession.guestModeValue}
  data-initial-balance={gameSession.initialBalance}
>
```

These attributes are required. The client must not infer guest mode from missing values.

Required stable IDs:

```text
chip-balance
three-card-showdown-status
three-card-showdown-result
three-card-showdown-dealer-slot-0..2
three-card-showdown-player-slot-0..2
three-card-showdown-deal
three-card-showdown-fold
three-card-showdown-play
three-card-showdown-new-round
three-card-showdown-recovery-host
```

Ante buttons use `[data-ante]` and `ANTE_OPTIONS`.

- [ ] **Step 5: Implement client session/card rendering**

Read the root dataset exactly:

```ts
const clientUserId = root.dataset.userId ?? 'anonymous';
const isGuestMode = isGuestModeValue(root.dataset.guestMode ?? 'false');
const initialBalance = Number(root.dataset.initialBalance ?? '1000');
const startingBalance = isGuestMode
  ? loadGuestBankroll('three-card-showdown', clientUserId, initialBalance)
  : initialBalance;
const game = new ThreeCardShowdownGame(startingBalance);
const gate = createSettlementGate();
let serverSyncedBalance = startingBalance;
```

Render with `setSlotState()`:

```text
Dealer: betting=placeholder, decision=facedown, complete=card
Player: betting=placeholder, decision=card, complete=card
```

Use local rank formatting `11→J`, `12→Q`, `13→K`, `14→A`.

- [ ] **Step 6: Implement phase buttons and result copy**

Visibility:

```text
betting  -> Deal
decision -> Fold + Play
complete -> New Round
```

Result copy:

```ts
switch (result.outcome) {
  case 'fold': return `Fold · -${result.ante} net`;
  case 'dealer-not-qualified': return `Dealer does not qualify · +${result.ante} net`;
  case 'player-win': return `Player wins · +${result.netDelta} net`;
  case 'tie': return 'Tie · 0 net';
  case 'dealer-win': return `Dealer wins · ${result.netDelta} net`;
}
```

Deal renders `getAnteError()` instead of using throw/catch for expected affordability failure.

- [ ] **Step 7: Wire guest completion and authenticated settlement**

For both Fold and Play:

```text
call game.fold() or game.play()
render complete state (dealer now revealed)
if guest: persistGuestBankroll('three-card-showdown', clientUserId, balance); stop
if authenticated: gate.settle(buildThreeCardShowdownSettlementCommand(newSettlementId('three-card-showdown'), round))
```

New Round is disabled whenever authenticated `gate.isBlocked`.

- [ ] **Step 8: Copy authoritative settlement adoption including achievements**

Use the current Video Poker/Sic Bo shape:

```ts
function adoptSettlementResult(result: SettleRoundResult): void {
  serverSyncedBalance = result.balance;
  game.setBalance(result.balance);
  hideSettlementRecovery();
  if (result.newAchievements?.length) {
    window.dispatchEvent(
      new CustomEvent('achievement-earned', {
        detail: { achievements: result.newAchievements },
      }),
    );
  }
}
```

Call this after successful initial settlement and successful Retry. Update `#chip-balance` and every `[data-chip-balance]` surface after adoption.

- [ ] **Step 9: Reuse Retry/Reset controls exactly**

Use IDs:

```text
three-card-showdown-settlement-recovery
three-card-showdown-retry-settlement
three-card-showdown-reset-settlement
```

Retry disables Retry+Reset while `gate.retry()` is in flight and calls `adoptSettlementResult()` on success.

Reset:

```ts
gate.reset();
game.setBalance(serverSyncedBalance);
if (game.getState().phase === 'complete') game.resetRound();
hideSettlementRecovery();
render();
```

No timer or automatic retry.

- [ ] **Step 10: Add focused Happy-DOM Deal/Play composition coverage**

Create a root fixture that includes the same client dataset attributes as the Astro page.

With guest mode, start 1000, Ante 10, and `Math.random = () => 0`:

```text
before Deal: balance 1000
Deal: balance 990, player slots card, dealer slots facedown
Play: result "Dealer wins · -20 net", balance 980, dealer slots card
localStorage guest bankroll = 980
fetch count = 0
```

- [ ] **Step 11: Add the missing guest Fold composition test**

Use guest mode, start 1000, Ante 10. After Deal then Fold, assert:

```ts
expect(resultEl.textContent).toBe('Fold · -10 net');
expect(balanceEl.textContent).toBe('990');
expect(localStorage.getItem('three-card-showdown-bankroll:anonymous')).toBe('990');
expect(fetchCallCount).toBe(0);
```

Also assert all three dealer slots are `data-slot-state="card"` at `complete`.

This is the composition guard that proves the UI exposes the second core decision, reveals the dealer, and uses guest-local settlement.

- [ ] **Step 12: Add settlement recovery + achievement forwarding coverage**

Pin the failure path:

```text
first settlement throws/503
recovery visible
New Round disabled
Retry sends exact same command
```

On Retry success return:

```ts
{
  balance: 1020,
  duplicate: false,
  newAchievements: [
    { id: 'three-card-master', name: 'Three-Card Master', icon: 'cards' },
  ],
}
```

Listen for `achievement-earned` and assert exactly one event:

```ts
expect(achievementEvents).toEqual([
  { achievements: [{ id: 'three-card-master', name: 'Three-Card Master', icon: 'cards' }] },
]);
```

Also assert the returned balance appears in both local and shared-header balance surfaces.

- [ ] **Step 13: Add Reset coverage**

After a failed authenticated settlement, click Reset and assert:

```text
gate cleared
balance restored to serverSyncedBalance
recovery hidden
phase betting
Deal visible/enabled when Ante affordable
```

- [ ] **Step 14: Run client/game-stat tests**

```bash
bun test src/lib/three-card-showdown/ src/lib/game-stats/game-stats.test.ts
```

Expected: PASS.

- [ ] **Step 15: Add the narrow public barrel and lobby card**

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

Add one normal `Three-Card Showdown` card in `src/pages/index.astro` linking to `/games/three-card-showdown`. Do not extract a lobby-card component.

- [ ] **Step 16: Run Task 4 build validation**

```bash
bun run build
```

Expected: PASS.

- [ ] **Step 17: Commit Task 4**

```bash
git add src/lib/three-card-showdown src/pages/games/three-card-showdown.astro src/lib/game-stats src/pages/index.astro
git commit -m "feat(three-card-showdown): add playable game"
```

---

## Task 5: Add browser acceptance coverage and finish repository validation

**Files:**
- Create: `e2e/three-card-showdown.spec.ts`
- Modify: `e2e/profile-statistics.spec.ts`

**Interfaces:**
- Consumes: `/games/three-card-showdown`, existing `createIsolatedPage()` helper.
- Produces no runtime interface.

- [ ] **Step 1: Add the deterministic guest Play E2E with the correct bankroll timing**

Use guest storage state and install:

```ts
await page.addInitScript(() => {
  Math.random = () => 0;
});
```

Navigate to `/games/three-card-showdown`.

Before Deal, assert the actual public-session contract and initial balance:

```ts
await expect(page.getByTestId('three-card-showdown-root'))
  .toHaveAttribute('data-guest-mode', 'true');
await expect(page.getByTestId('chip-balance')).toContainText('1,000');
```

Select `[data-ante="10"]`, click Deal, then assert:

```ts
await expect(page.getByTestId('chip-balance')).toContainText('990');
await expect(page.locator('[id^="three-card-showdown-player-slot-"][data-slot-state="card"]'))
  .toHaveCount(3);
await expect(page.locator('[id^="three-card-showdown-dealer-slot-"][data-slot-state="facedown"]'))
  .toHaveCount(3);
```

Do **not** assert 1,000 after Deal. Deal has already deducted the Ante.

Click Play. Constant-zero Fisher-Yates is pinned to player `3♥4♥5♥` and dealer `6♥7♥8♥`, so assert:

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

Then assert both local and shared-header balances equal `startingBalance + Number(commands[1].delta)`.

Achievement forwarding is already pinned in Happy DOM; do not duplicate it here.

- [ ] **Step 3: Update the fixed profile statistics game list**

In `e2e/profile-statistics.spec.ts`, append:

```ts
'three-card-showdown',
```

to `CANONICAL_GAME_TYPES` after `sic-bo`. Existing mapped fixtures/card-count assertions then cover the new game.

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

Require all of these from the final diff:

```text
no schema/migration files changed
no new API route exists
src/lib/poker/** is untouched
Blackjack card representation is untouched
no generic evaluator/base game/client controller/paytable engine exists
only neutral Card + deck/shuffle moved out of Video Poker
Video Poker types.ts still exports Card/Rank/Suit
no side bet/bonus/AI/ranked/history/replay code exists
three-card-showdown is GAME_TYPES entry 10
```

Remove any extra machinery before merge.

- [ ] **Step 9: Commit Task 5**

```bash
git add e2e/three-card-showdown.spec.ts e2e/profile-statistics.spec.ts
git commit -m "test(three-card-showdown): cover guest and wallet flows"
```

---

## Final Review Checklist

- [ ] Shared `src/lib/cards.ts` has only the intended clean consumers; Texas Hold'em and Blackjack card shapes are untouched.
- [ ] `src/lib/video-poker/types.ts` still exports `Card`, `Rank`, and `Suit`; all Video Poker tests pass after extraction.
- [ ] Straight beats Flush in all Three-Card comparison paths.
- [ ] Q-high qualifies and J-high does not.
- [ ] Deal cannot create a state where the equal Play wager is unaffordable.
- [ ] Guest root includes `data-testid`, `data-user-id`, `data-guest-mode`, and `data-initial-balance`.
- [ ] Guest E2E asserts 1,000 before Deal, 990 after Deal, and 980 after the pinned losing Play.
- [ ] Fold loses one Ante, persists guest balance, makes no wallet call, and reveals dealer cards.
- [ ] Play outcomes account for both wagers exactly once.
- [ ] No Ante Bonus or side-bet payout exists.
- [ ] Authenticated completion creates one settlement command and Retry reuses it unchanged.
- [ ] Successful settlement adoption updates authoritative balance and forwards `newAchievements` through `achievement-earned`.
- [ ] New Round is blocked while settlement is pending/failed; Reset restores the last authoritative balance.
- [ ] `GAME_TYPES` contains `three-card-showdown`, length is 10, and `isValidGameType('three-card-showdown')` is true.
- [ ] Profile statistics canonical list and lobby include Three-Card Showdown.
- [ ] `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`, selected E2E, and full serial Playwright pass before implementation PR completion.
