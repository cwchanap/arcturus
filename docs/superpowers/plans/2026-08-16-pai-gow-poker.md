# HPA-197 Focused Pai Gow Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused single-player Pai Gow Poker game with seven-card arrangement, a semi-wild Joker, deterministic dealer arrangement, 5% commission, and the existing public-game wallet settlement flow.

**Architecture:** Reuse the neutral standard-card deck and make only its Fisher-Yates shuffle type-generic. Extract the already-existing ordinary five-card poker ranking/comparison core from Texas Hold'em into one small structural module; keep Hold'em combination logic local and keep every Pai Gow-specific rule—Joker substitution, Pai Gow straight ordering, two-card comparison, arrangement validation, house way, payouts, state, and DOM interaction—inside `src/lib/pai-gow-poker/`. Compose the existing `createPublicGameSettlementController` without adding persistence, retry, client-controller, or rules frameworks.

**Tech Stack:** Astro 5, TypeScript, Bun tests, Happy DOM, Playwright, existing Cloudflare Worker/D1 wallet API.

## Global Constraints

- Route: `/games/pai-gow-poker`.
- Game key: `pai-gow-poker`; label: `Pai Gow Poker`; icon: `🃏`; it becomes `GAME_TYPES` entry 11.
- Use 52 standard shared cards plus exactly one Pai Gow-local Joker.
- Joker is an Ace by default; it may instead complete a straight, flush, straight flush, or Royal Flush; Four Aces + Joker is Five Aces.
- Five-card order: Five Aces > Royal Flush > Straight Flush > Four of a Kind > Full House > Flush > Straight > Three of a Kind > Two Pair > Pair > High Card.
- Straight order: A-K-Q-J-10 highest; A-2-3-4-5 second; K-Q-J-10-9 third, then downward.
- Non-Royal straight-flush order: A-2-3-4-5 highest, then K-Q-J-10-9, then downward; Royal Flush is a separate higher category.
- The Low hand has exactly two cards and can rank only Pair or High Card; its Joker always acts as Ace.
- The five-card High hand must rank strictly higher than the two-card Low hand; equal or lower is a foul.
- Dealer copies win: the player must strictly beat the dealer in a sub-hand to win it.
- Overall outcome is `win` only when the player wins both sub-hands, `push` when the player wins exactly one, and `loss` otherwise.
- House way: enumerate all 21 two-card Low choices, reject fouls, maximize High ranking first, then Low ranking, then choose the lexicographically smaller low-index pair.
- Main wager only. `MIN_WAGER = 20`, `MAX_WAGER = 500`, `WAGER_OPTIONS = [20, 40, 100, 200, 500]`, and every valid wager is divisible by 20.
- A win charges exactly 5% commission: gross payout `2 * wager - wager / 20`, net delta `wager - wager / 20`; push gross payout `wager`, net `0`; loss gross payout `0`, net `-wager`.
- Initial wager is exactly `20`.
- Guest rounds stay local. Authenticated Confirm produces exactly one net settlement through `createPublicGameSettlementController`.
- Reuse `validateBet`, `CardSlot`, `setSlotState`, `createPublicGameSession`, and `createPublicGameSettlementController` unchanged.
- No side bets, banking, commission-free variant, drag-and-drop system, generic card-arrangement component, generic wildcard engine, configurable house-way platform, base game class, AI, ranked mode, history, replay, new API, schema migration, settlement queue, automatic retry, or compatibility layer.
- Do not migrate Texas Hold'em's `{ value, suit, rank }` card model, Blackjack cards, Video Poker's Jacks-or-Better evaluator, or Three-Card Showdown's three-card evaluator.

---

## Task 1: Make Fisher-Yates type-generic without changing runtime behavior

**Files:**
- Modify: `src/lib/cards.ts`
- Modify: `src/lib/cards.test.ts`

**Interfaces:**
- Consumes: existing `shuffleDeck` implementation.
- Produces:

```ts
export function shuffleDeck<T>(deck: readonly T[], random?: () => number): T[];
```

`createDeck()` and `createShuffledDeck()` remain standard-52-card functions returning `Card[]`.

This task is intentionally a type-only enabling refactor. The JavaScript algorithm already works for arbitrary array items, so there is no meaningful red runtime test before changing the TypeScript signature.

- [ ] **Step 1: Add a runtime regression test for structural values and non-mutation**

Add to `src/lib/cards.test.ts`:

```ts
test('shuffleDeck preserves arbitrary structural values without mutating input', () => {
  const input = [
    { id: 'a', special: false },
    { id: 'b', special: true },
    { id: 'c', special: false },
  ] as const;

  const result = shuffleDeck(input as never, () => 0);

  expect(result).toEqual([
    { id: 'b', special: true },
    { id: 'c', special: false },
    { id: 'a', special: false },
  ]);
  expect(input.map((item) => item.id)).toEqual(['a', 'b', 'c']);
});
```

The temporary `as never` makes the pre-refactor runtime regression executable without pretending Bun type-checks test arguments.

- [ ] **Step 2: Run the regression before changing the signature**

```bash
bun test src/lib/cards.test.ts
```

Expected: PASS. This proves runtime behavior is unchanged by the upcoming type-only edit.

- [ ] **Step 3: Generalize only the signature and remove the temporary cast**

Change:

```ts
export function shuffleDeck(deck: readonly Card[], random: () => number = Math.random): Card[] {
```

to:

```ts
export function shuffleDeck<T>(deck: readonly T[], random: () => number = Math.random): T[] {
```

Then change the test call to:

```ts
const result = shuffleDeck(input, () => 0);
```

Leave the Fisher-Yates body unchanged. Do not add Joker or deck-configuration knowledge.

- [ ] **Step 4: Run the shared-card suite again**

```bash
bun test src/lib/cards.test.ts
```

Expected: PASS, including the existing deterministic 52-card fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/lib/cards.ts src/lib/cards.test.ts
git commit -m "refactor(cards): generalize shuffle item type"
```

---

## Task 2: Extract the ordinary five-card comparator from Texas Hold'em

**Files:**
- Create: `src/lib/five-card-poker.ts`
- Create: `src/lib/five-card-poker.test.ts`
- Modify: `src/lib/poker/handEvaluator.ts`
- Test: `src/lib/poker/handEvaluator.test.ts`
- Test: `src/lib/poker/PokerGame.test.ts`

**Interfaces:**
- Consumes: structural cards with `rank: number` and `suit: string`.
- Produces:

```ts
export interface FiveCardRankable {
  rank: number;
  suit: string;
}

export type FiveCardCategory =
  | 'straight-flush'
  | 'four-of-kind'
  | 'full-house'
  | 'flush'
  | 'straight'
  | 'three-of-kind'
  | 'two-pair'
  | 'pair'
  | 'high-card';

export interface FiveCardRanking {
  category: FiveCardCategory;
  tieBreakers: number[];
}

export function rankFiveCardHand(cards: readonly FiveCardRankable[]): FiveCardRanking;
export function compareFiveCardRankings(
  left: FiveCardRanking,
  right: FiveCardRanking,
): -1 | 0 | 1;
```

- [ ] **Step 1: Write failing public-comparator tests**

Create `src/lib/five-card-poker.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { compareFiveCardRankings, rankFiveCardHand } from './five-card-poker';

const c = (rank: number, suit = 'spades') => ({ rank, suit });

test('standard wheel is 5-high', () => {
  const wheel = rankFiveCardHand([c(14), c(2), c(3), c(4), c(5)]);
  const sixHigh = rankFiveCardHand([c(2), c(3), c(4), c(5), c(6)]);
  expect(compareFiveCardRankings(wheel, sixHigh)).toBe(-1);
});

test('full house compares trips before pair', () => {
  const kings = rankFiveCardHand([c(13), c(13), c(13), c(2), c(2)]);
  const queens = rankFiveCardHand([c(12), c(12), c(12), c(14), c(14)]);
  expect(compareFiveCardRankings(kings, queens)).toBe(1);
});

test('two pair compares the kicker last', () => {
  const ace = rankFiveCardHand([c(10), c(10), c(8), c(8), c(14)]);
  const king = rankFiveCardHand([c(10), c(10), c(8), c(8), c(13)]);
  expect(compareFiveCardRankings(ace, king)).toBe(1);
});

test('suits never break a perfect tie', () => {
  const left = rankFiveCardHand([c(14, 'spades'), c(13), c(11), c(8), c(4)]);
  const right = rankFiveCardHand([
    c(14, 'hearts'), c(13, 'diamonds'), c(11, 'clubs'), c(8, 'hearts'), c(4, 'clubs'),
  ]);
  expect(compareFiveCardRankings(left, right)).toBe(0);
});
```

- [ ] **Step 2: Verify the new suite is red**

```bash
bun test src/lib/five-card-poker.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Move the existing private standard ranking logic**

Create `src/lib/five-card-poker.ts` by mechanically moving the ordinary five-card rank/comparison behavior from `src/lib/poker/handEvaluator.ts`.

