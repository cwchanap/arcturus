# HPA-197 Focused Pai Gow Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused single-player Pai Gow Poker game with seven-card arrangement, a semi-wild Joker, deterministic dealer arrangement, 5% commission, and the existing public-game wallet settlement flow.

**Architecture:** Reuse the neutral standard-card deck and make only its Fisher-Yates shuffle type-generic. Extract the already-existing ordinary five-card poker ranking/comparison core from Texas Hold'em into one small structural module; keep Hold'em combination logic local and keep every Pai Gow-specific rule—Joker substitution, unusual straight ordering, two-card comparison, arrangement validation, house way, payouts, game state, and DOM interaction—inside `src/lib/pai-gow-poker/`. Compose the existing `createPublicGameSettlementController` without adding a new persistence, retry, client-controller, or rules framework.

**Tech Stack:** Astro 5, TypeScript, Bun tests, Happy DOM, Playwright, existing Cloudflare Worker/D1 wallet API.

## Global Constraints

- Route: `/games/pai-gow-poker`.
- Game key: `pai-gow-poker`; label: `Pai Gow Poker`; icon: `🃏`; it becomes `GAME_TYPES` entry 11.
- Use a 53-card deck: the shared 52-card deck plus exactly one Pai Gow-local Joker.
- Joker is an Ace by default; it may complete a straight, flush, straight flush, or Royal Flush; Four Aces + Joker is Five Aces.
- Five-card order: Five Aces > Royal Flush > Straight Flush > Four of a Kind > Full House > Flush > Straight > Three of a Kind > Two Pair > Pair > High Card.
- Straight order: A-K-Q-J-10 highest; A-2-3-4-5 second; K-Q-J-10-9 third, then downward.
- Non-Royal straight-flush order: A-2-3-4-5 highest, then K-Q-J-10-9, then downward; Royal Flush stays above all of them.
- The Low hand has exactly two cards and can rank only Pair or High Card; its Joker always acts as Ace.
- The five-card High hand must rank strictly higher than the two-card Low hand; equal or lower is a foul.
- Dealer copies win: the player must strictly beat the dealer in a sub-hand to win that sub-hand.
- Overall outcome is `win` only when the player wins both sub-hands, `push` when the player wins exactly one, and `loss` otherwise.
- House way: enumerate all 21 two-card Low choices, reject fouls, maximize High ranking first, then Low ranking, then choose the lexicographically smallest low-index pair.
- Main wager only. `MIN_WAGER = 20`, `MAX_WAGER = 500`, `WAGER_OPTIONS = [20, 40, 100, 200, 500]`, and every valid wager is divisible by 20.
- A win charges exactly 5% commission: gross payout `2 * wager - wager / 20`, net delta `wager - wager / 20`; push gross payout `wager`, net `0`; loss gross payout `0`, net `-wager`.
- Initial wager is exactly `WAGER_OPTIONS[0]` (`20`).
- Guest rounds stay local. Authenticated Confirm produces exactly one net settlement through `createPublicGameSettlementController`.
- Reuse `validateBet`, `CardSlot`, `setSlotState`, `createPublicGameSession`, and `createPublicGameSettlementController` unchanged.
- No side bets, banking, commission-free variant, drag-and-drop system, generic card-arrangement component, generic wildcard engine, configurable house-way platform, base game class, AI, ranked mode, history, replay, new API, schema migration, settlement queue, automatic retry, or compatibility layer.
- Do not migrate Texas Hold'em's `{ value, suit, rank }` card model, Blackjack cards, Video Poker's Jacks-or-Better evaluator, or Three-Card Showdown's three-card evaluator.

---

## Task 1: Make the existing shuffle algorithm type-generic

**Files:**
- Modify: `src/lib/cards.ts`
- Modify: `src/lib/cards.test.ts`

**Interfaces:**
- Consumes: existing `createDeck()` and Fisher-Yates implementation.
- Produces:

```ts
export function shuffleDeck<T>(
  deck: readonly T[],
  random?: () => number,
): T[];
```

`createDeck()` and `createShuffledDeck()` remain standard-52-card APIs returning `Card[]`.

- [ ] **Step 1: Add a test proving shuffle preserves arbitrary structural values without mutation**

Add to `src/lib/cards.test.ts`:

