# HPA-197 Focused Pai Gow Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused single-player Pai Gow Poker game with seven-card arrangement, a semi-wild Joker, deterministic Auto Arrange/dealer house way, integer-chip commission, and the existing public-game settlement flow.

**Architecture:** Keep exactly two shared runtime edits: extract the ordinary five-card comparator already private in Texas Hold'em, and make the existing Fisher-Yates shuffle signature type-generic when the Pai Gow 53-card deck consumes it. All Joker behavior, Pai Gow ordering, cross-size comparison, arrangement validation, house way, round economics, game state, snapshot cloning, and UI stay under `src/lib/pai-gow-poker/`.

**Tech Stack:** Astro 5, TypeScript, Bun tests, Happy DOM, Playwright, existing Cloudflare Worker/D1 wallet API.

## Global Constraints

- Route: `/games/pai-gow-poker`.
- Game key: `pai-gow-poker`; label: `Pai Gow Poker`; icon: `☯️`; it becomes `GAME_TYPES` entry 11.
- Shared `Card` stays unchanged; Joker is Pai-Gow-local.
- Joker is Ace by default and may instead complete Straight/Flush/Straight Flush/Royal; Four Aces + Joker = Five Aces.
- Five-card order: Five Aces > Royal Flush > Straight Flush > Four of a Kind > Full House > Flush > Straight > Three of a Kind > Two Pair > Pair > High Card.
- Pai Gow straight order: Broadway highest, wheel second, K-high third. Wheel is highest non-Royal Straight Flush.
- Cross-size comparison: category, common tie-break prefix, then longer tie-break array wins.
- Arrangement is legal when High >= Low. Dealer copies still win in player-vs-dealer sub-hand comparison.
- House way enumerates all 21 Low choices. Preserve the strongest available Straight/Flush/Straight Flush/Royal High; otherwise maximize Low first, then High, then stable Low indexes.
- Main wager only: `MIN_WAGER = 5`, `MAX_WAGER = 100`, `WAGER_OPTIONS = [5, 10, 20, 50, 100]`.
- No wager divisibility rule. Winning commission is `Math.ceil(wager * 0.05)`.
- `resolvePaiGowRound` owns outcome + payout math. `PaiGowPokerGame.confirm()` only orchestrates.
- `getState()` and `confirm()` return deep-cloned snapshots.
- Seven player card buttons stay in one stable DOM row; no render-time reparenting.
- Arrangement UI shows local High/Low category names in the existing status area.
- Guest play stays local. Authenticated Confirm creates exactly one settlement through `createPublicGameSettlementController`.
- No side bets, banking, commission-free variant, drag system, generic arrangement/wildcard/house-way framework, base game class, AI, ranked/history/replay, new API/schema, settlement queue, automatic retry, compatibility layer, or production hand/deck test hook.

---

## Task 1: Characterize and extract ordinary five-card comparison

**Files:**
- Modify: `src/lib/poker/handEvaluator.test.ts`
- Create: `src/lib/five-card-poker.ts`
- Create: `src/lib/five-card-poker.test.ts`
- Modify: `src/lib/poker/handEvaluator.ts`
- Test: `src/lib/poker/PokerGame.test.ts`

**Interfaces:**

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

- [ ] **Step 1: Add the missing Hold'em Royal-vs-lower-Straight-Flush characterization**

In `src/lib/poker/handEvaluator.test.ts`, inside `determineShowdownWinners()` tests, add:

```ts
test('Broadway straight flush beats a lower straight flush', () => {
  const winners = evaluateWinners(
    [
      [
        ['A', 'hearts'],
        ['K', 'hearts'],
      ],
      [
        ['9', 'hearts'],
        ['8', 'hearts'],
      ],
    ],
    [
      ['Q', 'hearts'],
      ['J', 'hearts'],
      ['10', 'hearts'],
      ['2', 'clubs'],
      ['3', 'diamonds'],
    ],
  );

  expect(winners).toHaveLength(1);
  expect(winners[0].name).toBe('Player 1');
});
```

- [ ] **Step 2: Run the existing evaluator suite before extraction**

```bash
bun test src/lib/poker/handEvaluator.test.ts
```

Expected: PASS. This is the characterization baseline that protects deleting the separate `ROYAL_FLUSH` numeric rank.

- [ ] **Step 3: Write the neutral comparator tests**