Use category strength:

```ts
const CATEGORY_STRENGTH: Record<FiveCardCategory, number> = {
  'high-card': 1,
  pair: 2,
  'two-pair': 3,
  'three-of-kind': 4,
  straight: 5,
  flush: 6,
  'full-house': 7,
  'four-of-kind': 8,
  'straight-flush': 9,
};
```

Use these exact tie breakers:

```text
straight-flush -> [straightHigh]
four-of-kind   -> [quadRank, kicker]
full-house     -> [tripRank, pairRank]
flush          -> ranks descending
straight       -> [straightHigh]
three-of-kind  -> [tripRank, kickers descending]
two-pair       -> [highPair, lowPair, kicker]
pair           -> [pairRank, kickers descending]
high-card      -> ranks descending
```

The shared module uses standard poker only: Broadway is straight-high 14, wheel is straight-high 5, and Royal Flush is not a distinct category.

- [ ] **Step 4: Run the new comparator tests**

```bash
bun test src/lib/five-card-poker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Replace only Hold'em's private five-card rank/comparison implementation**

In `src/lib/poker/handEvaluator.ts` import:

```ts
import {
  compareFiveCardRankings,
  rankFiveCardHand,
  type FiveCardRanking,
} from '../five-card-poker';
```

Delete local `HandRank`, `HandRanking`, `rankFiveCardHand`, and `compareHandRankings`.

Keep combination generation in `findBestHand`, now returning `FiveCardRanking`, and replace comparator calls with `compareFiveCardRankings`. Keep `determineShowdownWinners`' public signature unchanged.

- [ ] **Step 6: Verify Hold'em behavior is unchanged**

```bash
bun test src/lib/five-card-poker.test.ts src/lib/poker/handEvaluator.test.ts src/lib/poker/PokerGame.test.ts
```

Expected: PASS.

- [ ] **Step 7: Verify no unrelated card game moved**

```bash
git diff -- src/lib/video-poker src/lib/three-card-showdown src/lib/blackjack
```

Expected: empty.

- [ ] **Step 8: Commit**

```bash
git add src/lib/five-card-poker.ts src/lib/five-card-poker.test.ts src/lib/poker/handEvaluator.ts
git commit -m "refactor(poker): share five-card hand comparison"
```

---

## Task 3: Add Pai Gow-local cards, rankings, arrangement validation, and house way

**Files:**
- Create: `src/lib/pai-gow-poker/types.ts`
- Create: `src/lib/pai-gow-poker/cards.ts`
- Create: `src/lib/pai-gow-poker/cards.test.ts`
- Create: `src/lib/pai-gow-poker/rules.ts`
- Create: `src/lib/pai-gow-poker/rules.test.ts`
- Create: `src/lib/pai-gow-poker/house-way.ts`
- Create: `src/lib/pai-gow-poker/house-way.test.ts`

**Interfaces:**
- Consumes: `Card`, `createDeck`, `shuffleDeck`, `rankFiveCardHand`, `compareFiveCardRankings`.
- Produces: `PaiGowCard`, `PaiGowHandRanking`, `PaiGowArrangement`, `rankPaiGowFiveCardHand`, `rankPaiGowTwoCardHand`, `comparePaiGowRankings`, `getArrangement`, `getArrangementError`, `arrangeHouseWay`.

- [ ] **Step 1: Define the local types**

Create `src/lib/pai-gow-poker/types.ts`:

```ts
import type { Card } from '../cards';

export interface PaiGowJoker { rank: 'joker'; suit: 'joker' }
export type PaiGowCard = Card | PaiGowJoker;

export type PaiGowCategory =
  | 'five-aces'
  | 'royal-flush'
  | 'straight-flush'
  | 'four-of-kind'
  | 'full-house'
  | 'flush'
  | 'straight'
  | 'three-of-kind'
  | 'two-pair'
  | 'pair'
  | 'high-card';

export interface PaiGowHandRanking {
  category: PaiGowCategory;
  tieBreakers: number[];
}

export type LowHandIndexes = readonly [number, number];

export interface PaiGowArrangement {
  lowIndexes: LowHandIndexes;
  high: PaiGowCard[];
  low: PaiGowCard[];
  highRanking: PaiGowHandRanking;
  lowRanking: PaiGowHandRanking;
}

export type PaiGowRoundOutcome = 'win' | 'push' | 'loss';

