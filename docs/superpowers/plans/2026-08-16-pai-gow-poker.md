# HPA-197 Focused Pai Gow Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused single-player Pai Gow Poker game with seven-card arrangement, a semi-wild Joker, deterministic dealer arrangement, a pure round resolver, 5% commission, immutable game snapshots, and the existing public-game wallet settlement flow.

**Architecture:** Reuse the neutral standard-card deck and make only its Fisher-Yates shuffle type-generic. Extract the already-existing ordinary five-card poker ranking/comparison core from Texas Hold'em into one small structural module; keep Hold'em combination logic local. Keep every Pai Gow-specific rule—Joker substitution, Pai Gow straight ordering, two-card comparison, arrangement validation, 21-split house way, round resolution, payouts, immutable snapshots, state, and DOM interaction—inside `src/lib/pai-gow-poker/`. Compose the existing `createPublicGameSettlementController` without adding persistence, retry, client-controller, test-hook, or rules frameworks.

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
- `resolvePaiGowRound(player, dealer, wager)` owns sub-hand comparison, overall outcome, commission, gross payout, and net delta. `PaiGowPokerGame.confirm()` must delegate to it.
- Main wager only. `MIN_WAGER = 20`, `MAX_WAGER = 500`, `WAGER_OPTIONS = [20, 40, 100, 200, 500]`, and every valid wager is divisible by 20.
- A win charges exactly 5% commission: gross payout `2 * wager - wager / 20`, net delta `wager - wager / 20`; push gross payout `wager`, net `0`; loss gross payout `0`, net `-wager`.
- Initial wager is exactly `20`.
- `getState()` and `confirm()` return deep-cloned snapshots; caller mutation must not change stored cards, indexes, rankings, or result data.
- Guest rounds stay local. Authenticated Confirm produces exactly one net settlement through `createPublicGameSettlementController`.
- Reuse `validateBet`, `CardSlot`, `setSlotState`, `createPublicGameSession`, and `createPublicGameSettlementController` unchanged.
- No side bets, banking, commission-free variant, drag-and-drop system, generic card-arrangement component, generic wildcard engine, configurable house-way platform, generic immutability helper, base game class, AI, ranked mode, history, replay, new API, schema migration, settlement queue, automatic retry, production hand/deck test hook, or compatibility layer.
- Do not migrate Texas Hold'em's `{ value, suit, rank }` card model, Blackjack cards, Video Poker's Jacks-or-Better evaluator, or Three-Card Showdown's three-card evaluator.

---

## Task 1: Make Fisher-Yates type-generic without changing runtime behavior

**Files:**
- Modify: `src/lib/cards.ts`
- Modify: `src/lib/cards.test.ts`

**Interfaces:**
- Consumes: existing `shuffleDeck` Fisher-Yates implementation.
- Produces:

```ts
export function shuffleDeck<T>(
  deck: readonly T[],
  random?: () => number,
): T[];
```

`createDeck()` and `createShuffledDeck()` remain standard-52-card functions returning `Card[]`.

This task is intentionally a type-only enabling refactor. The JavaScript algorithm already works for arbitrary array items, so do not manufacture a fake failing runtime test.

- [ ] **Step 1: Add a pre-refactor runtime regression for structural items and non-mutation**

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

The temporary `as never` makes the runtime regression executable before the TypeScript signature changes. Bun is not being used as a type-check claim here.

- [ ] **Step 2: Run the existing shared-card suite**

```bash
bun test src/lib/cards.test.ts
```

Expected: PASS.

- [ ] **Step 3: Generalize only the signature and remove the temporary cast**

Change:

```ts
export function shuffleDeck(
  deck: readonly Card[],
  random: () => number = Math.random,
): Card[] {
```

to:

```ts
export function shuffleDeck<T>(
  deck: readonly T[],
  random: () => number = Math.random,
): T[] {
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

Expected: PASS, including the existing deterministic standard-deck fixture.

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

export function rankFiveCardHand(
  cards: readonly FiveCardRankable[],
): FiveCardRanking;

export function compareFiveCardRankings(
  left: FiveCardRanking,
  right: FiveCardRanking,
): -1 | 0 | 1;
```

- [ ] **Step 1: Write failing public-comparator tests that pin the wrapper seam**