```ts
test('shuffleDeck works for arbitrary item types without mutating input', () => {
  const input = [
    { id: 'a', special: false },
    { id: 'b', special: true },
    { id: 'c', special: false },
  ] as const;

  const result = shuffleDeck(input, () => 0);

  expect(result).toEqual([
    { id: 'b', special: true },
    { id: 'c', special: false },
    { id: 'a', special: false },
  ]);
  expect(input.map((item) => item.id)).toEqual(['a', 'b', 'c']);
});
```

- [ ] **Step 2: Run the shared-card suite before changing the signature**

```bash
bun test src/lib/cards.test.ts
```

Expected: the new test fails TypeScript checking because `shuffleDeck` currently accepts only `readonly Card[]`.

- [ ] **Step 3: Generalize only the function signature**

Change `src/lib/cards.ts` from:

```ts
export function shuffleDeck(deck: readonly Card[], random: () => number = Math.random): Card[] {
  const shuffled = [...deck];
```

to:

```ts
export function shuffleDeck<T>(deck: readonly T[], random: () => number = Math.random): T[] {
  const shuffled = [...deck];
```

Leave the Fisher-Yates body unchanged. Do not add deck configuration or Joker knowledge.

- [ ] **Step 4: Run the shared-card suite**

```bash
bun test src/lib/cards.test.ts
```

Expected: PASS, including the existing 52-card and deterministic constant-zero fixtures.

- [ ] **Step 5: Commit the type-only generalization**

```bash
git add src/lib/cards.ts src/lib/cards.test.ts
git commit -m "refactor(cards): generalize shuffle item type"
```

---

## Task 2: Extract the ordinary five-card poker comparator from Texas Hold'em

**Files:**
- Create: `src/lib/five-card-poker.ts`
- Create: `src/lib/five-card-poker.test.ts`
- Modify: `src/lib/poker/handEvaluator.ts`
- Test: `src/lib/poker/handEvaluator.test.ts`

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

export function rankFiveCardHand(
  cards: readonly FiveCardRankable[],
): FiveCardRanking;

export function compareFiveCardRankings(
  left: FiveCardRanking,
  right: FiveCardRanking,
): -1 | 0 | 1;
```

- [ ] **Step 1: Write focused tests for the public standard comparator**

Create `src/lib/five-card-poker.test.ts` with helper:

```ts
const c = (rank: number, suit = 'spades') => ({ rank, suit });
```

Pin the important ordinary-poker behavior:

```ts
test('treats the standard wheel as 5-high', () => {
  const wheel = rankFiveCardHand([c(14), c(2), c(3), c(4), c(5)]);
  const sixHigh = rankFiveCardHand([c(2), c(3), c(4), c(5), c(6)]);
  expect(compareFiveCardRankings(wheel, sixHigh)).toBe(-1);
});

test('compares full houses by trips before pair', () => {
  const kings = rankFiveCardHand([c(13), c(13), c(13), c(2), c(2)]);
  const queens = rankFiveCardHand([c(12), c(12), c(12), c(14), c(14)]);
  expect(compareFiveCardRankings(kings, queens)).toBe(1);
});

test('compares two-pair kickers', () => {
  const ace = rankFiveCardHand([c(10), c(10), c(8), c(8), c(14)]);
  const king = rankFiveCardHand([c(10), c(10), c(8), c(8), c(13)]);
  expect(compareFiveCardRankings(ace, king)).toBe(1);
});