export interface PaiGowRoundResult {
  outcome: PaiGowRoundOutcome;
  wager: number;
  commission: number;
  grossPayout: number;
  netDelta: number;
  player: PaiGowArrangement;
  dealer: PaiGowArrangement;
}
```

- [ ] **Step 2: Write failing 53-card deck tests**

Create `cards.test.ts` and assert exactly 52 unique standard cards plus one Joker. Pin constant-zero shuffle:

```ts
expect(createShuffledPaiGowDeck(() => 0).slice(0, 14)).toEqual([
  { rank: 3, suit: 'hearts' }, { rank: 4, suit: 'hearts' },
  { rank: 5, suit: 'hearts' }, { rank: 6, suit: 'hearts' },
  { rank: 7, suit: 'hearts' }, { rank: 8, suit: 'hearts' },
  { rank: 9, suit: 'hearts' }, { rank: 10, suit: 'hearts' },
  { rank: 11, suit: 'hearts' }, { rank: 12, suit: 'hearts' },
  { rank: 13, suit: 'hearts' }, { rank: 14, suit: 'hearts' },
  { rank: 2, suit: 'diamonds' }, { rank: 3, suit: 'diamonds' },
]);
```

Run:

```bash
bun test src/lib/pai-gow-poker/cards.test.ts
```

Expected: FAIL because `cards.ts` does not exist.

- [ ] **Step 3: Implement the local Joker deck**

Create `cards.ts`:

```ts
import { createDeck, shuffleDeck } from '../cards';
import type { PaiGowCard, PaiGowJoker } from './types';

export const PAI_GOW_JOKER: PaiGowJoker = { rank: 'joker', suit: 'joker' };

export function isPaiGowJoker(card: PaiGowCard): card is PaiGowJoker {
  return card.rank === 'joker';
}

export function createPaiGowDeck(): PaiGowCard[] {
  return [...createDeck(), PAI_GOW_JOKER];
}

export function createShuffledPaiGowDeck(random: () => number = Math.random): PaiGowCard[] {
  return shuffleDeck(createPaiGowDeck(), random);
}
```

Run the deck suite again. Expected: PASS.

- [ ] **Step 4: Write failing ranking tests**

Create `rules.test.ts` and pin:

```text
Four Aces + Joker -> five-aces
10♠ J♠ Q♠ K♠ Joker -> royal-flush
A-2-3-4-5 straight beats K-Q-J-10-9 but loses to A-K-Q-J-10
A♠-2♠-3♠-4♠-5♠ -> highest non-Royal straight-flush
Joker completes a missing-card straight
Joker completes a flush
Joker + 9-9-9-K remains three-of-kind, not four-of-kind
Joker + 7-7-K-Q remains pair, not three-of-kind
[Joker, Ace] Low hand -> pair of Aces
[Joker, King] Low hand -> Ace-King high
```

Run:

```bash
bun test src/lib/pai-gow-poker/rules.test.ts
```

Expected: FAIL because `rules.ts` does not exist.

- [ ] **Step 5: Implement exact Pai Gow normalization and Joker substitution**

Use category strength:

```ts
const CATEGORY_STRENGTH: Record<PaiGowCategory, number> = {
  'high-card': 1,
  pair: 2,
  'two-pair': 3,
  'three-of-kind': 4,
  straight: 5,
  flush: 6,
  'full-house': 7,
  'four-of-kind': 8,
  'straight-flush': 9,
  'royal-flush': 10,
  'five-aces': 11,
};
```

For **Straight** tie breakers, use these exact local comparison keys:

```text
A-K-Q-J-10 -> [15]
A-2-3-4-5  -> [14]
K-Q-J-10-9 -> [13]
Q-J-10-9-8 -> [12]
...downward by ordinary high card
```

For **Straight Flush**:

```text
10-J-Q-K-A suited -> category royal-flush, tieBreakers []
A-2-3-4-5 suited  -> category straight-flush, tieBreakers [14]
K-Q-J-10-9 suited -> category straight-flush, tieBreakers [13]
...downward by ordinary high card
```

These synthetic keys are local to Pai Gow; do not change the standard comparator.

Joker algorithm:

```text
1. Four natural Aces + Joker -> five-aces
2. Otherwise enumerate createDeck() as possible Joker substitutions
3. Skip an exact standard card already present
4. Any Ace substitution is allowed because Joker may act as Ace
5. A non-Ace substitution is allowed only when the resulting Pai Gow category is straight, flush, straight-flush, or royal-flush
6. Compare all allowed candidates after Pai Gow normalization and keep the best
```

Two-card ranking maps Joker to rank 14 and supports only Pair / High Card.

- [ ] **Step 6: Run ranking tests**

```bash
bun test src/lib/pai-gow-poker/rules.test.ts
```

Expected: PASS.

- [ ] **Step 7: Add arrangement validation tests**

Pin exact user-facing errors:

```ts
expect(getArrangementError(cards, [])).toBe('Choose exactly two cards for the Low hand');
expect(getArrangementError(cards, [0, 0])).toBe('Low hand cards must be distinct');
expect(getArrangementError(cards, [-1, 2])).toBe('Low hand card index is out of range');
```

Add a valid split and a foul fixture that returns:

```text
High hand must rank higher than Low hand
```

- [ ] **Step 8: Implement `getArrangement` / `getArrangementError`**

Requirements:

```text
cards.length must be 7
two low indexes exactly
distinct indexes in 0..6
accepted low indexes stored ascending
the other five original cards become High
High ranking must compare > Low ranking
getArrangement returns null for incomplete/fouled user selections
```

- [ ] **Step 9: Write failing house-way tests**

Create `house-way.test.ts` and pin:

```text
a fixture where the best High is not the first enumerated split
when High ties, stronger Low wins
when High+Low rankings tie, smaller [left,right] wins
constant-zero player 3♥..9♥ -> Low [0,1]
constant-zero dealer 10♥ J♥ Q♥ K♥ A♥ 2♦ 3♦ -> Low [5,6]
```

- [ ] **Step 10: Implement exactly 21 split choices**

Create `house-way.ts`:

```ts
export function arrangeHouseWay(cards: readonly PaiGowCard[]): PaiGowArrangement {
  if (cards.length !== 7) throw new RangeError('Pai Gow house way requires exactly seven cards');

  let best: PaiGowArrangement | null = null;
  for (let left = 0; left < 6; left += 1) {
    for (let right = left + 1; right < 7; right += 1) {
      const candidate = getArrangement(cards, [left, right]);
      if (!candidate) continue;
      // choose stronger High, then stronger Low, then smaller [left,right]
    }
  }

  if (!best) throw new Error('No valid Pai Gow arrangement found');
  return best;
}
```

No configuration or named casino house-way table.

- [ ] **Step 11: Run the pure rules block**

```bash
bun test src/lib/pai-gow-poker/cards.test.ts src/lib/pai-gow-poker/rules.test.ts src/lib/pai-gow-poker/house-way.test.ts
```

Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/lib/pai-gow-poker
git commit -m "feat(pai-gow-poker): add pure hand rules and house way"
```