Create `src/lib/five-card-poker.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { compareFiveCardRankings, rankFiveCardHand } from './five-card-poker';

const c = (rank: number, suit = 'spades') => ({ rank, suit });

test('standard unsuited wheel is below a standard unsuited 6-high straight', () => {
  const wheel = rankFiveCardHand([
    c(14, 'spades'),
    c(2, 'hearts'),
    c(3, 'clubs'),
    c(4, 'diamonds'),
    c(5, 'spades'),
  ]);
  const sixHigh = rankFiveCardHand([
    c(2, 'spades'),
    c(3, 'hearts'),
    c(4, 'clubs'),
    c(5, 'diamonds'),
    c(6, 'spades'),
  ]);

  expect(wheel).toMatchObject({ category: 'straight', tieBreakers: [5] });
  expect(sixHigh).toMatchObject({ category: 'straight', tieBreakers: [6] });
  expect(compareFiveCardRankings(wheel, sixHigh)).toBe(-1);
});

test('Broadway straight flush outranks K-high straight flush without a Royal category', () => {
  const broadway = rankFiveCardHand([
    c(10), c(11), c(12), c(13), c(14),
  ]);
  const kingHigh = rankFiveCardHand([
    c(9), c(10), c(11), c(12), c(13),
  ]);

  expect(broadway).toEqual({
    category: 'straight-flush',
    tieBreakers: [14],
  });
  expect(kingHigh).toEqual({
    category: 'straight-flush',
    tieBreakers: [13],
  });
  expect(compareFiveCardRankings(broadway, kingHigh)).toBe(1);
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
  const left = rankFiveCardHand([
    c(14, 'spades'),
    c(13, 'hearts'),
    c(11, 'clubs'),
    c(8, 'diamonds'),
    c(4, 'spades'),
  ]);
  const right = rankFiveCardHand([
    c(14, 'hearts'),
    c(13, 'diamonds'),
    c(11, 'spades'),
    c(8, 'clubs'),
    c(4, 'hearts'),
  ]);
  expect(compareFiveCardRankings(left, right)).toBe(0);
});
```

The first test uses mixed suits deliberately. Do not accidentally turn the standard wheel test into a straight-flush test.

- [ ] **Step 2: Verify the new suite is red**

```bash
bun test src/lib/five-card-poker.test.ts
```

Expected: FAIL because `src/lib/five-card-poker.ts` does not exist.

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

The shared module uses standard poker only: Broadway is straight-high `14`, wheel is straight-high `5`, and Royal Flush is not a distinct category.

- [ ] **Step 4: Run the shared comparator tests**

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
bun test \
  src/lib/five-card-poker.test.ts \
  src/lib/poker/handEvaluator.test.ts \
  src/lib/poker/PokerGame.test.ts
```

Expected: PASS.

- [ ] **Step 7: Verify unrelated card games are untouched**

```bash
git diff -- src/lib/video-poker src/lib/three-card-showdown src/lib/blackjack
```

Expected: empty.

- [ ] **Step 8: Commit**

```bash
git add \
  src/lib/five-card-poker.ts \
  src/lib/five-card-poker.test.ts \
  src/lib/poker/handEvaluator.ts
git commit -m "refactor(poker): share five-card hand comparison"
```

---

## Task 3: Add Pai Gow-local cards, rankings, arrangement validation, house way, and pure round resolver

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
- Produces: `PaiGowCard`, `PaiGowHandRanking`, `PaiGowArrangement`, `PaiGowRoundResult`, `rankPaiGowFiveCardHand`, `rankPaiGowTwoCardHand`, `comparePaiGowRankings`, `getArrangement`, `getArrangementError`, `resolvePaiGowRound`, `arrangeHouseWay`.

- [ ] **Step 1: Define the local types**

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

- [ ] **Step 2: Write failing 53-card deck tests**

Create `src/lib/pai-gow-poker/cards.test.ts` and pin exactly 52 unique standard cards plus one Joker:

```ts
test('creates 52 standard cards plus exactly one Joker', () => {
  const deck = createPaiGowDeck();
  expect(deck).toHaveLength(53);
  expect(deck.filter(isPaiGowJoker)).toHaveLength(1);

  const standards = deck.filter((card) => !isPaiGowJoker(card));
  expect(new Set(standards.map((card) => `${card.rank}:${card.suit}`)).size).toBe(52);
});
```

Also pin the first fourteen constant-zero cards:

```ts
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
```

- [ ] **Step 3: Implement the local Joker deck**

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

export function createShuffledPaiGowDeck(
  random: () => number = Math.random,
): PaiGowCard[] {
  return shuffleDeck(createPaiGowDeck(), random);
}
```

- [ ] **Step 4: Run the deck tests**