test('returns zero for identical rankings regardless of suit', () => {
  const left = rankFiveCardHand([c(14, 'spades'), c(13), c(11), c(8), c(4)]);
  const right = rankFiveCardHand([
    c(14, 'hearts'),
    c(13, 'diamonds'),
    c(11, 'clubs'),
    c(8, 'hearts'),
    c(4, 'clubs'),
  ]);
  expect(compareFiveCardRankings(left, right)).toBe(0);
});
```

- [ ] **Step 2: Run the new suite and verify the module is missing**

```bash
bun test src/lib/five-card-poker.test.ts
```

Expected: FAIL because `src/lib/five-card-poker.ts` does not exist.

- [ ] **Step 3: Move the existing private ranking algorithm into the shared module**

Use the implementation already present in `src/lib/poker/handEvaluator.ts` as the source of truth rather than independently re-deriving categories.

Normalize the result into category + tie-breakers. For example:

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

Represent tie-breaking in one ordered array:

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

Do not create a separate Royal Flush category; A-high straight flush naturally wins with `[14]`.

- [ ] **Step 4: Run the shared comparator tests**

```bash
bun test src/lib/five-card-poker.test.ts
```

Expected: PASS.

- [ ] **Step 5: Replace only the private Hold'em five-card rank/comparison functions**

At the top of `src/lib/poker/handEvaluator.ts` add:

```ts
import {
  compareFiveCardRankings,
  rankFiveCardHand,
  type FiveCardRanking,
} from '../five-card-poker';
```

Delete the local `HandRank`, `HandRanking`, `rankFiveCardHand`, and `compareHandRankings` implementations.

Keep `findBestHand` in this file, changing its type and comparator calls:

```ts
function findBestHand(cards: Card[]): FiveCardRanking {
  // existing combination generation stays here
  let bestRanking = rankFiveCardHand(combinations[0]);
  for (let i = 1; i < combinations.length; i += 1) {
    const ranking = rankFiveCardHand(combinations[i]);
    if (compareFiveCardRankings(ranking, bestRanking) > 0) {
      bestRanking = ranking;
    }
  }
  return bestRanking;
}
```

Update `determineShowdownWinners` to call `compareFiveCardRankings` in the same places the old comparator was called. Do not change its public signature.

- [ ] **Step 6: Run both the shared and existing Hold'em evaluator suites**

```bash
bun test src/lib/five-card-poker.test.ts src/lib/poker/handEvaluator.test.ts src/lib/poker/PokerGame.test.ts
```

Expected: PASS with no behavior change in Hold'em.

- [ ] **Step 7: Verify unrelated card games are untouched**

```bash
git diff -- src/lib/video-poker src/lib/three-card-showdown src/lib/blackjack
```

Expected: empty.

- [ ] **Step 8: Commit the extraction**

```bash
git add src/lib/five-card-poker.ts src/lib/five-card-poker.test.ts src/lib/poker/handEvaluator.ts
git commit -m "refactor(poker): share five-card hand comparison"
```

---

## Task 3: Add Pai Gow cards, rankings, arrangement validation, and deterministic house way

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
- Produces the complete pure Pai Gow rules boundary used by the game state in Task 4.

- [ ] **Step 1: Define local card and ranking types**

Create `src/lib/pai-gow-poker/types.ts`:

```ts
import type { Card } from '../cards';

export interface PaiGowJoker {
  rank: 'joker';
  suit: 'joker';
}

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

- [ ] **Step 2: Write the local 53-card deck tests**

Create `src/lib/pai-gow-poker/cards.test.ts` and assert:

```ts
test('creates 52 unique standard cards plus one Joker', () => {
  const deck = createPaiGowDeck();
  expect(deck).toHaveLength(53);
  expect(deck.filter(isPaiGowJoker)).toHaveLength(1);
  expect(
    new Set(
      deck.filter((card) => !isPaiGowJoker(card)).map((card) => `${card.rank}:${card.suit}`),
    ).size,
  ).toBe(52);
});

test('constant-zero shuffle pins the first fourteen cards', () => {
  expect(createShuffledPaiGowDeck(() => 0).slice(0, 14)).toEqual([
    { rank: 3, suit: 'hearts' },
    { rank: 4, suit: 'hearts' },
    { rank: 5, suit: 'hearts' },
    { rank: 6, suit: 'hearts' },
    { rank: 7, suit: 'hearts' },
    { rank: 8, suit: 'hearts' },
    { rank: 9, suit: 'hearts' },
    { rank: 10, suit: 'hearts' },
    { rank: 11, suit: 'hearts' },
    { rank: 12, suit: 'hearts' },
    { rank: 13, suit: 'hearts' },
    { rank: 14, suit: 'hearts' },
    { rank: 2, suit: 'diamonds' },
    { rank: 3, suit: 'diamonds' },
  ]);
});
```

- [ ] **Step 3: Run the deck tests and verify the local module is missing**

```bash
bun test src/lib/pai-gow-poker/cards.test.ts
```

Expected: FAIL because `cards.ts` does not exist.

- [ ] **Step 4: Implement the local Joker deck**

Create `src/lib/pai-gow-poker/cards.ts`:

```ts
import { createDeck, shuffleDeck } from '../cards';
import type { PaiGowCard, PaiGowJoker } from './types';

export const PAI_GOW_JOKER: PaiGowJoker = {
  rank: 'joker',
  suit: 'joker',
};

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

Run:

```bash
bun test src/lib/pai-gow-poker/cards.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write Joker, straight-order, and two-card ranking tests**