---

## Task 4: Add game lifecycle, wager validation, and payout math

**Files:**
- Create: `src/lib/pai-gow-poker/game.ts`
- Create: `src/lib/pai-gow-poker/game.test.ts`
- Create: `src/lib/pai-gow-poker/index.ts`

**Interfaces:**

```ts
export const MIN_WAGER = 20;
export const MAX_WAGER = 500;
export const WAGER_OPTIONS = [20, 40, 100, 200, 500] as const;
export const COMMISSION_PERCENT = 5;

export type PaiGowPhase = 'betting' | 'arranging' | 'complete';

export interface PaiGowPokerState {
  phase: PaiGowPhase;
  balance: number;
  wager: number;
  playerCards: PaiGowCard[];
  dealerCards: PaiGowCard[];
  lowIndexes: number[];
  result: PaiGowRoundResult | null;
}

export class PaiGowPokerGame {
  constructor(initialBalance: number, random?: () => number);
  getState(): Readonly<PaiGowPokerState>;
  getWagerError(wager: number): string | null;
  setWager(wager: number): void;
  deal(): void;
  toggleLowCard(index: number): void;
  autoArrange(): void;
  resetArrangement(): void;
  getArrangementError(): string | null;
  confirm(): PaiGowRoundResult;
  resetRound(): void;
  setBalance(balance: number): void;
}
```

- [ ] **Step 1: Write failing wager tests**

Pin:

```ts
expect(new PaiGowPokerGame(1000).getState().wager).toBe(20);
expect(game.getWagerError(20.5)).toBe('Wager must be a whole number of chips');
expect(game.getWagerError(19)).toBe('Bet must be between 20 and 500 chips');
expect(game.getWagerError(21)).toBe('Wager must be in 20-chip increments');
expect(new PaiGowPokerGame(30).getWagerError(40)).toBe('Wager exceeds available balance');
```

Run `bun test src/lib/pai-gow-poker/game.test.ts`; expected FAIL because `game.ts` is missing.