```bash
bun test src/lib/pai-gow-poker/cards.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing local ranking tests**

Create `src/lib/pai-gow-poker/rules.test.ts`. Pin at least:

```text
Four Aces + Joker -> five-aces
natural suited 10-J-Q-K-A -> royal-flush
Joker completes a straight
Joker completes a flush
Joker cannot act as arbitrary rank to create a pair/trips/full house/quads
two-card Joker + Ace -> pair of Aces
two-card Joker + King -> Ace-King high
Pai Gow wheel straight outranks K-high straight
Royal Flush outranks wheel straight flush
wheel straight flush outranks K-high straight flush
dealer-copy comparison returns equality; round resolver treats it as dealer win for that sub-hand
```

For the straight-order assertions, keep the synthetic tie-breakers local:

```ts
expect(rankPaiGowFiveCardHand(wheel)).toMatchObject({
  category: 'straight',
  tieBreakers: [14],
});
expect(rankPaiGowFiveCardHand(kingHigh)).toMatchObject({
  category: 'straight',
  tieBreakers: [13],
});
```

Do not change the neutral comparator to make these pass.

- [ ] **Step 6: Implement local five-card and two-card ranking**

In `rules.ts`:

1. Natural no-Joker hands call `rankFiveCardHand`.
2. Convert the ordinary result into `PaiGowHandRanking`.
3. Split natural suited Broadway into `royal-flush`.
4. Remap natural wheel straight/straight-flush to Pai Gow's local synthetic ordering.
5. For Joker hands, detect Five Aces first.
6. Otherwise enumerate 52 standard substitutions, skip exact duplicate cards already present, allow all Ace substitutions, allow non-Ace substitutions only when they produce straight/flush/straight-flush/Royal, normalize, and keep the best.
7. Two-card Joker always maps to Ace.

Do not introduce wildcard configuration.

- [ ] **Step 7: Add failing arrangement validation tests**

Pin:

```text
not exactly seven cards -> error
not exactly two Low indexes -> error
duplicate Low indexes -> error
out-of-range Low index -> error
High < Low -> foul
High == Low -> foul
valid High > Low -> getArrangement returns five High + two Low with rankings
```

- [ ] **Step 8: Implement `getArrangementError` and `getArrangement`**

Keep index order canonical:

```ts
const sortedLowIndexes = [...lowIndexes].sort((a, b) => a - b) as [number, number];
```

Build Low from those indexes and High from the other five original cards. Require:

```ts
comparePaiGowRankings(highRanking, lowRanking) > 0
```

before returning an arrangement.

- [ ] **Step 9: Write failing 21-split house-way tests**

Cover each decision tier independently:

```text
returns a valid non-fouled arrangement
prefers stronger High even when another split has stronger Low
when High ties, prefers stronger Low
when both rankings tie, chooses lexicographically smaller original Low indexes
```

- [ ] **Step 10: Implement the deterministic house way**

Create `house-way.ts`:

```ts
export function arrangeHouseWay(
  cards: readonly PaiGowCard[],
): PaiGowArrangement {
  let best: PaiGowArrangement | null = null;

  for (let left = 0; left < 6; left += 1) {
    for (let right = left + 1; right < 7; right += 1) {
      const candidate = getArrangement(cards, [left, right]);
      if (!candidate) continue;

      if (!best) {
        best = candidate;
        continue;
      }

      const high = comparePaiGowRankings(candidate.highRanking, best.highRanking);
      if (high > 0) {
        best = candidate;
        continue;
      }
      if (high < 0) continue;

      const low = comparePaiGowRankings(candidate.lowRanking, best.lowRanking);
      if (low > 0) {
        best = candidate;
        continue;
      }
      if (low < 0) continue;

      const [candidateA, candidateB] = candidate.lowIndexes;
      const [bestA, bestB] = best.lowIndexes;
      if (candidateA < bestA || (candidateA === bestA && candidateB < bestB)) {
        best = candidate;
      }
    }
  }

  if (!best) throw new Error('No valid Pai Gow arrangement');
  return best;
}
```

No casino chart or strategy registry.

- [ ] **Step 11: Write failing pure round-resolver tests with constructed arrangements**

Keep the resolver tests independent of shuffle and `PaiGowPokerGame`.

A small test helper may construct arrangements from explicit rankings:

```ts
const ranking = (
  category: PaiGowCategory,
  ...tieBreakers: number[]
): PaiGowHandRanking => ({ category, tieBreakers });

const arrangement = (
  highRanking: PaiGowHandRanking,
  lowRanking: PaiGowHandRanking,
): PaiGowArrangement => ({
  lowIndexes: [0, 1],
  high: [],
  low: [],
  highRanking,
  lowRanking,
});
```

Pin all three economics:

```ts
test('winning both hands pays +19 net on a 20-chip wager', () => {
  const player = arrangement(ranking('pair', 10), ranking('high-card', 14, 13));
  const dealer = arrangement(ranking('pair', 9), ranking('high-card', 14, 12));

  expect(resolvePaiGowRound(player, dealer, 20)).toMatchObject({
    outcome: 'win',
    commission: 1,
    grossPayout: 39,
    netDelta: 19,
  });
});