Create `src/lib/pai-gow-poker/rules.test.ts` with focused fixtures that assert:

```text
A A A A Joker                           -> five-aces
10♠ J♠ Q♠ K♠ Joker                    -> royal-flush
A 2 3 4 5                              -> straight and beats K Q J 10 9
A 2 3 4 5                              -> loses to A K Q J 10
A♠ 2♠ 3♠ 4♠ 5♠                       -> highest non-Royal straight-flush
Joker + four hearts lacking one heart -> Joker completes flush
Joker + 9 9 9 K                        -> Joker stays Ace; does not create quads
Joker + 7 7 K Q                        -> Joker stays Ace; does not create trips
[Joker, Ace] two-card hand             -> pair of Aces
[Joker, King] two-card hand            -> Ace-King high
```

For the two prohibited wildcard cases, assert exact categories/tie breakers rather than merely “not stronger.”

- [ ] **Step 6: Run the ranking tests and verify failure**

```bash
bun test src/lib/pai-gow-poker/rules.test.ts
```

Expected: FAIL because `rules.ts` does not exist.

- [ ] **Step 7: Implement local ranking without a wildcard framework**

Create `src/lib/pai-gow-poker/rules.ts`.

Use a local category strength map:

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

For Joker substitution, enumerate `createDeck()` and accept candidates using exactly this rule:

```ts
const mayUseNonAceSubstitution = (
  ranking: PaiGowHandRanking,
): boolean =>
  ranking.category === 'straight' ||
  ranking.category === 'flush' ||
  ranking.category === 'straight-flush' ||
  ranking.category === 'royal-flush';
```

Algorithm:

```text
1. no Joker -> rank ordinary five-card hand, then normalize Pai Gow straight/SF order
2. four natural Aces + Joker -> five-aces
3. otherwise enumerate 52 standard substitution cards
4. skip an exact standard card already present
5. Ace substitution is always permitted
6. non-Ace substitution is permitted only for straight/flush/straight-flush/Royal
7. normalize every permitted result to Pai Gow ordering
8. keep the highest result
```

Do not expose substitution configuration.

For `rankPaiGowTwoCardHand`, map Joker to rank 14 and compare only Pair or descending High Card.

- [ ] **Step 8: Run the ranking tests**

```bash
bun test src/lib/pai-gow-poker/rules.test.ts
```

Expected: PASS.

- [ ] **Step 9: Write arrangement validation tests**

In `rules.test.ts`, add seven-card fixture tests for:

```ts
expect(getArrangementError(cards, [])).toBe('Choose exactly two cards for the Low hand');
expect(getArrangementError(cards, [0, 0])).toBe('Low hand cards must be distinct');
expect(getArrangementError(cards, [-1, 2])).toBe('Low hand card index is out of range');
expect(getArrangementError(cards, [0, 7])).toBe('Low hand card index is out of range');
```

Add one valid split and one fouled split where the two-card pair is not strictly below the five-card High hand. Pin the foul text:

```text
High hand must rank higher than Low hand
```

- [ ] **Step 10: Implement `getArrangement` and `getArrangementError`**

Use original deal indexes as identity. Sort accepted Low indexes numerically before storing them so house-way tie-breaking and rendering are stable.

Return `null` from `getArrangement` when validation fails; never throw for user-selected foul/incomplete arrangements.

- [ ] **Step 11: Write deterministic house-way tests**

Create `src/lib/pai-gow-poker/house-way.test.ts`.

Pin three rules:

```text
- a fixture where the best High split is not the first of the 21 combinations
- when two splits have equal High, the stronger Low wins
- when High and Low rankings both tie, the lexicographically smaller low-index pair wins
```

Also assert the constant-zero deterministic player/dealer fixture from the design:

```text
Player 3♥ 4♥ 5♥ 6♥ 7♥ 8♥ 9♥ -> Low [0,1], High 5♥..9♥
Dealer 10♥ J♥ Q♥ K♥ A♥ 2♦ 3♦ -> Low [5,6], High Royal Flush
```

- [ ] **Step 12: Implement the 21-split house way**

Create `src/lib/pai-gow-poker/house-way.ts`:

```ts
export function arrangeHouseWay(cards: readonly PaiGowCard[]): PaiGowArrangement {
  if (cards.length !== 7) {
    throw new RangeError('Pai Gow house way requires exactly seven cards');
  }

  let best: PaiGowArrangement | null = null;
  for (let left = 0; left < 6; left += 1) {
    for (let right = left + 1; right < 7; right += 1) {
      const candidate = getArrangement(cards, [left, right]);
      if (!candidate) continue;
      // compare High, then Low, then [left, right] lexicographically
    }
  }

  if (!best) throw new Error('No valid Pai Gow arrangement found');
  return best;
}
```

Do not add strategy options or named house-way variants.

- [ ] **Step 13: Run all pure Pai Gow rule suites**

```bash
bun test src/lib/pai-gow-poker/cards.test.ts src/lib/pai-gow-poker/rules.test.ts src/lib/pai-gow-poker/house-way.test.ts
```

Expected: PASS.

- [ ] **Step 14: Commit the pure Pai Gow rules**

```bash
git add src/lib/pai-gow-poker/types.ts src/lib/pai-gow-poker/cards.ts src/lib/pai-gow-poker/cards.test.ts src/lib/pai-gow-poker/rules.ts src/lib/pai-gow-poker/rules.test.ts src/lib/pai-gow-poker/house-way.ts src/lib/pai-gow-poker/house-way.test.ts
git commit -m "feat(pai-gow-poker): add pure hand rules and house way"
```

---

## Task 4: Add the pure Pai Gow game lifecycle and payout math

**Files:**
- Create: `src/lib/pai-gow-poker/game.ts`
- Create: `src/lib/pai-gow-poker/game.test.ts`
- Create: `src/lib/pai-gow-poker/index.ts`

**Interfaces:**
- Consumes: `createShuffledPaiGowDeck`, `getArrangement`, `getArrangementError`, `arrangeHouseWay`, `comparePaiGowRankings`, `validateBet`.
- Produces:

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

- [ ] **Step 1: Write wager validation tests**

Create `src/lib/pai-gow-poker/game.test.ts` and pin:

```ts
expect(new PaiGowPokerGame(1000).getState().wager).toBe(20);
expect(game.getWagerError(21)).toBe('Wager must be in 20-chip increments');
expect(game.getWagerError(19)).toBe('Bet must be between 20 and 500 chips');
expect(new PaiGowPokerGame(30).getWagerError(40)).toBe('Wager exceeds available balance');
```

Also cover non-integer input with:

```text
Wager must be a whole number of chips
```

- [ ] **Step 2: Run the new game suite and verify failure**

```bash
bun test src/lib/pai-gow-poker/game.test.ts
```

Expected: FAIL because `game.ts` does not exist.

- [ ] **Step 3: Implement state construction and wager invariants**

Use the same balance normalization shape as the recent small games:

```ts
function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new RangeError('Balance must be a non-negative finite number');
  }
  return Math.trunc(balance);
}
```

`getWagerError` order:

```text
1. integer check
2. validateBet(wager, 20, 500)
3. divisible by 20
4. affordable against current balance
```

`setWager` may change only in `betting` and throws on an invariant violation.

- [ ] **Step 4: Add deal/selection/reset tests using constant-zero randomness**

Pin:

```text
Deal from 1,000 at wager 20 -> balance 980
player cards -> 3♥ through 9♥
dealer cards -> 10♥, J♥, Q♥, K♥, A♥, 2♦, 3♦
phase -> arranging
lowIndexes -> []
```

Then assert:

```text
toggleLowCard(0) -> [0]
toggleLowCard(1) -> [0,1]
toggleLowCard(2) -> remains [0,1]
toggleLowCard(0) -> [1]
resetArrangement() -> [] without changing cards or balance
autoArrange() on deterministic player -> [0,1]
```

- [ ] **Step 5: Implement Deal and arrangement mutations**

`deal()` must:

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

Do not expose or persist the remaining deck.

`toggleLowCard` accepts only indexes 0..6 during `arranging`; selected indexes toggle off, and a third selection is ignored rather than replacing another card implicitly.

- [ ] **Step 6: Write Confirm rejection and payout tests**

Cover:

```text
Confirm with fewer than two Low cards -> throws the current arrangement error
Confirm with a fouled split -> throws "High hand must rank higher than Low hand"
win at wager 20 -> commission 1, gross payout 39, netDelta +19
push at wager 20 -> commission 0, gross payout 20, netDelta 0
loss at wager 20 -> commission 0, gross payout 0, netDelta -20
```