- [ ] **Step 2: Implement state + wager invariants**

Use:

```ts
function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new RangeError('Balance must be a non-negative finite number');
  }
  return Math.trunc(balance);
}
```

Validation order: integer -> `validateBet(20..500)` -> divisible by 20 -> affordable. `setWager` only works during `betting`.

- [ ] **Step 3: Add deterministic Deal/selection tests**

With `random = () => 0`, pin:

```text
1,000 at wager 20 -> balance 980
player -> 3♥ 4♥ 5♥ 6♥ 7♥ 8♥ 9♥
dealer -> 10♥ J♥ Q♥ K♥ A♥ 2♦ 3♦
phase -> arranging
lowIndexes -> []
```

Then pin:

```text
toggle 0 -> [0]
toggle 1 -> [0,1]
toggle 2 -> still [0,1]
toggle 0 -> [1]
Reset -> [] without redeal or balance change
Auto Arrange deterministic player -> [0,1]
```

- [ ] **Step 4: Implement Deal + arrangement mutations**

Deal exactly:

```ts
const deck = createShuffledPaiGowDeck(this.random);
this.state = {
  ...this.state,
  phase: 'arranging',
  balance: this.state.balance - this.state.wager,
  playerCards: deck.slice(0, 7),
  dealerCards: deck.slice(7, 14),
  lowIndexes: [],
  result: null,
};
```

Ignore a third Low selection instead of replacing a previous selection. Do not store the remaining deck.

- [ ] **Step 5: Add Confirm rejection and payout tests**

Pin:

```text
incomplete split -> throws current arrangement error
foul -> throws "High hand must rank higher than Low hand"
win wager 20 -> commission 1, gross 39, net +19
push wager 20 -> commission 0, gross 20, net 0
loss wager 20 -> commission 0, gross 0, net -20
```

Use deterministic random sequences in tests; do not add a production `setHands` hook.

- [ ] **Step 6: Implement comparison + payout in `confirm()`**

```ts
const player = getArrangement(this.state.playerCards, this.state.lowIndexes);
if (!player) throw new Error(this.getArrangementError() ?? 'Invalid Pai Gow arrangement');
const dealer = arrangeHouseWay(this.state.dealerCards);

const wonHigh = comparePaiGowRankings(player.highRanking, dealer.highRanking) > 0;
const wonLow = comparePaiGowRankings(player.lowRanking, dealer.lowRanking) > 0;
const outcome = wonHigh && wonLow ? 'win' : wonHigh !== wonLow ? 'push' : 'loss';
const commission = outcome === 'win' ? this.state.wager / 20 : 0;
const grossPayout =
  outcome === 'win' ? this.state.wager * 2 - commission : outcome === 'push' ? this.state.wager : 0;
const netDelta = grossPayout - this.state.wager;
```

Credit gross payout, snapshot player/dealer arrangements into result, then enter `complete`.

- [ ] **Step 7: Add Reset/adopt-balance tests and implementation**

Pin:

```text
resetRound after complete -> betting, cards/result/selection cleared, wager retained
setBalance(777) -> 777
setBalance(-1) -> RangeError
```

`setBalance` knows nothing about wallet transport.

- [ ] **Step 8: Export the focused local API and run the module**

Create `index.ts` exporting only public game/rules/card types/functions used by route/client/tests. Do not export wildcard substitution helpers or strength maps.

Run:

```bash
bun test src/lib/pai-gow-poker/
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/pai-gow-poker
git commit -m "feat(pai-gow-poker): add game lifecycle and payouts"
```

---

## Task 5: Register the game and build click/select page/client behavior

**Files:**
- Modify: `src/lib/game-stats/constants.ts`
- Modify: exact game-stat test returned by `git grep -l "isValidGameType" -- 'src/**/*.test.ts'`
- Create: `src/pages/games/pai-gow-poker.astro`
- Create: `src/lib/pai-gow-poker/client.ts`
- Create: `src/lib/pai-gow-poker/client.init.test.ts`
- Modify: `src/pages/index.astro`
- Create: `e2e/pai-gow-poker.spec.ts`

**Interfaces:**
- Consumes: `createPublicGameSession`, `CardSlot`, `setSlotState`, `PaiGowPokerGame`, `createPublicGameSettlementController`.
- Produces: playable route + deterministic guest acceptance flow.

- [ ] **Step 1: Add a failing game-registry assertion**

Add in the existing game-type test:

```ts
expect(GAME_TYPES).toContain('pai-gow-poker');
expect(GAME_TYPES.length).toBe(11);
expect(isValidGameType('pai-gow-poker')).toBe(true);
```

Run that exact test file. Expected: FAIL.

- [ ] **Step 2: Register the game**

Append:

```ts
'pai-gow-poker',
```

and typed map entries:

```ts
'pai-gow-poker': 'Pai Gow Poker',
'pai-gow-poker': '🃏',
```

Run the registry test. Expected: PASS.

- [ ] **Step 3: Create the real Astro route with pre-rendered nodes**

Use:

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import CardSlot from '../../components/CardSlot.astro';
import { createPublicGameSession } from '../../lib/public-game-session';
import { WAGER_OPTIONS } from '../../lib/pai-gow-poker';

const gameSession = createPublicGameSession(Astro.locals.user);
---
```

Root contract:

```astro
<main
  id="pai-gow-poker-root"
  data-testid="pai-gow-poker-root"
  data-user-id={gameSession.clientUserId}
  data-guest-mode={gameSession.guestModeValue}
  data-initial-balance={gameSession.initialBalance}
>
```

Pre-render exactly seven player card buttons containing `CardSlot`, with stable `data-card-index="0"` through `"6"`. Also pre-render High/unassigned + Low containers, 5 dealer High slots, 2 dealer Low slots, wager buttons, Deal, Auto Arrange, Reset, Confirm, New Round, live status/result nodes, and settlement recovery host.

- [ ] **Step 4: Write failing Happy-DOM interaction tests**

Create `client.init.test.ts` with a DOM fixture matching the real IDs. Cover:

```text
Deal -> player face-up, dealer face-down
click index 0 -> exact same button node moves to Low, aria-pressed=true
click index 1 -> Low contains exactly two nodes
click third unselected card -> still exactly two Low nodes
click selected node -> same node returns High, aria-pressed=false
Auto Arrange -> exactly two Low nodes
Reset -> all seven return High/unassigned
foul -> Confirm does not resolve and status shows foul text
successful Confirm -> dealer High/Low reveal
New Round -> placeholders return and wager remains selected
```

Run:

```bash
bun test src/lib/pai-gow-poker/client.init.test.ts
```

Expected: FAIL because `client.ts` is missing.

- [ ] **Step 5: Implement the client with existing settlement composition**

Construct:

```ts
const settlement = createPublicGameSettlementController({
  gameKey: 'pai-gow-poker',
  root,
  recoveryHost,
  resetLabel: 'Reset round',
  messages: {
    failed: 'Settlement failed. Retry or reset before starting another round.',
    retrying: 'Retrying settlement...',
    retryFailed: 'Settlement failed again. Retry or reset before starting another round.',
  },
  render,
  onAdoptBalance: (balance) => game.setBalance(balance),
  onResetRound: () => {
    if (game.getState().phase === 'complete') game.resetRound();
    arrangementMessage = null;
  },
});
const game = new PaiGowPokerGame(settlement.startingBalance);
```

Display adapter:

```ts
function toCardData(card: PaiGowCard): { rank: string; suit: string } {
  if (isPaiGowJoker(card)) return { rank: '★', suit: '★' };
  return { rank: rankLabel(card.rank), suit: card.suit };
}
```

Rendering must move the existing seven button nodes with `append(...)`; do not recreate card HTML.

Confirm path:

```ts
const error = game.getArrangementError();
if (error) {
  arrangementMessage = error;
  render();
  return;
}
const result = game.confirm();
render();
await settlement.completeRound(result.netDelta, game.getState().balance);
render();
```

Disable New Round while `settlement.isBlocked`.

- [ ] **Step 6: Add the lobby card without extracting a component**

Add `/games/pai-gow-poker` to `src/pages/index.astro` using the existing game-card markup near other card/poker games.

- [ ] **Step 7: Run unit + build gates**

```bash
bun test src/lib/pai-gow-poker/ src/lib/five-card-poker.test.ts
bun run build
```

Expected: PASS.

- [ ] **Step 8: Add the deterministic guest E2E**

Before page scripts:

```ts
await page.addInitScript(() => {
  Math.random = () => 0;
});
```

Exercise:

```text
open /games/pai-gow-poker as guest
balance 1,000
Deal -> 980; player is 3♥..9♥
Auto Arrange -> Low 3♥ 4♥
Confirm -> dealer Royal High + 2♦ 3♦ Low; outcome Push; balance 1,000
no /api/wallet/settle request
New Round -> betting; wager 20 retained
```

Use `data-testid` selectors, not layout CSS.

- [ ] **Step 9: Run guest E2E serially**

```bash
bunx playwright test e2e/pai-gow-poker.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/game-stats src/lib/pai-gow-poker src/pages/games/pai-gow-poker.astro src/pages/index.astro e2e/pai-gow-poker.spec.ts
git commit -m "feat(pai-gow-poker): add playable arrangement flow"
```

---

## Task 6: Add authenticated acceptance, profile integration, and final scope checks

**Files:**
- Modify: `e2e/pai-gow-poker.spec.ts`
- Modify: `e2e/profile-statistics.spec.ts`
- Modify only if grep proves necessary: files returned by `git grep -n "GAME_TYPES.length\|three-card-showdown" -- src e2e`

**Interfaces:**
- Consumes: existing wallet controller/API only.
- Produces: authenticated settlement acceptance + canonical game-list coverage.

- [ ] **Step 1: Add one authenticated settlement test**

Use the existing auth setup from Three-Card Showdown or Sic Bo. Capture `/api/wallet/settle`, return a success, and with the deterministic Push fixture assert exactly one command:

```ts
expect(commands).toHaveLength(1);
expect(commands[0]).toMatchObject({
  game: 'pai-gow-poker',
  delta: 0,
  stats: { rounds: 1, wins: 0, losses: 0, biggestWin: 0 },
});
expect(typeof commands[0].settlementId).toBe('string');
```

Do not duplicate the shared 503 -> Retry/Reset matrix; `public-game-settlement.test.ts` already owns exact-command recovery semantics.

- [ ] **Step 2: Update profile statistics' complete game list**

Add `pai-gow-poker` / `Pai Gow Poker` wherever `e2e/profile-statistics.spec.ts` pins supported games. Keep the existing assertion style.

- [ ] **Step 3: Run focused browser acceptance**

```bash
bunx playwright test e2e/pai-gow-poker.spec.ts e2e/profile-statistics.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 4: Run shared + game unit coverage**