Create `src/lib/five-card-poker.test.ts`:

```ts
import { expect, test } from 'bun:test';
import { compareFiveCardRankings, rankFiveCardHand } from './five-card-poker';

const c = (rank: number, suit = 'spades') => ({ rank, suit });

test('standard unsuited wheel is below an unsuited 6-high straight', () => {
  const wheel = rankFiveCardHand([
    c(14, 'spades'), c(2, 'hearts'), c(3, 'clubs'), c(4, 'diamonds'), c(5, 'spades'),
  ]);
  const sixHigh = rankFiveCardHand([
    c(2, 'spades'), c(3, 'hearts'), c(4, 'clubs'), c(5, 'diamonds'), c(6, 'spades'),
  ]);

  expect(wheel).toEqual({ category: 'straight', tieBreakers: [5] });
  expect(sixHigh).toEqual({ category: 'straight', tieBreakers: [6] });
  expect(compareFiveCardRankings(wheel, sixHigh)).toBe(-1);
});

test('Broadway straight flush beats K-high without a Royal category', () => {
  const broadway = rankFiveCardHand([c(10), c(11), c(12), c(13), c(14)]);
  const kingHigh = rankFiveCardHand([c(9), c(10), c(11), c(12), c(13)]);

  expect(broadway).toEqual({ category: 'straight-flush', tieBreakers: [14] });
  expect(kingHigh).toEqual({ category: 'straight-flush', tieBreakers: [13] });
  expect(compareFiveCardRankings(broadway, kingHigh)).toBe(1);
});

test('full house compares trips before pair', () => {
  const kings = rankFiveCardHand([c(13), c(13), c(13), c(2), c(2)]);
  const queens = rankFiveCardHand([c(12), c(12), c(12), c(14), c(14)]);
  expect(compareFiveCardRankings(kings, queens)).toBe(1);
});

test('two pair compares kicker last', () => {
  const ace = rankFiveCardHand([c(10), c(10), c(8), c(8), c(14)]);
  const king = rankFiveCardHand([c(10), c(10), c(8), c(8), c(13)]);
  expect(compareFiveCardRankings(ace, king)).toBe(1);
});
```

- [ ] **Step 4: Verify the new module is red**

```bash
bun test src/lib/five-card-poker.test.ts
```

Expected: FAIL because `src/lib/five-card-poker.ts` does not exist.

- [ ] **Step 5: Implement the ordinary comparator as a tested rewrite**

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

Return one ordered `tieBreakers` array:

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

`compareFiveCardRankings` compares category strength, then tie breakers lexicographically.

Keep standard wheel high = 5. Do not add Royal or Pai Gow ordering here.

- [ ] **Step 6: Replace only Hold'em's private ranking/comparison core**

In `src/lib/poker/handEvaluator.ts` import:

```ts
import {
  compareFiveCardRankings,
  rankFiveCardHand,
  type FiveCardRanking,
} from '../five-card-poker';
```

Delete the local `HandRank`, `HandRanking`, `rankFiveCardHand`, and `compareHandRankings` definitions. Keep `findBestHand` and its 5-of-7 combination generation local, returning `FiveCardRanking` and using `compareFiveCardRankings`.

Do not touch Hold'em card types or public winner APIs.

- [ ] **Step 7: Run extraction regression suites**

```bash
bun test src/lib/five-card-poker.test.ts src/lib/poker/handEvaluator.test.ts src/lib/poker/PokerGame.test.ts
```

Expected: PASS.

- [ ] **Step 8: Verify unrelated card evaluators did not move**

```bash
git diff -- src/lib/video-poker src/lib/three-card-showdown src/lib/blackjack
```

Expected: empty.

- [ ] **Step 9: Commit**

```bash
git add src/lib/five-card-poker.ts src/lib/five-card-poker.test.ts src/lib/poker/handEvaluator.ts src/lib/poker/handEvaluator.test.ts
git commit -m "refactor(poker): share five-card comparison"
```

---

## Task 2: Add Pai Gow-local cards, rankings, cross-size comparison, and round resolver

**Files:**
- Modify: `src/lib/cards.ts`
- Test: `src/lib/cards.test.ts`
- Create: `src/lib/pai-gow-poker/types.ts`
- Create: `src/lib/pai-gow-poker/cards.ts`
- Create: `src/lib/pai-gow-poker/cards.test.ts`
- Create: `src/lib/pai-gow-poker/rules.ts`
- Create: `src/lib/pai-gow-poker/rules.test.ts`