Use explicit fixed seven-card player/dealer arrays by setting up deterministic `random` fixtures or a tiny test-only deterministic sequence; do not add a production `setHands` method.

- [ ] **Step 7: Implement comparison and payout resolution in `confirm()`**

Resolve player and dealer arrangements first:

```ts
const player = getArrangement(this.state.playerCards, this.state.lowIndexes);
if (!player) throw new Error(this.getArrangementError() ?? 'Invalid Pai Gow arrangement');
const dealer = arrangeHouseWay(this.state.dealerCards);

const playerWonHigh = comparePaiGowRankings(player.highRanking, dealer.highRanking) > 0;
const playerWonLow = comparePaiGowRankings(player.lowRanking, dealer.lowRanking) > 0;
```

Then:

```ts
const outcome = playerWonHigh && playerWonLow ? 'win' : playerWonHigh !== playerWonLow ? 'push' : 'loss';
const commission = outcome === 'win' ? this.state.wager / 20 : 0;
const grossPayout =
  outcome === 'win' ? this.state.wager * 2 - commission : outcome === 'push' ? this.state.wager : 0;
const netDelta = grossPayout - this.state.wager;
```

Credit `grossPayout`, store an immutable result snapshot, and enter `complete`.

- [ ] **Step 8: Add reset/adopt-balance tests**

Assert:

```text
resetRound() after completion -> betting, cards/result/selection cleared, wager retained
setBalance(777) -> state balance 777
setBalance(-1) -> RangeError
```

- [ ] **Step 9: Implement reset and balance adoption**

Keep `setBalance` free of wallet knowledge. It only adopts a validated non-negative finite balance.

- [ ] **Step 10: Export only the game-local public surface**

Create `src/lib/pai-gow-poker/index.ts` exporting the card/rule/house-way/game types and functions actually needed by the page, client, and tests. Do not export internal substitution helpers or category-strength maps.

- [ ] **Step 11: Run the full pure module suite**

```bash
bun test src/lib/pai-gow-poker/
```

Expected: PASS.

- [ ] **Step 12: Commit the lifecycle**

```bash
git add src/lib/pai-gow-poker
git commit -m "feat(pai-gow-poker): add game lifecycle and payouts"
```

---

## Task 5: Register the game and build the page/client with click arrangement

**Files:**
- Modify: `src/lib/game-stats/constants.ts`
- Modify: relevant game-stat constant/type-guard tests returned by `git grep -n "GAME_TYPES.length\|three-card-showdown" -- src/lib/game-stats`
- Create: `src/pages/games/pai-gow-poker.astro`
- Create: `src/lib/pai-gow-poker/client.ts`
- Create: `src/lib/pai-gow-poker/client.init.test.ts`
- Modify: `src/pages/index.astro`
- Create: `e2e/pai-gow-poker.spec.ts`

**Interfaces:**
- Consumes: `createPublicGameSession`, `CardSlot`, `setSlotState`, `PaiGowPokerGame`, `createPublicGameSettlementController`.
- Produces: playable `/games/pai-gow-poker` page and deterministic guest acceptance flow.

- [ ] **Step 1: Add the registry test before changing constants**

In the existing game-stat constants/type-guard test, add:

```ts
expect(GAME_TYPES).toContain('pai-gow-poker');
expect(GAME_TYPES.length).toBe(11);
expect(isValidGameType('pai-gow-poker')).toBe(true);
```

Run the exact test file returned by:

```bash
git grep -l "isValidGameType" -- 'src/**/*.test.ts'
```

Expected: FAIL before registration.

- [ ] **Step 2: Register the eleventh game**

Append to `GAME_TYPES`:

```ts
'pai-gow-poker',
```

Add typed maps:

```ts
'pai-gow-poker': 'Pai Gow Poker',
'pai-gow-poker': '🃏',
```

Run the registry test again. Expected: PASS.

- [ ] **Step 3: Create the real Astro route using the established public-game root contract**

At the top of `src/pages/games/pai-gow-poker.astro`:

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import CardSlot from '../../components/CardSlot.astro';
import { createPublicGameSession } from '../../lib/public-game-session';
import { WAGER_OPTIONS } from '../../lib/pai-gow-poker';