```bash
bun test src/lib/cards.test.ts src/lib/five-card-poker.test.ts src/lib/poker/handEvaluator.test.ts src/lib/poker/PokerGame.test.ts src/lib/pai-gow-poker/
```

Expected: PASS.

- [ ] **Step 5: Run repository gates**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: all PASS.

- [ ] **Step 6: Run the scope guard**

```bash
git diff main...HEAD -- src/lib/cards.ts src/lib/five-card-poker.ts src/lib/poker/handEvaluator.ts
git diff --name-only main...HEAD
git grep -n "pai-gow\|Pai Gow" -- src e2e
```

Verify:

```text
cards.ts only generalizes shuffle typing
five-card-poker.ts contains ordinary standard poker comparison only
poker/handEvaluator.ts only delegates its former private five-card comparison
all Joker, Pai Gow straight ordering, arrangement, house-way, commission, and UI logic remains Pai-Gow-local
no migration, endpoint, drag manager, AI layer, strategy registry, side-bet module, queue, or compatibility wrapper exists
```

If any shared module has Pai Gow/Joker options, move that behavior back into `src/lib/pai-gow-poker/` before review.

- [ ] **Step 7: Commit acceptance coverage**

```bash
git add e2e/pai-gow-poker.spec.ts e2e/profile-statistics.spec.ts
git commit -m "test(pai-gow-poker): cover wallet and profile integration"
```

---

## Final Review Checklist

- [ ] `shuffleDeck<T>` is the only shared card/deck change.
- [ ] The neutral five-card comparator contains only ordinary poker rules and standard wheel ordering.
- [ ] Texas Hold'em public behavior/card model is unchanged.
- [ ] Video Poker, Three-Card Showdown, and Blackjack evaluators/card models are unchanged.
- [ ] Joker and Pai Gow straight-order rules are confined to `src/lib/pai-gow-poker/`.
- [ ] House way is one deterministic 21-split function with no configuration.
- [ ] Player interaction is click/select node movement only; no drag dependency or generic arrangement component exists.
- [ ] Wagers are 20-chip increments, so 5% commission is always an integer chip amount.
- [ ] Dealer copies win and win/push/loss semantics match the design.
- [ ] Guest play never calls the wallet endpoint.
- [ ] Authenticated completion creates exactly one net wallet settlement.
- [ ] No schema migration, API endpoint, persistence queue, automatic retry policy, AI, ranked mode, replay/history, side bet, banking, or compatibility code is added.
- [ ] Focused Playwright acceptance and repository test/lint/format/build gates pass before the implementation PR is marked ready.