test('splitting the two comparisons pushes', () => {
  const player = arrangement(ranking('pair', 10), ranking('high-card', 14, 11));
  const dealer = arrangement(ranking('pair', 9), ranking('high-card', 14, 12));

  expect(resolvePaiGowRound(player, dealer, 20)).toMatchObject({
    outcome: 'push',
    commission: 0,
    grossPayout: 20,
    netDelta: 0,
  });
});

test('winning neither hand loses the full wager and dealer copies count against player', () => {
  const player = arrangement(ranking('pair', 9), ranking('high-card', 14, 12));
  const dealer = arrangement(ranking('pair', 9), ranking('high-card', 14, 13));

  expect(resolvePaiGowRound(player, dealer, 20)).toMatchObject({
    outcome: 'loss',
    commission: 0,
    grossPayout: 0,
    netDelta: -20,
  });
});
```

The last case deliberately ties High (`pair 9` vs `pair 9`); that copy belongs to the dealer.

- [ ] **Step 12: Implement `resolvePaiGowRound` in `rules.ts`**

```ts
export function resolvePaiGowRound(
  player: PaiGowArrangement,
  dealer: PaiGowArrangement,
  wager: number,
): PaiGowRoundResult {
  const playerWonHigh =
    comparePaiGowRankings(player.highRanking, dealer.highRanking) > 0;
  const playerWonLow =
    comparePaiGowRankings(player.lowRanking, dealer.lowRanking) > 0;

  let outcome: PaiGowRoundOutcome;
  if (playerWonHigh && playerWonLow) outcome = 'win';
  else if (playerWonHigh || playerWonLow) outcome = 'push';
  else outcome = 'loss';

  const commission = outcome === 'win' ? wager / 20 : 0;
  const grossPayout =
    outcome === 'win'
      ? 2 * wager - commission
      : outcome === 'push'
        ? wager
        : 0;

  return {
    outcome,
    wager,
    commission,
    grossPayout,
    netDelta: grossPayout - wager,
    player,
    dealer,
  };
}
```

This function owns all round outcome and payout math. `game.ts` must not re-derive it.

- [ ] **Step 13: Run the complete pure-rules slice**

```bash
bun test \
  src/lib/pai-gow-poker/cards.test.ts \
  src/lib/pai-gow-poker/rules.test.ts \
  src/lib/pai-gow-poker/house-way.test.ts \
  src/lib/five-card-poker.test.ts
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add src/lib/pai-gow-poker
git commit -m "feat(pai-gow): add rules and house way"
```

---

## Task 4: Add the pure game lifecycle with deep-cloned snapshots

**Files:**
- Create: `src/lib/pai-gow-poker/game.ts`
- Create: `src/lib/pai-gow-poker/game.test.ts`
- Modify: `src/lib/pai-gow-poker/types.ts`
- Create or Modify: `src/lib/pai-gow-poker/index.ts`

**Interfaces:**
- Consumes:
  - `createShuffledPaiGowDeck(random)`
  - `getArrangement(...)`
  - `getArrangementError(...)`
  - `arrangeHouseWay(...)`
  - `resolvePaiGowRound(player, dealer, wager)`
  - `validateBet(...)`
- Produces:

```ts
export const MIN_WAGER = 20;
export const MAX_WAGER = 500;
export const WAGER_OPTIONS = [20, 40, 100, 200, 500] as const;

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

- [ ] **Step 1: Add the state type**

In `types.ts`:

```ts
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
```

- [ ] **Step 2: Write failing constructor and wager-validation tests**

Pin:

```text
initial phase = betting
initial balance normalized with truncation
initial wager = 20
hands/indexes empty; result null
negative/non-finite initial balance rejected
non-integer wager rejected
outside 20..500 rejected through validateBet
not divisible by 20 rejected locally
wager above current balance rejected
valid 20/40/100/200/500 accepted when affordable
wager only changes in betting
```

Local increment message:

```text
Wager must be in 20-chip increments
```

Affordability message:

```text
Wager exceeds available balance
```

- [ ] **Step 3: Implement balance normalization and wager validation**

Keep the same shape as Three-Card Showdown:

```ts
function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new RangeError('Balance must be a non-negative finite number');
  }
  return Math.trunc(balance);
}
```

`getWagerError` order:

```ts
if (!Number.isInteger(wager)) return 'Wager must be a whole number of chips';
const rangeError = validateBet(wager, MIN_WAGER, MAX_WAGER);
if (rangeError) return rangeError;
if (wager % 20 !== 0) return 'Wager must be in 20-chip increments';
if (wager > this.state.balance) return 'Wager exceeds available balance';
return null;
```

- [ ] **Step 4: Write the zero-RNG Deal/arrangement lifecycle tests**

Use only `() => 0` for lifecycle economics.

Pin after `setWager(20); deal()`:

```text
phase = arranging
balance = 980
playerCards = 3♥ 4♥ 5♥ 6♥ 7♥ 8♥ 9♥
dealerCards = 10♥ J♥ Q♥ K♥ A♥ 2♦ 3♦
lowIndexes = []
result = null
```

Also test:

```text
toggleLowCard adds/removes indexes
third Low selection is rejected/no-op according to chosen domain contract
autoArrange -> player Low [0, 1]
resetArrangement -> []
incomplete arrangement cannot Confirm
```

Use the already-pinned constant-zero house-way result; do not add alternative RNG sequences for win/loss payout coverage.

- [ ] **Step 5: Add private deep-clone helpers before exposing state**

Keep them local to `game.ts`:

```ts
function cloneCard(card: PaiGowCard): PaiGowCard {
  return { ...card };
}

function cloneRanking(ranking: PaiGowHandRanking): PaiGowHandRanking {
  return {
    category: ranking.category,
    tieBreakers: [...ranking.tieBreakers],
  };
}

function cloneArrangement(arrangement: PaiGowArrangement): PaiGowArrangement {
  return {
    lowIndexes: [...arrangement.lowIndexes] as [number, number],
    high: arrangement.high.map(cloneCard),
    low: arrangement.low.map(cloneCard),
    highRanking: cloneRanking(arrangement.highRanking),
    lowRanking: cloneRanking(arrangement.lowRanking),
  };
}

function cloneResult(result: PaiGowRoundResult): PaiGowRoundResult {
  return {
    ...result,
    player: cloneArrangement(result.player),
    dealer: cloneArrangement(result.dealer),
  };
}
```

No shared immutable-state utility.

- [ ] **Step 6: Implement `getState()` as a deep snapshot**

```ts
getState(): Readonly<PaiGowPokerState> {
  return {
    phase: this.state.phase,
    balance: this.state.balance,
    wager: this.state.wager,
    playerCards: this.state.playerCards.map(cloneCard),
    dealerCards: this.state.dealerCards.map(cloneCard),
    lowIndexes: [...this.state.lowIndexes],
    result: this.state.result ? cloneResult(this.state.result) : null,
  };
}
```

- [ ] **Step 7: Implement Deal, selection, Auto Arrange, and Reset**

Deal:

```ts
const error = this.getWagerError(this.state.wager);
if (error) throw new Error(error);

const deck = createShuffledPaiGowDeck(this.random);
this.state = {
  ...this.state,
  phase: 'arranging',
  balance: this.state.balance - this.state.wager,
  playerCards: deck.slice(0, 7).map(cloneCard),
  dealerCards: deck.slice(7, 14).map(cloneCard),
  lowIndexes: [],
  result: null,
};
```

`toggleLowCard(index)` only accepts `0..6` during arranging, removes an existing index, adds an unselected index only when fewer than two are selected, and keeps the stored array sorted.

`autoArrange()` uses:

```ts
this.state.lowIndexes = [...arrangeHouseWay(this.state.playerCards).lowIndexes];
```

`resetArrangement()` sets only `lowIndexes: []`.

- [ ] **Step 8: Implement `confirm()` as orchestration only**

```ts
confirm(): PaiGowRoundResult {
  if (this.state.phase !== 'arranging') {
    throw new Error('Confirm is only allowed while arranging');
  }

  const error = this.getArrangementError();
  if (error) throw new Error(error);

  const player = getArrangement(this.state.playerCards, this.state.lowIndexes);
  if (!player) throw new Error('Player arrangement must be valid');

  const dealer = arrangeHouseWay(this.state.dealerCards);
  const resolved = resolvePaiGowRound(player, dealer, this.state.wager);
  const stored = cloneResult(resolved);

  this.state = {
    ...this.state,
    phase: 'complete',
    balance: this.state.balance + stored.grossPayout,
    result: stored,
  };

  return cloneResult(stored);
}
```

Do not compare High/Low or calculate commission/gross/net here.

- [ ] **Step 9: Pin the zero-RNG Confirm Push and balance**

With Auto Arrange on the constant-zero deal:

```ts
const result = game.confirm();

expect(result).toMatchObject({
  outcome: 'push',
  wager: 20,
  commission: 0,
  grossPayout: 20,
  netDelta: 0,
});
expect(game.getState().balance).toBe(1000);
expect(game.getState().phase).toBe('complete');
```

This is the only payout lifecycle fixture required in `game.test.ts`; pure resolver tests own win/loss arithmetic.

- [ ] **Step 10: Add immutable `getState()` mutation probes**

After the zero-RNG deal:

```ts
const snapshot = game.getState();

(snapshot.playerCards as PaiGowCard[])[0] = { rank: 14, suit: 'spades' };
(snapshot.lowIndexes as number[]).push(6);

const next = game.getState();
expect(next.playerCards[0]).toEqual({ rank: 3, suit: 'hearts' });
expect(next.lowIndexes).toEqual([]);
```

Also mutate a nested card object rather than only replacing the array slot:

```ts
const nested = game.getState();
if (nested.playerCards[0].rank !== 'joker') {
  (nested.playerCards[0] as { rank: number }).rank = 14;
}
expect(game.getState().playerCards[0]).toEqual({ rank: 3, suit: 'hearts' });
```

- [ ] **Step 11: Add immutable `confirm()` result mutation probes**

After zero-RNG Deal -> Auto Arrange -> Confirm:

```ts
const result = game.confirm();

(result.player.lowIndexes as number[])[0] = 6;
(result.player.high as PaiGowCard[])[0] = { rank: 14, suit: 'spades' };
(result.player.highRanking.tieBreakers as number[])[0] = 99;

const stored = game.getState().result!;
expect(stored.player.lowIndexes).toEqual([0, 1]);
expect(stored.player.high[0]).toEqual({ rank: 5, suit: 'hearts' });
expect(stored.player.highRanking.tieBreakers[0]).not.toBe(99);
```

Then mutate `stored` itself and assert a second `getState().result` is still unchanged. This pins both returned-result and returned-state isolation.

- [ ] **Step 12: Implement and test New Round and authoritative balance adoption**

`resetRound()` only from `complete`:

```text
phase -> betting
retain wager
retain current balance
clear player/dealer cards
clear lowIndexes
clear result
```

`setBalance()` uses `normalizeBalance()` and updates only balance.

Test affordability after adopting a lower balance.

- [ ] **Step 13: Run the full domain slice**

```bash
bun test \
  src/lib/pai-gow-poker/cards.test.ts \
  src/lib/pai-gow-poker/rules.test.ts \
  src/lib/pai-gow-poker/house-way.test.ts \
  src/lib/pai-gow-poker/game.test.ts
```

Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add src/lib/pai-gow-poker
git commit -m "feat(pai-gow): add game lifecycle"
```

---

## Task 5: Register Pai Gow and add the route/client with deterministic guest acceptance

**Files:**
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.test.ts`
- Create or Modify: `src/lib/pai-gow-poker/index.ts`
- Create: `src/lib/pai-gow-poker/client.ts`
- Create: `src/lib/pai-gow-poker/client.init.test.ts`
- Create: `src/pages/games/pai-gow-poker.astro`
- Modify: `src/pages/index.astro`
- Create: `e2e/pai-gow-poker.spec.ts`

**Interfaces:**
- Consumes: `PaiGowPokerGame`, `WAGER_OPTIONS`, `CardSlot`, `setSlotState`, `createPublicGameSession`, `createPublicGameSettlementController`.
- Produces: playable `/games/pai-gow-poker` route and guest Push acceptance.

- [ ] **Step 1: Register the eleventh game**

Append to `GAME_TYPES`:

```ts
'pai-gow-poker',
```

Add:

```ts
'pai-gow-poker': 'Pai Gow Poker',
```

and:

```ts
'pai-gow-poker': '🃏',
```

to the typed label/icon records.

- [ ] **Step 2: Update the game-stat registration tripwire**

In `src/lib/game-stats/game-stats.test.ts`, add one focused test:

```ts
test('registers Pai Gow Poker as the eleventh valid game type', () => {
  expect(GAME_TYPES).toContain('pai-gow-poker');
  expect(GAME_TYPES.length).toBe(11);
  expect(isValidGameType('pai-gow-poker')).toBe(true);
});
```

Do not add redundant exact label/icon tests solely to pin display copy; the typed records/build already require those keys.

- [ ] **Step 3: Export the focused module API**

`src/lib/pai-gow-poker/index.ts` exports only the route/client consumers:

```text
PaiGowPokerGame
WAGER_OPTIONS
MIN_WAGER / MAX_WAGER
initPaiGowPokerClient
types needed by tests/consumers
```

Do not create a cross-game poker barrel.

- [ ] **Step 4: Build the Astro route from the Three-Card public-game pattern**

`src/pages/games/pai-gow-poker.astro` uses:

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
7 player card buttons with nested CardSlot
5 dealer High CardSlots
2 dealer Low CardSlots
High/unassigned container
Low container
wager buttons
Deal
Auto Arrange
Reset
Confirm
New Round
settlement recovery host
status/result areas
```

Do not add a route page under `src/pages/games/index.astro`; that file remains its redirect to `/#games`.

- [ ] **Step 5: Implement a local display adapter including Joker**

In `client.ts`:

```ts
function cardData(card: PaiGowCard): { rank: string; suit: string } {
  if (card.rank === 'joker') return { rank: '★', suit: '★' };

  const rank =
    card.rank === 11 ? 'J'
      : card.rank === 12 ? 'Q'
        : card.rank === 13 ? 'K'
          : card.rank === 14 ? 'A'
            : String(card.rank);

  return { rank, suit: card.suit };
}
```

`CardSlot` and `card-format.ts` remain unchanged.

- [ ] **Step 6: Compose the existing settlement controller**

Follow Three-Card construction order:

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
  },
});

const game = new PaiGowPokerGame(settlement.startingBalance);
```

Do not add another gate or retry state.

- [ ] **Step 7: Render arrangement by moving the same seven button nodes**

Every player card button carries:

```html
data-card-index="0"
aria-pressed="false"
```

During render:

```ts
const lowSet = new Set(state.lowIndexes);

for (const button of playerCardButtons) {
  const index = Number(button.dataset.cardIndex);
  const host = lowSet.has(index) ? lowContainer : highContainer;
  host.append(button);
  button.setAttribute('aria-pressed', String(lowSet.has(index)));
}
```

The same nodes move between containers. Do not regenerate card HTML or create a generic arrangement component.

- [ ] **Step 8: Wire controls to pure game methods**

Wager click:

```text
parse -> getWagerError -> show local message on error -> setWager on success
```

Deal:

```text
validate current wager -> game.deal() -> render
```

Card click:

```text
game.toggleLowCard(index) -> render
```

Auto Arrange:

```text
game.autoArrange() -> render
```

Reset:

```text
game.resetArrangement() -> render
```

Confirm:

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

New Round is a no-op while `settlement.isBlocked`.

- [ ] **Step 9: Add Happy-DOM client coverage**

`client.init.test.ts` pins:

```text
initial root balance is adopted
zero-RNG Deal produces seven player cards and facedown dealer presentation
clicking a player card moves the same DOM node to Low and sets aria-pressed=true
clicking it again moves the same node back
Auto Arrange moves indexes [0,1] into Low
Reset moves all player nodes back to High/unassigned
Confirm with incomplete/fouled split shows error and does not settle
zero-RNG Auto Arrange + Confirm reveals dealer and displays Push / 0 net
New Round is disabled while settlement is blocked
Joker adapter renders ★ without CardSlot changes
```

For node identity:

```ts
const original = document.querySelector('[data-card-index="0"]');
button.click();
expect(lowContainer.querySelector('[data-card-index="0"]')).toBe(original);
```

- [ ] **Step 10: Add the lobby card in `src/pages/index.astro`**

Use the existing game-card structure and link to:

```text
/games/pai-gow-poker
```

Do not create a second games listing.

- [ ] **Step 11: Add deterministic guest Playwright acceptance**

`e2e/pai-gow-poker.spec.ts` should pin the constant-zero fixture by overriding `Math.random` before page scripts execute.

Flow:

```text
visit /games/pai-gow-poker as guest
wager = 20
Deal
assert balance 980
Auto Arrange
assert Low has 3♥ 4♥
Confirm
assert Push / 0 net
assert dealer revealed as Royal High + 2♦ 3♦ Low
assert balance returns 1000
assert no /api/wallet/settle request
New Round
assert betting state restored
```

This is the guest E2E spine. Do not add win/loss RNG scenarios.

- [ ] **Step 12: Run the route/client/guest slice**

```bash
bun test \
  src/lib/game-stats/game-stats.test.ts \
  src/lib/pai-gow-poker/

bunx playwright test e2e/pai-gow-poker.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 13: Commit**

```bash
git add \
  src/lib/game-stats/constants.ts \
  src/lib/game-stats/game-stats.test.ts \
  src/lib/pai-gow-poker \
  src/pages/games/pai-gow-poker.astro \
  src/pages/index.astro \
  e2e/pai-gow-poker.spec.ts
git commit -m "feat(pai-gow): add playable route"
```

---

## Task 6: Add authenticated settlement/profile acceptance and run final scope gates

**Files:**
- Modify: `e2e/pai-gow-poker.spec.ts`
- Modify: `e2e/profile-statistics.spec.ts`
- Modify only if compile/test discovery requires: focused existing game-stat/profile fixtures

**Interfaces:**
- Consumes: existing `createPublicGameSettlementController` and registered `pai-gow-poker` game key.
- Produces: one authenticated `delta: 0` settlement assertion and profile-list integration.

- [ ] **Step 1: Add one authenticated settlement acceptance case**

Use the same constant-zero Push fixture. Authenticate using the same helper pattern as the other public single-player game E2Es.

Intercept `/api/wallet/settle` and capture request bodies.

Flow:

```text
authenticated balance starts 1000
Deal -> 980 locally
Auto Arrange
Confirm -> Push
one wallet request occurs
server authoritative balance is adopted
```