const user = Astro.locals.user;
const gameSession = createPublicGameSession(user);
---
```

Root:

```astro
<main
  id="pai-gow-poker-root"
  data-testid="pai-gow-poker-root"
  data-user-id={gameSession.clientUserId}
  data-guest-mode={gameSession.guestModeValue}
  data-initial-balance={gameSession.initialBalance}
>
```

Pre-render:

```text
7 player card buttons, each containing one CardSlot and data-card-index="0".."6"
1 player High/unassigned container
1 player Low container
5 dealer High CardSlots
2 dealer Low CardSlots
wager buttons
Deal
Auto Arrange
Reset
Confirm
New Round
status/result live regions
recovery host
```

Do not create card nodes from client JavaScript.

- [ ] **Step 4: Write Happy-DOM tests for DOM identity and phase behavior**

Create `src/lib/pai-gow-poker/client.init.test.ts` with a DOM fixture matching the real IDs/data attributes. Cover:

```text
initial wager 20 is selected
Deal reveals seven player cards and keeps seven dealer cards face-down
click card 0 -> same button node moves to Low container and aria-pressed=true
click card 1 -> same button moves to Low; five nodes remain High/unassigned
third unselected card click does not create a third Low card
click selected card -> it returns to High/unassigned and aria-pressed=false
Auto Arrange -> exactly two Low cards using house-way indexes
Reset -> all seven cards return to High/unassigned
fouled split -> Confirm does not complete and status shows foul error
successful Confirm -> dealer High/Low cards reveal and result is shown
New Round -> cards return to placeholders and selected wager remains
```

For identity, save the original element before interaction and assert `document.getElementById(...)` returns the same object after it moves.

- [ ] **Step 5: Run the client suite and verify failure**

```bash
bun test src/lib/pai-gow-poker/client.init.test.ts
```

Expected: FAIL because `client.ts` does not exist.

- [ ] **Step 6: Implement the client using existing settlement composition**

At startup:

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

Use one display adapter:

```ts
function toCardData(card: PaiGowCard): { rank: string; suit: string } {
  if (isPaiGowJoker(card)) return { rank: '★', suit: '★' };
  return { rank: rankLabel(card.rank), suit: card.suit };
}
```

Move existing player button nodes with `append(...)` according to `state.lowIndexes`. Do not reconstruct their HTML.

- [ ] **Step 7: Wire Confirm through the existing public-game settlement controller**

```ts
async function confirmRound(): Promise<void> {
  const error = game.getArrangementError();
  if (error) {
    arrangementMessage = error;
    render();
    return;
  }

  const result = game.confirm();
  arrangementMessage = null;
  render();
  await settlement.completeRound(result.netDelta, game.getState().balance);
  render();
}
```

New Round must no-op while `settlement.isBlocked` and the button must be disabled in render.

- [ ] **Step 8: Add the home/lobby card**

In `src/pages/index.astro`, add a normal Pai Gow Poker entry adjacent to the other card/poker games, pointing to `/games/pai-gow-poker`. Reuse the current card markup; do not extract a new lobby component in this ticket.

- [ ] **Step 9: Run unit/client/build validation before E2E**

```bash
bun test src/lib/pai-gow-poker/ src/lib/five-card-poker.test.ts
bun run build
```

Expected: PASS.

- [ ] **Step 10: Write the deterministic guest E2E**

Create `e2e/pai-gow-poker.spec.ts`. Before page scripts execute, pin:

```ts
await page.addInitScript(() => {
  Math.random = () => 0;
});
```

Exercise:

```text
open /games/pai-gow-poker as guest
assert balance 1,000
Deal -> balance 980 and player 3♥..9♥
Auto Arrange -> Low is 3♥ 4♥
Confirm -> dealer Royal high + 2♦ 3♦ low, outcome Push, balance 1,000
assert no request to /api/wallet/settle
New Round -> betting state and wager 20 retained
```

Use stable `data-testid` selectors from the real page rather than CSS layout selectors.

- [ ] **Step 11: Run the guest acceptance test serially**

```bash
bunx playwright test e2e/pai-gow-poker.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 12: Commit the playable guest slice**

```bash
git add src/lib/game-stats/constants.ts src/lib/game-stats src/lib/pai-gow-poker src/pages/games/pai-gow-poker.astro src/pages/index.astro e2e/pai-gow-poker.spec.ts
git commit -m "feat(pai-gow-poker): add playable arrangement flow"
```

---

## Task 6: Cover authenticated settlement, profile statistics, and final scope validation