**Produces:**

```ts
export type PaiGowCard = Card | PaiGowJoker;
export function createPaiGowDeck(): PaiGowCard[];
export function createShuffledPaiGowDeck(random?: () => number): PaiGowCard[];
export function rankPaiGowFiveCardHand(cards: readonly PaiGowCard[]): PaiGowHandRanking;
export function rankPaiGowTwoCardHand(cards: readonly PaiGowCard[]): PaiGowHandRanking;
export function comparePaiGowRankings(left: PaiGowHandRanking, right: PaiGowHandRanking): -1 | 0 | 1;
export function getArrangement(cards: readonly PaiGowCard[], lowIndexes: readonly number[]): PaiGowArrangement | null;
export function getArrangementError(cards: readonly PaiGowCard[], lowIndexes: readonly number[]): string | null;
export function resolvePaiGowRound(player: PaiGowArrangement, dealer: PaiGowArrangement, wager: number): PaiGowRoundResult;
```

- [ ] **Step 1: Define local Pai Gow types**

Create `src/lib/pai-gow-poker/types.ts` with:

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

- [ ] **Step 2: Make Fisher-Yates type-generic as part of the real 53-card consumer**

In `src/lib/cards.ts` change only:

```ts
export function shuffleDeck<T>(
  deck: readonly T[],
  random: () => number = Math.random,
): T[] {
  const shuffled = [...deck];
  // existing Fisher-Yates body unchanged
}
```

Do not add a standalone generic-shuffle test with casts. Existing standard-card tests remain the runtime regression; the Pai Gow deck test below proves the new type-level consumer.

- [ ] **Step 3: Implement and test the 53-card deck**

In `cards.ts`:

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

export function createShuffledPaiGowDeck(
  random: () => number = Math.random,
): PaiGowCard[] {
  return shuffleDeck(createPaiGowDeck(), random);
}
```

Tests pin:

```text
53 cards total
52 unique standard cards
exactly one Joker
constant-zero first 14 cards = player 3♥..9♥, dealer 10♥..A♥ 2♦ 3♦
```

Run:

```bash
bun test src/lib/cards.test.ts src/lib/pai-gow-poker/cards.test.ts
```

Expected: PASS.

- [ ] **Step 4: Implement Pai Gow category comparison with explicit cross-size behavior**

Use one category-strength table in `rules.ts`.

Comparator:

```ts
export function comparePaiGowRankings(
  left: PaiGowHandRanking,
  right: PaiGowHandRanking,
): -1 | 0 | 1 {
  const categoryDiff = CATEGORY_STRENGTH[left.category] - CATEGORY_STRENGTH[right.category];
  if (categoryDiff !== 0) return categoryDiff > 0 ? 1 : -1;

  const sharedLength = Math.min(left.tieBreakers.length, right.tieBreakers.length);
  for (let i = 0; i < sharedLength; i += 1) {
    const diff = left.tieBreakers[i] - right.tieBreakers[i];
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }

  if (left.tieBreakers.length === right.tieBreakers.length) return 0;
  return left.tieBreakers.length > right.tieBreakers.length ? 1 : -1;
}
```

Pin both mismatched-length cases:

```ts
expect(
  comparePaiGowRankings(
    { category: 'high-card', tieBreakers: [13, 12, 7, 5, 3] },
    { category: 'high-card', tieBreakers: [13, 12] },
  ),
).toBe(1);