Assert exactly one command:

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
```

Do not duplicate the shared Retry/Reset matrix. `public-game-settlement.test.ts` already owns exact-command retry behavior.

- [ ] **Step 2: Update profile statistics canonical game list**

Add `pai-gow-poker` to the fixed expected list in `e2e/profile-statistics.spec.ts`.

Keep this as list/registration coverage; no Pai-Gow-specific profile component is needed.

- [ ] **Step 3: Run focused Pai Gow and profile acceptance**

```bash
bunx playwright test \
  e2e/pai-gow-poker.spec.ts \
  e2e/profile-statistics.spec.ts \
  --workers=1
```

Expected: PASS.

- [ ] **Step 4: Run all relevant unit/domain tests**

```bash
bun test \
  src/lib/cards.test.ts \
  src/lib/five-card-poker.test.ts \
  src/lib/poker/handEvaluator.test.ts \
  src/lib/poker/PokerGame.test.ts \
  src/lib/pai-gow-poker/ \
  src/lib/game-stats/game-stats.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run repository validation**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: all commands PASS.

- [ ] **Step 6: Run the no-framework scope gate**

```bash
git diff --name-only main...HEAD
```

Manually verify:

```text
shared runtime edits outside Pai Gow are limited to:
- src/lib/cards.ts (+ test)
- src/lib/five-card-poker.ts (+ test)
- src/lib/poker/handEvaluator.ts
- normal game registration/lobby/profile integration

Pai Gow implementation remains under:
- src/lib/pai-gow-poker/**
- src/pages/games/pai-gow-poker.astro
- e2e/pai-gow-poker.spec.ts
```

Reject the implementation before merge if it adds:

```text
generic arrangement component
generic wildcard engine
house-way strategy registry/config
base game class/client controller
generic immutability helper
new wallet gate/queue/retry policy
test-only setHands/setDeck production API
schema migration/new API
side bets/banking/AI/ranked/history/replay
```

- [ ] **Step 7: Grep for accidental shared-rule leakage**

```bash
git grep -n \
  -e "joker" \
  -e "house way" \
  -e "houseWay" \
  -e "LowHandIndexes" \
  -- src/lib/cards.ts src/lib/five-card-poker.ts src/lib/poker
```

Expected: no Pai-Gow-specific Joker, house-way, or arrangement policy in shared/Hold'em modules.

- [ ] **Step 8: Confirm resolver/snapshot obligations were not collapsed back into `confirm()`**

Inspect `src/lib/pai-gow-poker/game.ts`:

```text
confirm() calls resolvePaiGowRound(...)
confirm() does not contain playerWonHigh/playerWonLow branching
confirm() does not calculate wager/20 or gross payout directly
getState() clones cards/indexes/result
confirm() returns a clone distinct from stored state
```

- [ ] **Step 9: Commit final acceptance updates**

```bash
git add e2e/pai-gow-poker.spec.ts e2e/profile-statistics.spec.ts
git commit -m "test(pai-gow): cover settlement and profile integration"
```

## Final acceptance checklist

- [ ] `shuffleDeck<T>` is the only shared card/deck change; shared `Card` still has no Joker.
- [ ] `five-card-poker.ts` contains ordinary poker only and pins unsuited wheel-low plus Broadway-SF-over-K-high behavior.
- [ ] Texas Hold'em keeps its card model and 7-card combination search.
- [ ] Video Poker and Three-Card Showdown evaluators remain unchanged.
- [ ] Joker behavior, Pai Gow straight ordering, arrangement validation, house way, and round resolver are local to `src/lib/pai-gow-poker/`.
- [ ] `resolvePaiGowRound` unit tests pin wager-20 win `+19`, push `0`, and loss `-20` without RNG.
- [ ] `PaiGowPokerGame.confirm()` delegates round economics to `resolvePaiGowRound`.
- [ ] `getState()` and `confirm()` return deep clones; mutation probes cannot corrupt stored cards, indexes, rankings, or results.
- [ ] High-first 21-split house way is deterministic; Auto Arrange reuses it.
- [ ] Wagers are whole, 20..500, divisible by 20, and affordable.
- [ ] Guest constant-zero Push goes `1000 -> 980 -> 1000` with no wallet request.
- [ ] Authenticated constant-zero Push sends exactly one `pai-gow-poker` settlement with `delta: 0`.
- [ ] Lobby integration is only in `src/pages/index.astro`; `src/pages/games/index.astro` remains a redirect.
- [ ] Profile statistics include the eleventh game.
- [ ] No schema migration, new API, queue, automatic retry, drag system, wildcard/arrangement/house-way framework, test-only hand injection, AI, ranked mode, replay/history, side bet, banking, or compatibility work was added.