**Files:**
- Modify: `e2e/pai-gow-poker.spec.ts`
- Modify: `e2e/profile-statistics.spec.ts`
- Modify only if a fixed game-count assertion proves necessary: files returned by `git grep -n "GAME_TYPES.length\|three-card-showdown" -- src e2e`

**Interfaces:**
- Consumes: existing wallet endpoint/controller; no new runtime interface.
- Produces: one authenticated settlement acceptance test and complete canonical game-list coverage.

- [ ] **Step 1: Add one authenticated settlement test without copying recovery coverage**

Use the existing authenticated test setup pattern from Three-Card Showdown or Sic Bo. Intercept `/api/wallet/settle`, capture the JSON command, and return a successful wallet result.

With the same deterministic Push fixture, assert exactly one command:

```ts
expect(commands).toHaveLength(1);
expect(commands[0]).toMatchObject({
  game: 'pai-gow-poker',
  delta: 0,
  stats: {
    rounds: 1,
    wins: 0,
    losses: 0,
    biggestWin: 0,
  },
});
expect(typeof commands[0].settlementId).toBe('string');
```

Do not add a Pai-Gow-specific 503→Retry matrix. `public-game-settlement.test.ts` already owns exact-command retry/reset behavior.

- [ ] **Step 2: Update profile statistics' canonical game list**

Add `pai-gow-poker` / `Pai Gow Poker` wherever `e2e/profile-statistics.spec.ts` pins the complete supported-game set. Keep the test's existing assertion style.

- [ ] **Step 3: Run focused browser coverage**

```bash
bunx playwright test e2e/pai-gow-poker.spec.ts e2e/profile-statistics.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 4: Run the complete unit suites relevant to shared extraction and the new game**

```bash
bun test src/lib/cards.test.ts src/lib/five-card-poker.test.ts src/lib/poker/handEvaluator.test.ts src/lib/poker/PokerGame.test.ts src/lib/pai-gow-poker/
```

Expected: PASS.

- [ ] **Step 5: Run repository validation**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: all PASS.

- [ ] **Step 6: Run the scope guard grep**

```bash
git diff main...HEAD -- src/lib/cards.ts src/lib/five-card-poker.ts src/lib/poker/handEvaluator.ts
git diff --name-only main...HEAD
git grep -n "pai-gow\|Pai Gow" -- src e2e
```

Verify:

```text
src/lib/cards.ts contains only the generic shuffle typing change
src/lib/five-card-poker.ts contains ordinary standard poker comparison only
src/lib/poker/handEvaluator.ts only delegates its former private five-card rank/comparison logic
all Joker, unusual straight ordering, arrangement, house-way, payout, and client behavior is under src/lib/pai-gow-poker/ or the one route/lobby/registry integration
no database migration, endpoint, drag manager, AI layer, strategy registry, side-bet module, or compatibility wrapper exists
```

If a shared module contains Pai Gow options or Joker branches, move those branches back under `src/lib/pai-gow-poker/` before proceeding.

- [ ] **Step 7: Commit the final acceptance coverage**

```bash
git add e2e/pai-gow-poker.spec.ts e2e/profile-statistics.spec.ts
git commit -m "test(pai-gow-poker): cover wallet and profile integration"
```

---

## Final Review Checklist

- [ ] `shuffleDeck<T>` is the only shared card/deck change.
- [ ] The neutral five-card comparator contains only ordinary poker categories and standard wheel ordering.
- [ ] Texas Hold'em public behavior and card model are unchanged.
- [ ] Video Poker, Three-Card Showdown, and Blackjack evaluators/card models are unchanged.
- [ ] Joker rules are confined to `src/lib/pai-gow-poker/`.
- [ ] House way is one deterministic 21-split function with no configuration.
- [ ] Player interaction is click/select node movement only; no drag-and-drop dependency or generic arrangement component exists.
- [ ] Wagers are 20-chip increments, so 5% commission is always an integer chip amount.
- [ ] Dealer copies win and overall win/push/loss semantics match the design.
- [ ] Guest play never calls the wallet endpoint.
- [ ] Authenticated completion creates exactly one net wallet settlement.
- [ ] No schema migration, new API endpoint, persistence queue, automatic retry policy, AI, ranked mode, replay/history, side bet, or compatibility code was added.
- [ ] Focused Playwright acceptance and repository test/lint/format/build commands pass before the implementation PR is marked ready.