expect(
  comparePaiGowRankings(
    { category: 'pair', tieBreakers: [9, 13, 7, 3] },
    { category: 'pair', tieBreakers: [9] },
  ),
).toBe(1);
```

- [ ] **Step 5: Implement non-Joker ranking by wrapping the neutral comparator**

For ordinary five-card hands:

1. call `rankFiveCardHand`;
2. map ordinary categories to Pai Gow categories;
3. remap straight ordering locally:

```text
ordinary straight [14] -> straight [15]       // Broadway
ordinary straight [5]  -> straight [14]       // wheel
ordinary straight [13] -> straight [13]
```

For ordinary straight flush:

```text
[14] -> royal-flush []
[5]  -> straight-flush [14]
[13] -> straight-flush [13]
```

Other categories keep ordinary tie breakers.

Two-card ranking returns Pair `[pairRank]` or High Card ranks descending. Joker in Low maps to Ace 14.

- [ ] **Step 6: Implement bounded Joker substitution**

For five-card hands containing Joker:

```text
Four natural Aces + Joker -> five-aces
otherwise enumerate the 52 standard cards
skip an exact card already present
Ace substitutions always allowed
non-Ace substitutions allowed only when normalized category is straight/flush/straight-flush/royal-flush
choose highest comparePaiGowRankings result
```

Pin:

```text
Four Aces + Joker -> Five Aces
KQJ10 + Joker suited -> Royal Flush
Joker completes wheel Straight
Joker acts as Ace when no special completion is available
Joker may not become arbitrary rank merely to create Pair/Trips/Full House
```

- [ ] **Step 7: Implement arrangement validation with High >= Low**

`getArrangementError` order:

```text
exactly seven dealt cards
exactly two indexes
distinct indexes
indexes in 0..6
build remaining five High cards
if comparePaiGowRankings(highRanking, lowRanking) < 0 -> foul
otherwise valid
```

Exact foul message:

```text
High hand must rank at least as high as Low hand
```

Add legal same-prefix tests using actual cards:

```text
K♥ Q♠ 7♦ 5♣ 3♥ High vs K♦ Q♥ Low -> valid
9 9 K 7 3 High vs 9 9 Low -> valid
```

Also pin a real foul where Low outranks High.

- [ ] **Step 8: Implement the pure round resolver and integer-chip commission**

```ts
export function resolvePaiGowRound(
  player: PaiGowArrangement,
  dealer: PaiGowArrangement,
  wager: number,
): PaiGowRoundResult {
  const wonHigh = comparePaiGowRankings(player.highRanking, dealer.highRanking) > 0;
  const wonLow = comparePaiGowRankings(player.lowRanking, dealer.lowRanking) > 0;

  const outcome: PaiGowRoundOutcome =
    wonHigh && wonLow ? 'win' : wonHigh || wonLow ? 'push' : 'loss';

  const commission = outcome === 'win' ? Math.ceil(wager * 0.05) : 0;
  const grossPayout = outcome === 'win' ? wager * 2 - commission : outcome === 'push' ? wager : 0;

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

Use constructed arrangements to pin wager-20 economics:

```text
win  -> commission 1, gross 39, net +19
push -> commission 0, gross 20, net 0
loss -> commission 0, gross 0, net -20
```

Also pin one non-multiple wager, e.g. wager 25 -> commission `2` on win.

- [ ] **Step 9: Run pure domain tests and commit**

```bash
bun test src/lib/cards.test.ts src/lib/five-card-poker.test.ts src/lib/pai-gow-poker/cards.test.ts src/lib/pai-gow-poker/rules.test.ts
```

Expected: PASS.

```bash
git add src/lib/cards.ts src/lib/pai-gow-poker src/lib/five-card-poker.ts src/lib/five-card-poker.test.ts
git commit -m "feat(pai-gow): add cards and hand rules"
```

---

## Task 3: Add the 21-split house way and immutable game lifecycle

**Files:**
- Create: `src/lib/pai-gow-poker/house-way.ts`
- Create: `src/lib/pai-gow-poker/house-way.test.ts`
- Modify: `src/lib/pai-gow-poker/types.ts`
- Create: `src/lib/pai-gow-poker/game.ts`
- Create: `src/lib/pai-gow-poker/game.test.ts`

**Consumes:** Task 2 rules/deck APIs.

- [ ] **Step 1: Implement deterministic enumeration helpers**

In `house-way.ts`, enumerate exactly the 21 sorted index pairs:

```ts
const lowPairs: Array<readonly [number, number]> = [];
for (let left = 0; left < 6; left += 1) {
  for (let right = left + 1; right < 7; right += 1) {
    lowPairs.push([left, right]);
  }
}
```

Map each through `getArrangement(cards, pair)` and discard null/fouled results.

- [ ] **Step 2: Implement the protected-made-hand + Low-first objective**

Protected categories:

```ts
const PROTECTED_HIGH = new Set<PaiGowCategory>([
  'straight',
  'flush',
  'straight-flush',
  'royal-flush',
]);
```

Find the strongest protected High among all valid arrangements:

```ts
let bestProtected: PaiGowHandRanking | null = null;
for (const arrangement of valid) {
  if (!PROTECTED_HIGH.has(arrangement.highRanking.category)) continue;
  if (!bestProtected || comparePaiGowRankings(arrangement.highRanking, bestProtected) > 0) {
    bestProtected = arrangement.highRanking;
  }
}
```

If `bestProtected` exists, only keep arrangements whose High compares equal to it. Then choose:

```text
strongest Low
then strongest High
then lexicographically smaller lowIndexes
```

If no protected High exists, choose by the same Low -> High -> indexes ordering over all valid arrangements.

Do not add category-specific rules for quads/five aces/two-pair tiers.

- [ ] **Step 3: Pin representative house-way fixtures**

Use distinct suits unless a protected flush/straight is intentional.

Tests:

```text
A A A K K 7 3 -> Low KK, High AAA73
9 9 5 5 K 7 3 -> Low 55, High 99K73
A K Q 9 7 5 3 -> Low KQ, High A9753
3♥ 4♥ 5♥ 6♥ 7♥ 8♥ 9♥ -> Low 3♥4♥, High 5♥..9♥
10♥ J♥ Q♥ K♥ A♥ 2♦ 3♦ -> Low 2♦3♦, High Royal
```

Also pin deterministic lexicographic Low-index selection when both rankings tie.

- [ ] **Step 4: Add game state and wager policy**

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

In `game.ts`:

```ts
export const MIN_WAGER = 5;
export const MAX_WAGER = 100;
export const WAGER_OPTIONS = [5, 10, 20, 50, 100] as const;
```

`getWagerError`:

```ts
if (!Number.isInteger(wager)) return 'Wager must be a whole number of chips';
const rangeError = validateBet(wager, MIN_WAGER, MAX_WAGER);
if (rangeError) return rangeError;
if (wager > this.state.balance) return 'Wager exceeds available balance';
return null;
```

There is no `% 20` validation.

- [ ] **Step 5: Add private deep-clone helpers**

Keep them local to `game.ts`:

```ts
function cloneCard(card: PaiGowCard): PaiGowCard {
  return { ...card };
}

function cloneRanking(ranking: PaiGowHandRanking): PaiGowHandRanking {
  return { category: ranking.category, tieBreakers: [...ranking.tieBreakers] };
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

- [ ] **Step 6: Implement the game lifecycle**

Constructor initial state:

```text
phase = betting
balance = normalized initial balance
wager = 5
playerCards/dealerCards/lowIndexes empty
result = null
```

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

`toggleLowCard(index)`:

- only in arranging;
- reject non-integer/out-of-range indexes;
- selected index toggles off;
- unselected index adds only when fewer than two are selected;
- store sorted indexes.

`autoArrange()` copies `arrangeHouseWay(playerCards).lowIndexes`.

`resetArrangement()` clears only the Low indexes.

- [ ] **Step 7: Implement `getState()` and `confirm()` as clone boundaries**

`getState()` returns cloned card arrays, index array, and cloned result.

`confirm()`:

```ts
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
```

Do not compare sub-hands or calculate commission in `confirm()`.

- [ ] **Step 8: Pin zero-RNG lifecycle and immutable snapshots**

For the economic lifecycle use wager 20 so the existing fixture remains:

```text
1000 -> Deal -> 980
Auto Arrange
Confirm -> Push -> 1000
```

Mutation probes must cover all alias-prone state:

```text
mutate returned playerCards[0]
splice returned lowIndexes
mutate returned result.player.high[0]
mutate returned result.player.highRanking.tieBreakers[0]
mutate the object returned directly by confirm()
next getState() remains unchanged
```

No alternate RNG sequences for win/loss economics; Task 2 resolver tests own those cases.

- [ ] **Step 9: Run house-way/game suites and commit**

```bash
bun test src/lib/pai-gow-poker/house-way.test.ts src/lib/pai-gow-poker/game.test.ts src/lib/pai-gow-poker/rules.test.ts
```

Expected: PASS.

```bash
git add src/lib/pai-gow-poker
git commit -m "feat(pai-gow): add arrangement and game state"
```

---

## Task 4: Register the game and add the stable-selection route/client + guest E2E

**Files:**
- Modify: `src/lib/game-stats/constants.ts`
- Modify: relevant fixed game-type/count tests
- Create: `src/lib/pai-gow-poker/client.ts`
- Create: `src/lib/pai-gow-poker/client.init.test.ts`
- Create: `src/lib/pai-gow-poker/index.ts`
- Create: `src/pages/games/pai-gow-poker.astro`
- Modify: `src/pages/index.astro`
- Create: `e2e/pai-gow-poker.spec.ts`

- [ ] **Step 1: Register the eleventh game**

Append:

```ts
'pai-gow-poker'
```

to `GAME_TYPES` and add:

```ts
'pai-gow-poker': 'Pai Gow Poker'
'pai-gow-poker': '☯️'
```

to label/icon maps.

Pin:

```ts
expect(GAME_TYPES).toContain('pai-gow-poker');
expect(GAME_TYPES.length).toBe(11);
expect(isValidGameType('pai-gow-poker')).toBe(true);
```

Do not edit `src/pages/games/index.astro`; it only redirects to `/#games`.

- [ ] **Step 2: Build the Astro page with a stable seven-card row**

Use `createPublicGameSession(user)` and the same root data contract as Three-Card Showdown.

Pre-render:

```text
7 player card buttons, each containing CardSlot
5 dealer High CardSlots
2 dealer Low CardSlots
wager buttons 5 / 10 / 20 / 50 / 100
Deal
Auto Arrange
Reset
Confirm
New Round
one status/result area
one settlement recovery host
```

Player buttons stay under one fixed container for the entire round.

- [ ] **Step 3: Implement local card/category display adapters**

In `client.ts`:

```ts
function displayCard(card: PaiGowCard): { rank: string; suit: string } {
  if (isPaiGowJoker(card)) return { rank: '★', suit: '★' };
  return { rank: rankLabel(card.rank), suit: card.suit };
}
```

Add local `CATEGORY_LABELS: Record<PaiGowCategory, string>`; do not modify the domain type to carry presentation copy.

- [ ] **Step 4: Render selection without reparenting**

For each of the seven stable buttons:

```ts
const selected = state.lowIndexes.includes(index);
button.setAttribute('aria-pressed', String(selected));
button.dataset.low = String(selected);
button.classList.toggle('pai-gow-low-selected', selected);
```

Render the card into its existing child `CardSlot`. Never call `append`, `appendChild`, or `replaceChildren` on card buttons during render.

Click handler only calls `game.toggleLowCard(index)` and rerenders.

- [ ] **Step 5: Show High/Low feedback while arranging**

When two cards are selected:

```ts
const arrangement = getArrangement(state.playerCards, state.lowIndexes);
const error = game.getArrangementError();
```

If valid:

```text
High: <CATEGORY_LABELS[arrangement.highRanking.category]> · Low: <CATEGORY_LABELS[arrangement.lowRanking.category]>
```

If invalid, show the exact arrangement error. With fewer than two selected, show `Choose two cards for the Low hand.`

This is status copy only; no `label` property is added to rankings.

- [ ] **Step 6: Compose existing settlement unchanged**

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
```

Confirm handler:

```ts
const result = game.confirm();
render();
await settlement.completeRound(result.netDelta, game.getState().balance);
render();
```

New Round is disabled while `settlement.isBlocked`.

- [ ] **Step 7: Add Happy-DOM interaction coverage**

Pin:

```text
card button parentElement is unchanged after first and second selection
focused first card stays connected and no render-time reparent occurs
aria-pressed/data-low reflect selected state
third selection does not create a third Low card
High/Low category names appear for complete valid split
foul copy appears for invalid split
dealer stays face-down before Confirm and reveals after Confirm
New Round is blocked while settlement is pending/failed
```

- [ ] **Step 8: Add deterministic guest E2E**

Pin `Math.random = () => 0`, select wager 20, then:

```text
Deal -> 980
Auto Arrange
status identifies player High/Low
Confirm -> Push -> 1000
New Round
no /api/wallet/settle request
```

Expected arrangements:

```text
player High 5♥..9♥ / Low 3♥4♥
dealer Royal / Low 2♦3♦
```

- [ ] **Step 9: Run route/client acceptance and commit**

```bash
bun test src/lib/pai-gow-poker/client.init.test.ts src/lib/game-stats/
bunx playwright test e2e/pai-gow-poker.spec.ts --workers=1
```

Expected: PASS.

```bash
git add src/lib/game-stats src/lib/pai-gow-poker src/pages/index.astro src/pages/games/pai-gow-poker.astro e2e/pai-gow-poker.spec.ts
git commit -m "feat(pai-gow): add playable route"
```

---

## Task 5: Add authenticated acceptance, profile integration, typecheck delta, and full validation

**Files:**
- Modify: `e2e/pai-gow-poker.spec.ts`
- Modify: `e2e/profile-statistics.spec.ts`
- Modify only if fixed canonical game lists require it: focused game-stat/profile tests

- [ ] **Step 1: Add one authenticated settlement case**

Reuse the constant-zero Push fixture so the expected command is simple.

Intercept `/api/wallet/settle`, complete one authenticated round, and assert exactly one request body with:

```ts
expect(command).toMatchObject({
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

Do not duplicate the shared Retry/Reset/exact-command matrix here.

- [ ] **Step 2: Add Pai Gow to profile statistics canonical coverage**

Update the fixed expected game list to include `pai-gow-poker` as the eleventh game and pin label/icon rendering through the existing typed maps.

- [ ] **Step 3: Run focused acceptance**

```bash
bunx playwright test e2e/pai-gow-poker.spec.ts e2e/profile-statistics.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 4: Capture/compare TypeScript baseline instead of pretending historical debt is clean**

Before implementation, save current-main output:

```bash
git switch main
bunx tsc --noEmit > /tmp/arcturus-tsc-main.txt 2>&1 || true
git switch -
bunx tsc --noEmit > /tmp/arcturus-tsc-hpa197.txt 2>&1 || true
```

Inspect the diff:

```bash
diff -u /tmp/arcturus-tsc-main.txt /tmp/arcturus-tsc-hpa197.txt || true
```

Acceptance: HPA-197 introduces **no new errors in files touched by this ticket**. Do not fix unrelated baseline errors here.

- [ ] **Step 5: Run full repository validation**

```bash
bun run test
bun run lint
bun run format:check
bun run build
bunx playwright test e2e/pai-gow-poker.spec.ts e2e/profile-statistics.spec.ts --workers=1
```

Expected: all commands above exit successfully. Report the TypeScript baseline delta separately from these pass/fail gates.

- [ ] **Step 6: Run final scope checks**

```bash
git diff main...HEAD -- src/lib/cards.ts src/lib/five-card-poker.ts src/lib/poker/handEvaluator.ts src/lib/pai-gow-poker src/pages/games/pai-gow-poker.astro src/pages/index.astro src/lib/game-stats e2e
```

Confirm:

```text
shared cards change = generic shuffle signature only
shared five-card module = ordinary poker only
Hold'em card type unchanged
Video Poker / Three-Card / Blackjack evaluators unchanged
no card-button reparenting logic
no generic arrangement/wildcard/house-way framework
no side bets/banking/AI/ranked/history/replay
no API/schema/migration/queue/retry-policy additions
no setHands/setDeck production hook
```

- [ ] **Step 7: Commit final acceptance updates**

```bash
git add e2e/profile-statistics.spec.ts e2e/pai-gow-poker.spec.ts src/lib/game-stats
git commit -m "test(pai-gow): cover settlement and profile integration"
```

## Final acceptance checklist

- [ ] The player can Deal seven cards, choose exactly two Low cards, see current High/Low category feedback, and Confirm a legal arrangement.
- [ ] High >= Low is accepted; a genuinely lower High is rejected as foul.
- [ ] Cross-size comparator handles shared prefixes without reading past the shorter tie-break array.
- [ ] Joker rules and Pai Gow straight ordering are local and covered.
- [ ] Auto Arrange/dealer house way splits representative Full House and Two Pair hands sensibly, gives KQ Low on the pinned no-pair fixture, and preserves the documented Straight Flush/Royal fixture.
- [ ] Resolver tests pin win `+19`, push `0`, loss `-20` at wager 20 and upward-rounded commission for a non-multiple wager.
- [ ] `getState()` and `confirm()` cannot be used to mutate internal game state.
- [ ] Player card buttons stay in stable DOM positions; selection uses `aria-pressed`/`data-low` and preserves keyboard focus.
- [ ] Guest deterministic Push settles locally with no wallet request.
- [ ] Authenticated deterministic Push sends exactly one `delta: 0` settlement.
- [ ] Pai Gow appears as the eleventh game with distinct icon `☯️`.
- [ ] No new touched-path TypeScript errors are introduced relative to current `main`.
- [ ] No architecture or product non-goal was added accidentally.
