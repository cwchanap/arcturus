# Video Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HPA-195 Jacks or Better Video Poker as a self-contained single-player module that reuses the existing public-session and wallet boundaries.

**Architecture:** Keep card mechanics, hand evaluation, payouts, and round state pure inside `src/lib/video-poker/`. Keep browser composition in one `client.ts`, keep the Astro route to session bootstrap and markup, and use only the existing `bet-validation`, `public-game-session`, `card-format`, and `wallet` public seams outside the module.

**Tech Stack:** Astro 5, TypeScript, Bun test, Happy DOM for browser-unit coverage, Playwright, existing Cloudflare Worker/D1 wallet settlement.

## Global Constraints

- `src/lib/video-poker/` is the module home; do not introduce a parallel `src/modules` tree.
- Wagers are whole chips from 1 through 5.
- Use one 9/6 Jacks or Better paytable; a five-chip Royal Flush pays 4,000 chips total.
- Keep the deck and evaluator local to Video Poker; do not extract or migrate Poker/Blackjack card internals in this ticket.
- Do not add a base game class, plug-in registry, generic paytable engine, generic state machine, repository interface, new API endpoint, or database migration.
- Do not add AI advice, ranked/Daily modes, alternate Video Poker variants, persisted hand history, sound/settings systems, server-authoritative deals, anti-cheat, automatic wallet retries, settlement outboxes, crash recovery, cross-tab coordination, or compatibility code.
- Pure game/evaluator code must not import DOM, fetch, localStorage, wallet, or Astro APIs.
- Authenticated settlement must go through the existing `src/lib/wallet` public API and must reuse the same settlement command/ID when the shared gate retries.
- Guest play must remain local and must not call `/api/wallet/settle`.
- Invalid browser actions must be caught by `client.ts` and surfaced through `#video-poker-status`; an uncaught DOM event handler is not acceptable.
- `GAME_TYPES` is a closed canonical list consumed by profile/statistics code. Task 4 must run those consumer tests before it is complete, even when no fixture edits are required.

---

## Task 1: Add local card primitives and the fixed paytable

**Files:**
- Create: `src/lib/video-poker/types.ts`
- Create: `src/lib/video-poker/cards.ts`
- Create: `src/lib/video-poker/cards.test.ts`
- Create: `src/lib/video-poker/paytable.ts`
- Create: `src/lib/video-poker/paytable.test.ts`

**Interfaces:**
- Produces: `Card`, `HandCategory`, `HandEvaluation`, `VideoPokerRoundResult`, and `VideoPokerState`.
- Produces: `createDeck()`, `shuffleDeck()`, and `createShuffledDeck()`.
- Produces: `WAGER_OPTIONS`, `PAYTABLE_ROWS`, and `calculatePayout()`.

- [ ] **Step 1: Write failing card and paytable tests**

Create `src/lib/video-poker/cards.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createDeck, shuffleDeck } from './cards';
import type { Card } from './types';

const id = (card: Card) => `${card.rank}-${card.suit}`;

describe('video poker cards', () => {
  test('creates exactly 52 unique cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(id)).size).toBe(52);
    expect(new Set(deck.map((card) => card.suit))).toEqual(
      new Set(['hearts', 'diamonds', 'clubs', 'spades']),
    );
  });

  test('shuffles a copy with an injectable random function', () => {
    const deck: Card[] = [
      { rank: 2, suit: 'hearts' },
      { rank: 3, suit: 'hearts' },
      { rank: 4, suit: 'hearts' },
    ];

    const shuffled = shuffleDeck(deck, () => 0);

    expect(shuffled.map(id)).toEqual(['3-hearts', '4-hearts', '2-hearts']);
    expect(deck.map(id)).toEqual(['2-hearts', '3-hearts', '4-hearts']);
  });
});
```

Create `src/lib/video-poker/paytable.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { calculatePayout, WAGER_OPTIONS } from './paytable';

describe('Jacks or Better paytable', () => {
  test('offers only one through five chips', () => {
    expect(WAGER_OPTIONS).toEqual([1, 2, 3, 4, 5]);
  });

  test('uses the frozen 9/6 payouts', () => {
    expect(calculatePayout('straight-flush', 2)).toBe(100);
    expect(calculatePayout('four-of-kind', 2)).toBe(50);
    expect(calculatePayout('full-house', 2)).toBe(18);
    expect(calculatePayout('flush', 2)).toBe(12);
    expect(calculatePayout('straight', 2)).toBe(8);
    expect(calculatePayout('three-of-kind', 2)).toBe(6);
    expect(calculatePayout('two-pair', 2)).toBe(4);
    expect(calculatePayout('jacks-or-better', 2)).toBe(2);
    expect(calculatePayout('nothing', 2)).toBe(0);
  });

  test('applies the five-chip royal exception', () => {
    expect(calculatePayout('royal-flush', 4)).toBe(1000);
    expect(calculatePayout('royal-flush', 5)).toBe(4000);
  });

  test('rejects non-integer and out-of-range wagers', () => {
    expect(() => calculatePayout('flush', 0)).toThrow(RangeError);
    expect(() => calculatePayout('flush', 2.5)).toThrow(RangeError);
    expect(() => calculatePayout('flush', 6)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail before implementation**

```bash
bun test src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
```

Expected: FAIL because `cards.ts`, `paytable.ts`, and `types.ts` do not exist.

- [ ] **Step 3: Add the domain types**

Create `src/lib/video-poker/types.ts`:

```ts
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

export type PayingHandCategory =
  | 'royal-flush'
  | 'straight-flush'
  | 'four-of-kind'
  | 'full-house'
  | 'flush'
  | 'straight'
  | 'three-of-kind'
  | 'two-pair'
  | 'jacks-or-better';

export type HandCategory = PayingHandCategory | 'nothing';

export interface HandEvaluation {
  category: HandCategory;
  label: string;
}

export type RoundPhase = 'ready' | 'holding' | 'complete';

export interface VideoPokerRoundResult {
  evaluation: HandEvaluation;
  wager: number;
  payout: number;
  netDelta: number;
  finalHand: readonly Card[];
}

export interface VideoPokerState {
  phase: RoundPhase;
  balance: number;
  wager: number;
  hand: readonly Card[];
  heldIndexes: readonly number[];
  result: VideoPokerRoundResult | null;
}
```

- [ ] **Step 4: Implement the local deck helpers**

Create `src/lib/video-poker/cards.ts`:

```ts
import type { Card, Rank, Suit } from './types';

const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

export function shuffleDeck(
  deck: readonly Card[],
  random: () => number = Math.random,
): Card[] {
  const shuffled = [...deck];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

export function createShuffledDeck(random: () => number = Math.random): Card[] {
  return shuffleDeck(createDeck(), random);
}
```

- [ ] **Step 5: Implement the fixed local paytable**

Create `src/lib/video-poker/paytable.ts`:

```ts
import type { HandCategory, PayingHandCategory } from './types';

export const MIN_WAGER = 1;
export const MAX_WAGER = 5;
export const WAGER_OPTIONS = [1, 2, 3, 4, 5] as const;

const PAYOUT_PER_CHIP: Readonly<Record<PayingHandCategory, number>> = {
  'royal-flush': 250,
  'straight-flush': 50,
  'four-of-kind': 25,
  'full-house': 9,
  flush: 6,
  straight: 4,
  'three-of-kind': 3,
  'two-pair': 2,
  'jacks-or-better': 1,
};

export const PAYTABLE_ROWS = [
  { category: 'royal-flush', label: 'Royal Flush', payout: '250× / 4,000 at 5 chips' },
  { category: 'straight-flush', label: 'Straight Flush', payout: '50×' },
  { category: 'four-of-kind', label: 'Four of a Kind', payout: '25×' },
  { category: 'full-house', label: 'Full House', payout: '9×' },
  { category: 'flush', label: 'Flush', payout: '6×' },
  { category: 'straight', label: 'Straight', payout: '4×' },
  { category: 'three-of-kind', label: 'Three of a Kind', payout: '3×' },
  { category: 'two-pair', label: 'Two Pair', payout: '2×' },
  { category: 'jacks-or-better', label: 'Jacks or Better', payout: '1×' },
] as const;

export function calculatePayout(category: HandCategory, wager: number): number {
  if (!Number.isInteger(wager) || wager < MIN_WAGER || wager > MAX_WAGER) {
    throw new RangeError('Wager must be a whole number from 1 through 5 chips');
  }
  if (category === 'nothing') return 0;
  if (category === 'royal-flush' && wager === 5) return 4000;
  return PAYOUT_PER_CHIP[category] * wager;
}
```

- [ ] **Step 6: Run the focused tests and commit**

```bash
bun test src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
git add src/lib/video-poker/types.ts src/lib/video-poker/cards.ts src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.ts src/lib/video-poker/paytable.test.ts
git commit -m "feat(video-poker): add cards and paytable"
```

Expected: PASS before commit.

---

## Task 2: Implement the pure five-card evaluator

**Files:**
- Create: `src/lib/video-poker/evaluator.ts`
- Create: `src/lib/video-poker/evaluator.test.ts`

**Interfaces:**
- Consumes: `Card` and `HandEvaluation` from `types.ts`.
- Produces: `evaluateHand(cards: readonly Card[]): HandEvaluation`.

- [ ] **Step 1: Write the failing evaluator matrix, including overlap boundaries**

Create `src/lib/video-poker/evaluator.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { evaluateHand } from './evaluator';
import type { Card, Rank, Suit } from './types';

const card = (rank: Rank, suit: Suit): Card => ({ rank, suit });
const category = (cards: Card[]) => evaluateHand(cards).category;

describe('evaluateHand', () => {
  test('recognizes the nine paying categories and nothing', () => {
    expect(category([
      card(10, 'hearts'), card(11, 'hearts'), card(12, 'hearts'), card(13, 'hearts'), card(14, 'hearts'),
    ])).toBe('royal-flush');
    expect(category([
      card(5, 'spades'), card(6, 'spades'), card(7, 'spades'), card(8, 'spades'), card(9, 'spades'),
    ])).toBe('straight-flush');
    expect(category([
      card(8, 'hearts'), card(8, 'diamonds'), card(8, 'clubs'), card(8, 'spades'), card(2, 'hearts'),
    ])).toBe('four-of-kind');
    expect(category([
      card(7, 'hearts'), card(7, 'diamonds'), card(7, 'clubs'), card(13, 'hearts'), card(13, 'spades'),
    ])).toBe('full-house');
    expect(category([
      card(2, 'clubs'), card(5, 'clubs'), card(8, 'clubs'), card(11, 'clubs'), card(14, 'clubs'),
    ])).toBe('flush');
    expect(category([
      card(5, 'hearts'), card(6, 'diamonds'), card(7, 'clubs'), card(8, 'spades'), card(9, 'hearts'),
    ])).toBe('straight');
    expect(category([
      card(4, 'hearts'), card(4, 'diamonds'), card(4, 'clubs'), card(9, 'spades'), card(13, 'hearts'),
    ])).toBe('three-of-kind');
    expect(category([
      card(3, 'hearts'), card(3, 'diamonds'), card(12, 'clubs'), card(12, 'spades'), card(7, 'hearts'),
    ])).toBe('two-pair');
    expect(category([
      card(11, 'hearts'), card(11, 'diamonds'), card(3, 'clubs'), card(7, 'spades'), card(9, 'hearts'),
    ])).toBe('jacks-or-better');
    expect(category([
      card(10, 'hearts'), card(10, 'diamonds'), card(3, 'clubs'), card(7, 'spades'), card(9, 'hearts'),
    ])).toBe('nothing');
  });

  test('treats ace through five as a straight', () => {
    expect(category([
      card(14, 'hearts'), card(2, 'diamonds'), card(3, 'clubs'), card(4, 'spades'), card(5, 'hearts'),
    ])).toBe('straight');
  });

  test('classifies a suited ace-through-five wheel as a straight flush, not a royal', () => {
    expect(category([
      card(14, 'spades'), card(2, 'spades'), card(3, 'spades'), card(4, 'spades'), card(5, 'spades'),
    ])).toBe('straight-flush');
  });

  test('counts a pair of aces as Jacks or Better', () => {
    expect(category([
      card(14, 'hearts'), card(14, 'clubs'), card(3, 'diamonds'), card(7, 'spades'), card(9, 'hearts'),
    ])).toBe('jacks-or-better');
  });

  test('requires exactly five cards', () => {
    expect(() => evaluateHand([card(14, 'hearts')])).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run the evaluator test and verify it fails**

```bash
bun test src/lib/video-poker/evaluator.test.ts
```

Expected: FAIL because `evaluateHand` does not exist.

- [ ] **Step 3: Implement explicit category precedence**

Create `src/lib/video-poker/evaluator.ts`:

```ts
import type { Card, HandCategory, HandEvaluation } from './types';

const LABELS: Readonly<Record<HandCategory, string>> = {
  'royal-flush': 'Royal Flush',
  'straight-flush': 'Straight Flush',
  'four-of-kind': 'Four of a Kind',
  'full-house': 'Full House',
  flush: 'Flush',
  straight: 'Straight',
  'three-of-kind': 'Three of a Kind',
  'two-pair': 'Two Pair',
  'jacks-or-better': 'Jacks or Better',
  nothing: 'No Win',
};

function result(category: HandCategory): HandEvaluation {
  return { category, label: LABELS[category] };
}

export function evaluateHand(cards: readonly Card[]): HandEvaluation {
  if (cards.length !== 5) {
    throw new RangeError('Video Poker hands must contain exactly five cards');
  }

  const ranks = cards.map((card) => card.rank);
  const uniqueRanks = [...new Set(ranks)].sort((a, b) => a - b);
  const rankCounts = new Map<number, number>();
  for (const rank of ranks) rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);

  const counts = [...rankCounts.values()].sort((a, b) => b - a);
  const pairRanks = [...rankCounts.entries()]
    .filter(([, count]) => count === 2)
    .map(([rank]) => rank);
  const flush = new Set(cards.map((card) => card.suit)).size === 1;
  const wheel = uniqueRanks.join(',') === '2,3,4,5,14';
  const consecutive = uniqueRanks.length === 5 && uniqueRanks[4] - uniqueRanks[0] === 4;
  const straight = wheel || consecutive;
  const royal = uniqueRanks.join(',') === '10,11,12,13,14';

  if (flush && straight && royal) return result('royal-flush');
  if (flush && straight) return result('straight-flush');
  if (counts[0] === 4) return result('four-of-kind');
  if (counts[0] === 3 && counts[1] === 2) return result('full-house');
  if (flush) return result('flush');
  if (straight) return result('straight');
  if (counts[0] === 3) return result('three-of-kind');
  if (pairRanks.length === 2) return result('two-pair');
  if (pairRanks.length === 1 && pairRanks[0] >= 11) return result('jacks-or-better');
  return result('nothing');
}
```

- [ ] **Step 4: Run the evaluator and foundation tests, then commit**

```bash
bun test src/lib/video-poker/evaluator.test.ts src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
git add src/lib/video-poker/evaluator.ts src/lib/video-poker/evaluator.test.ts
git commit -m "feat(video-poker): evaluate Jacks or Better hands"
```

Expected: PASS before commit.

---

## Task 3: Add the pure Video Poker round state

**Files:**
- Create: `src/lib/video-poker/game.ts`
- Create: `src/lib/video-poker/game.test.ts`

**Interfaces:**
- Consumes: `validateBet()` from `src/lib/bet-validation.ts`.
- Consumes: `createShuffledDeck()`, `evaluateHand()`, `calculatePayout()`, `MIN_WAGER`, and `MAX_WAGER`.
- Produces:

```ts
export class VideoPokerGame {
  constructor(initialBalance: number, random?: () => number);
  getState(): Readonly<VideoPokerState>;
  setWager(wager: number): void;
  deal(): void;
  toggleHold(index: number): void;
  draw(): VideoPokerRoundResult;
  resetRound(): void;
  setBalance(balance: number): void;
}
```

- [ ] **Step 1: Write failing state-transition tests**

Create `src/lib/video-poker/game.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { VideoPokerGame } from './game';

const id = (card: { rank: number; suit: string }) => `${card.rank}-${card.suit}`;

describe('VideoPokerGame', () => {
  test('deals five unique cards and deducts the wager', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.setWager(5);
    game.deal();

    const state = game.getState();
    expect(state.phase).toBe('holding');
    expect(state.balance).toBe(95);
    expect(state.hand).toHaveLength(5);
    expect(new Set(state.hand.map(id)).size).toBe(5);
  });

  test('keeps held cards and replaces every unheld card exactly once', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    const dealt = game.getState().hand.map(id);

    game.toggleHold(0);
    game.toggleHold(2);
    const result = game.draw();
    const finalIds = result.finalHand.map(id);

    expect(finalIds[0]).toBe(dealt[0]);
    expect(finalIds[2]).toBe(dealt[2]);
    expect(finalIds[1]).not.toBe(dealt[1]);
    expect(finalIds[3]).not.toBe(dealt[3]);
    expect(finalIds[4]).not.toBe(dealt[4]);
    expect(new Set(finalIds).size).toBe(5);
    expect(game.getState().phase).toBe('complete');
    expect(() => game.draw()).toThrow();
  });

  test('keeps payout and balance math consistent', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.setWager(3);
    game.deal();
    const result = game.draw();

    expect(result.netDelta).toBe(result.payout - 3);
    expect(game.getState().balance).toBe(100 + result.netDelta);
    expect(game.getState().result).toEqual(result);
  });

  test('rejects invalid and over-balance wagers before dealing', () => {
    const game = new VideoPokerGame(3, () => 0);
    expect(() => game.setWager(2.5)).toThrow();
    expect(() => game.setWager(4)).toThrow();
    expect(game.getState().phase).toBe('ready');
  });

  test('rejects invalid hold indexes and phase-invalid actions without mutating the round', () => {
    const game = new VideoPokerGame(100, () => 0);
    expect(() => game.toggleHold(0)).toThrow();
    game.deal();
    const before = game.getState();
    expect(() => game.toggleHold(5)).toThrow();
    expect(game.getState()).toEqual(before);
    expect(() => game.setWager(2)).toThrow();
  });

  test('preserves the result until explicit reset', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    game.draw();
    const completedBalance = game.getState().balance;

    game.resetRound();
    expect(game.getState()).toMatchObject({
      phase: 'ready',
      balance: completedBalance,
      hand: [],
      heldIndexes: [],
      result: null,
    });
  });
});
```

- [ ] **Step 2: Run the game test and verify it fails**

```bash
bun test src/lib/video-poker/game.test.ts
```

Expected: FAIL because `VideoPokerGame` does not exist.

- [ ] **Step 3: Implement the minimum pure round state**

Create `src/lib/video-poker/game.ts`:

```ts
import { validateBet } from '../bet-validation';
import { createShuffledDeck } from './cards';
import { evaluateHand } from './evaluator';
import { calculatePayout, MAX_WAGER, MIN_WAGER } from './paytable';
import type { Card, VideoPokerRoundResult, VideoPokerState } from './types';

function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new RangeError('Balance must be a non-negative finite number');
  }
  return Math.trunc(balance);
}

export class VideoPokerGame {
  private readonly random: () => number;
  private deck: Card[] = [];
  private state: VideoPokerState;

  constructor(initialBalance: number, random: () => number = Math.random) {
    this.random = random;
    this.state = {
      phase: 'ready',
      balance: normalizeBalance(initialBalance),
      wager: MIN_WAGER,
      hand: [],
      heldIndexes: [],
      result: null,
    };
  }

  getState(): Readonly<VideoPokerState> {
    return {
      ...this.state,
      hand: [...this.state.hand],
      heldIndexes: [...this.state.heldIndexes],
      result: this.state.result
        ? { ...this.state.result, finalHand: [...this.state.result.finalHand] }
        : null,
    };
  }

  setWager(wager: number): void {
    if (this.state.phase !== 'ready') throw new Error('Wager can only change before dealing');
    if (!Number.isInteger(wager)) throw new Error('Wager must be a whole number of chips');
    const validationError = validateBet(wager, MIN_WAGER, MAX_WAGER);
    if (validationError) throw new Error(validationError);
    if (wager > this.state.balance) throw new Error('Wager exceeds available balance');
    this.state.wager = wager;
  }

  deal(): void {
    if (this.state.phase !== 'ready') throw new Error('Finish the current hand first');
    if (this.state.wager > this.state.balance) throw new Error('Wager exceeds available balance');

    this.deck = createShuffledDeck(this.random);
    const hand = this.deck.splice(0, 5);
    this.state = {
      ...this.state,
      phase: 'holding',
      balance: this.state.balance - this.state.wager,
      hand,
      heldIndexes: [],
      result: null,
    };
  }

  toggleHold(index: number): void {
    if (this.state.phase !== 'holding') throw new Error('Cards can only be held before drawing');
    if (!Number.isInteger(index) || index < 0 || index >= 5) {
      throw new RangeError('Card index must be from 0 through 4');
    }

    const held = new Set(this.state.heldIndexes);
    if (held.has(index)) held.delete(index);
    else held.add(index);
    this.state.heldIndexes = [...held].sort((a, b) => a - b);
  }

  draw(): VideoPokerRoundResult {
    if (this.state.phase !== 'holding') throw new Error('Draw is only allowed once per hand');

    const held = new Set(this.state.heldIndexes);
    const finalHand = this.state.hand.map((card, index) => {
      if (held.has(index)) return card;
      const replacement = this.deck.shift();
      if (!replacement) throw new Error('Deck is empty');
      return replacement;
    });
    const evaluation = evaluateHand(finalHand);
    const payout = calculatePayout(evaluation.category, this.state.wager);
    const result: VideoPokerRoundResult = {
      evaluation,
      wager: this.state.wager,
      payout,
      netDelta: payout - this.state.wager,
      finalHand: [...finalHand],
    };

    this.state = {
      ...this.state,
      phase: 'complete',
      balance: this.state.balance + payout,
      hand: [...finalHand],
      result,
    };
    return result;
  }

  resetRound(): void {
    if (this.state.phase !== 'complete') throw new Error('Only a completed hand can be reset');
    this.deck = [];
    this.state = {
      ...this.state,
      phase: 'ready',
      hand: [],
      heldIndexes: [],
      result: null,
    };
  }

  setBalance(balance: number): void {
    this.state.balance = normalizeBalance(balance);
  }
}
```

- [ ] **Step 4: Run the pure rule tests and commit**

```bash
bun test src/lib/video-poker/game.test.ts src/lib/video-poker/evaluator.test.ts src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
git add src/lib/video-poker/game.ts src/lib/video-poker/game.test.ts
git commit -m "feat(video-poker): add deal hold draw flow"
```

Expected: PASS before commit.

---

## Task 4: Register Video Poker and wire the browser/wallet boundary

**Files:**
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.test.ts`
- Create: `src/lib/video-poker/client.ts`
- Create: `src/lib/video-poker/client.test.ts`
- Create: `src/lib/video-poker/index.ts`

**Existing closed-enum consumers to validate, not pre-emptively edit:**
- `src/lib/game-stats/player-statistics.test.ts`
- `src/lib/profile-statistics-payload.test.ts`
- `src/lib/profile-statistics-renderer.test.ts`
- `src/lib/profile-statistics-client.test.ts`

These current fixtures derive their canonical game arrays from `GAME_TYPES`, so adding `video-poker` should expand them automatically. Do not change them merely to create churn; Task 4's validation command must prove the assumption.

**Interfaces:**
- Consumes: `isGuestModeValue()`, `loadGuestBankroll()`, `persistGuestBankroll()`, and `shouldSyncAccountChips()` from `public-game-session`.
- Consumes: `getSuitGlyph()` and `isRedSuit()` from `card-format`.
- Consumes: `createSettlementGate()`, `ensureSettlementRecoveryControls()`, `newSettlementId()`, `SettlementGate`, `SettleRoundCommand`, and `SettleRoundResult` from the `wallet` barrel.
- Produces:

```ts
export function buildVideoPokerSettlementCommand(
  settlementId: string,
  result: Pick<VideoPokerRoundResult, 'netDelta'>,
): SettleRoundCommand;

export function canStartVideoPokerRound(args: {
  isGuestMode: boolean;
  gate: Pick<SettlementGate, 'isBlocked'>;
}): boolean;

export function canDealVideoPokerRound(args: {
  isGuestMode: boolean;
  gate: Pick<SettlementGate, 'isBlocked'>;
  balance: number;
  wager: number;
}): boolean;

export function retryVideoPokerSettlement(
  gate: Pick<SettlementGate, 'retry'>,
): Promise<SettleRoundResult | null>;

export function applyVideoPokerSettlementResult(
  game: Pick<VideoPokerGame, 'setBalance'>,
  result: SettleRoundResult,
): number;

export function resetVideoPokerSettlement(
  gate: Pick<SettlementGate, 'reset'>,
  game: Pick<VideoPokerGame, 'getState' | 'setBalance' | 'resetRound'>,
  serverSyncedBalance: number,
): void;

export function initVideoPokerClient(): void;
```

- [ ] **Step 1: Add a failing game-type registration assertion**

In `src/lib/game-stats/game-stats.test.ts`, add:

```ts
test('registers Video Poker as a valid game type', () => {
  expect(isValidGameType('video-poker')).toBe(true);
  expect(GAME_TYPE_LABELS['video-poker']).toBe('Video Poker');
  expect(GAME_TYPE_ICONS['video-poker']).toBe('♠️');
});
```

Ensure `GAME_TYPE_ICONS` is imported.

Run:

```bash
bun test src/lib/game-stats/game-stats.test.ts
```

Expected: FAIL because `video-poker` is not registered.

- [ ] **Step 2: Register the textual game type**

Update `src/lib/game-stats/constants.ts`:

```ts
export const GAME_TYPES = [
  'blackjack',
  'baccarat',
  'craps',
  'poker',
  'slots',
  'roulette',
  'keno',
  'video-poker',
] as const;
```

Add:

```ts
'video-poker': 'Video Poker',
```

to `GAME_TYPE_LABELS`, and:

```ts
'video-poker': '♠️',
```

to `GAME_TYPE_ICONS`.

No schema migration is needed; the stored game type is textual.

- [ ] **Step 3: Run the closed-enum consumer tests immediately**

```bash
bun test src/lib/game-stats src/lib/profile-statistics-payload.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
```

Expected: PASS. If any test fails because it hard-codes the old seven-game canonical list, update that specific fixture to derive from `GAME_TYPES` and rerun this exact command. Do not change dynamic fixtures that already pass.

- [ ] **Step 4: Write failing wallet-boundary tests before `client.ts`**

Create `src/lib/video-poker/client.test.ts` with the focused helper coverage first:

```ts
import { describe, expect, test } from 'bun:test';
import type { SettlementGate } from '../wallet';
import { VideoPokerGame } from './game';
import {
  applyVideoPokerSettlementResult,
  buildVideoPokerSettlementCommand,
  canDealVideoPokerRound,
  canStartVideoPokerRound,
  resetVideoPokerSettlement,
  retryVideoPokerSettlement,
} from './client';

describe('video poker wallet boundary', () => {
  test('maps win, push, and loss deltas to one wallet command', () => {
    expect(buildVideoPokerSettlementCommand('video-poker-win', { netDelta: 8 })).toEqual({
      settlementId: 'video-poker-win',
      game: 'video-poker',
      delta: 8,
      stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 8 },
    });
    expect(buildVideoPokerSettlementCommand('video-poker-push', { netDelta: 0 }).stats).toEqual({
      rounds: 1,
      wins: 0,
      losses: 0,
      biggestWin: 0,
    });
    expect(buildVideoPokerSettlementCommand('video-poker-loss', { netDelta: -5 }).stats).toEqual({
      rounds: 1,
      wins: 0,
      losses: 1,
      biggestWin: 0,
    });
  });

  test('blocks authenticated new rounds while the shared gate is blocked', () => {
    const gate = { isBlocked: true } as SettlementGate;
    expect(canStartVideoPokerRound({ isGuestMode: false, gate })).toBe(false);
    expect(canStartVideoPokerRound({ isGuestMode: true, gate })).toBe(true);
  });

  test('disables Deal when the current wager exceeds the current balance', () => {
    const gate = { isBlocked: false } as SettlementGate;
    expect(
      canDealVideoPokerRound({
        isGuestMode: false,
        gate,
        balance: 3,
        wager: 5,
      }),
    ).toBe(false);
  });

  test('delegates Retry to the existing gate instead of minting a new settlement id', async () => {
    let retryCalls = 0;
    const result = await retryVideoPokerSettlement({
      retry: async () => {
        retryCalls += 1;
        return { balance: 108, duplicate: false };
      },
    });

    expect(retryCalls).toBe(1);
    expect(result).toEqual({ balance: 108, duplicate: false });
  });

  test('adopts the authoritative server balance', () => {
    const game = new VideoPokerGame(100, () => 0);
    const synced = applyVideoPokerSettlementResult(game, { balance: 77, duplicate: false });

    expect(synced).toBe(77);
    expect(game.getState().balance).toBe(77);
  });

  test('Reset clears the gate and restores the last server-confirmed balance', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    game.draw();

    let resetCalls = 0;
    resetVideoPokerSettlement(
      { reset: () => { resetCalls += 1; } },
      game,
      100,
    );

    expect(resetCalls).toBe(1);
    expect(game.getState()).toMatchObject({ phase: 'ready', balance: 100, result: null });
  });
});
```

Run:

```bash
bun test src/lib/video-poker/client.test.ts
```

Expected: FAIL because `client.ts` does not exist.

- [ ] **Step 5: Implement the small reusable client helpers**

Start `src/lib/video-poker/client.ts` with:

```ts
import { getSuitGlyph, isRedSuit } from '../card-format';
import {
  isGuestModeValue,
  loadGuestBankroll,
  persistGuestBankroll,
  shouldSyncAccountChips,
} from '../public-game-session';
import {
  createSettlementGate,
  ensureSettlementRecoveryControls,
  newSettlementId,
  type SettlementGate,
  type SettleRoundCommand,
  type SettleRoundResult,
} from '../wallet';
import { VideoPokerGame } from './game';
import type { Card, VideoPokerRoundResult } from './types';

const GAME_KEY = 'video-poker';

export function buildVideoPokerSettlementCommand(
  settlementId: string,
  result: Pick<VideoPokerRoundResult, 'netDelta'>,
): SettleRoundCommand {
  return {
    settlementId,
    game: 'video-poker',
    delta: result.netDelta,
    stats: {
      rounds: 1,
      wins: result.netDelta > 0 ? 1 : 0,
      losses: result.netDelta < 0 ? 1 : 0,
      biggestWin: Math.max(result.netDelta, 0),
    },
  };
}

export function canStartVideoPokerRound({
  isGuestMode,
  gate,
}: {
  isGuestMode: boolean;
  gate: Pick<SettlementGate, 'isBlocked'>;
}): boolean {
  return isGuestMode || !gate.isBlocked;
}

export function canDealVideoPokerRound({
  isGuestMode,
  gate,
  balance,
  wager,
}: {
  isGuestMode: boolean;
  gate: Pick<SettlementGate, 'isBlocked'>;
  balance: number;
  wager: number;
}): boolean {
  return wager <= balance && canStartVideoPokerRound({ isGuestMode, gate });
}

export function retryVideoPokerSettlement(
  gate: Pick<SettlementGate, 'retry'>,
): Promise<SettleRoundResult | null> {
  return gate.retry();
}

export function applyVideoPokerSettlementResult(
  game: Pick<VideoPokerGame, 'setBalance'>,
  result: SettleRoundResult,
): number {
  game.setBalance(result.balance);
  return result.balance;
}

export function resetVideoPokerSettlement(
  gate: Pick<SettlementGate, 'reset'>,
  game: Pick<VideoPokerGame, 'getState' | 'setBalance' | 'resetRound'>,
  serverSyncedBalance: number,
): void {
  gate.reset();
  game.setBalance(serverSyncedBalance);
  if (game.getState().phase === 'complete') game.resetRound();
}
```

These helpers are client-local test seams only. Do not move them into `wallet` or create a cross-game controller.

- [ ] **Step 6: Add a minimal Happy DOM fixture and verify invalid browser actions surface status text**

Extend `client.test.ts` with one browser-level unit test around `initVideoPokerClient()` rather than adding an authenticated Playwright flow:

```ts
import { Window } from 'happy-dom';
import { afterAll, beforeAll } from 'bun:test';
import { initVideoPokerClient } from './client';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
const happyWindow = new Window();

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: happyWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: happyWindow.document });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: happyWindow.localStorage,
  });
});

afterAll(() => {
  happyWindow.close();
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
  else Reflect.deleteProperty(globalThis, 'document');
  if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
  else Reflect.deleteProperty(globalThis, 'localStorage');
});

function makeClientRoot(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'video-poker-root';
  root.dataset.userId = 'anonymous';
  root.dataset.guestMode = 'true';
  root.dataset.initialBalance = '3';
  root.innerHTML = `
    <div id="chip-balance"></div>
    <div id="video-poker-status"></div>
    <div id="video-poker-result"></div>
    <button id="video-poker-action">Deal</button>
    <button data-wager="1">1</button>
    <button data-wager="5">5</button>
    <button data-card-index="0"></button>
    <button data-card-index="1"></button>
    <button data-card-index="2"></button>
    <button data-card-index="3"></button>
    <button data-card-index="4"></button>
    <div id="video-poker-recovery-host"></div>
  `;
  document.body.appendChild(root);
  return root;
}

test('surfaces an invalid wager in status instead of throwing from the click handler', () => {
  const root = makeClientRoot();
  initVideoPokerClient();

  (root.querySelector('[data-wager="5"]') as HTMLButtonElement).click();

  expect(root.querySelector('#video-poker-status')?.textContent).toContain(
    'Wager exceeds available balance',
  );
  expect((root.querySelector('#video-poker-action') as HTMLButtonElement).textContent).toBe('Deal');
  root.remove();
});
```

- [ ] **Step 7: Implement browser composition with explicit pure-action error handling**

Inside `initVideoPokerClient()`:

1. Return early when `window` or `#video-poker-root` is unavailable.
2. Read `data-user-id`, `data-guest-mode`, and `data-initial-balance`.
3. For guests, initialize from `loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)`; authenticated users use the server initial balance.
4. Create one `VideoPokerGame` and one `createSettlementGate()`.
5. Keep `serverSyncedBalance` initialized to the authenticated starting balance.
6. Keep `let actionError: string | null = null` in the client; successful game actions clear it and caught pure-layer errors replace it.
7. Render only from `game.getState()`; do not recalculate ranking or payouts in the client.
8. Render card text with `rankLabel(card.rank) + getSuitGlyph(card.suit)` and `isRedSuit(card.suit)` only for presentation.
9. In `ready`, render `Deal` and disable it when `!canDealVideoPokerRound(...)`.
10. In `holding`, render `Draw`.
11. In `complete`, render `New Round` and disable it only when authenticated settlement is blocked.
12. Wager and card click handlers wrap `game.setWager()` / `game.toggleHold()` in `try/catch`, assign `actionError`, and rerender.
13. `Deal`, `Draw`, and `resetRound()` calls are also wrapped so invalid pure-layer actions cannot escape the DOM event handler.

Use this exact error helper:

```ts
function showActionError(error: unknown): void {
  actionError = error instanceof Error ? error.message : 'Unable to complete action';
  render();
}
```

Use this primary action structure so wallet errors remain distinct from game-action errors:

```ts
async function onPrimaryAction(): Promise<void> {
  const state = game.getState();

  if (state.phase === 'ready') {
    if (
      !canDealVideoPokerRound({
        isGuestMode,
        gate,
        balance: state.balance,
        wager: state.wager,
      })
    ) {
      return;
    }
    try {
      game.deal();
      actionError = null;
      render();
    } catch (error) {
      showActionError(error);
    }
    return;
  }

  if (state.phase === 'holding') {
    let round: VideoPokerRoundResult;
    try {
      round = game.draw();
      actionError = null;
      render();
    } catch (error) {
      showActionError(error);
      return;
    }

    if (!shouldSyncAccountChips({ isGuestMode })) {
      persistGuestBankroll(GAME_KEY, clientUserId, game.getState().balance);
      render();
      return;
    }

    try {
      const settled = await gate.settle(
        buildVideoPokerSettlementCommand(newSettlementId('video-poker'), round),
      );
      serverSyncedBalance = applyVideoPokerSettlementResult(game, settled);
      hideSettlementRecovery();
      if (settled.newAchievements?.length) {
        window.dispatchEvent(
          new CustomEvent('achievement-earned', {
            detail: { achievements: settled.newAchievements },
          }),
        );
      }
    } catch (error) {
      console.error('[WALLET_SETTLEMENT] Video Poker settlement failed:', error);
      showSettlementRecovery('Settlement failed. Retry or reset before starting another hand.');
    }
    render();
    return;
  }

  if (!canStartVideoPokerRound({ isGuestMode, gate })) return;
  try {
    game.resetRound();
    actionError = null;
    render();
  } catch (error) {
    showActionError(error);
  }
}
```

Wager and hold handlers must use the same caught-action contract:

```ts
for (const button of wagerButtons) {
  button.addEventListener('click', () => {
    if (game.getState().phase !== 'ready') return;
    try {
      game.setWager(Number(button.dataset.wager));
      actionError = null;
      render();
    } catch (error) {
      showActionError(error);
    }
  });
}

for (const button of cardButtons) {
  button.addEventListener('click', () => {
    if (game.getState().phase !== 'holding') return;
    try {
      game.toggleHold(Number(button.dataset.cardIndex));
      actionError = null;
      render();
    } catch (error) {
      showActionError(error);
    }
  });
}
```

`render()` must use `actionError` for `#video-poker-status` when non-null. Otherwise it uses the normal phase status. This is the only error presentation mechanism needed for pure game actions.

- [ ] **Step 8: Wire Retry/Reset through the existing gate helpers**

Create recovery controls with `ensureSettlementRecoveryControls()` and wire them as follows:

```ts
recovery.retry?.addEventListener('click', async () => {
  try {
    const result = await retryVideoPokerSettlement(gate);
    if (result) {
      serverSyncedBalance = applyVideoPokerSettlementResult(game, result);
      hideSettlementRecovery();
    }
  } catch (error) {
    console.error('[WALLET_SETTLEMENT] Video Poker retry failed:', error);
    showSettlementRecovery('Settlement failed again. Retry or reset the hand.');
  }
  render();
});

recovery.reset?.addEventListener('click', () => {
  resetVideoPokerSettlement(gate, game, serverSyncedBalance);
  hideSettlementRecovery();
  actionError = null;
  render();
});
```

The retry handler must not call `newSettlementId()`, `gate.settle()`, or rebuild a command. `gate.retry()` owns reuse of the pending command and settlement ID.

- [ ] **Step 9: Add the module barrel**

Create `src/lib/video-poker/index.ts`:

```ts
export { VideoPokerGame } from './game';
export { evaluateHand } from './evaluator';
export { calculatePayout, PAYTABLE_ROWS, WAGER_OPTIONS } from './paytable';
export { initVideoPokerClient } from './client';
export type {
  Card,
  HandCategory,
  HandEvaluation,
  VideoPokerRoundResult,
  VideoPokerState,
} from './types';
```

- [ ] **Step 10: Run the full Task 4 validation gate and commit**

```bash
bun test src/lib/video-poker src/lib/game-stats src/lib/profile-statistics-payload.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
```

Expected: PASS.

Then commit:

```bash
git add src/lib/game-stats/constants.ts src/lib/game-stats/game-stats.test.ts src/lib/video-poker/client.ts src/lib/video-poker/client.test.ts src/lib/video-poker/index.ts
git commit -m "feat(video-poker): integrate wallet settlement"
```

Do not add unrelated profile/statistics fixture changes if the focused consumer suite already passes.

---

## Task 5: Add the thin route, lobby entry, and one guest acceptance flow

**Files:**
- Create: `src/pages/games/video-poker.astro`
- Modify: `src/pages/index.astro`
- Create: `e2e/video-poker.spec.ts`

**Interfaces:**
- Consumes: `createPublicGameSession()` from `public-game-session`.
- Consumes: `PAYTABLE_ROWS`, `WAGER_OPTIONS`, and `initVideoPokerClient()` from `video-poker`.
- Produces: `/games/video-poker` with stable selectors used by Playwright.

- [ ] **Step 1: Write the failing guest acceptance test**

Create `e2e/video-poker.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.describe('Video Poker', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('guest can deal, hold, draw once, and start a new hand locally', async ({ page }) => {
    const settlementRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/wallet/settle')) settlementRequests.push(request.url());
    });

    await page.addInitScript(() => {
      Math.random = () => 0;
    });

    await page.goto('/games/video-poker', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('#video-poker-root')).toHaveAttribute('data-guest-mode', 'true');
    await expect(page.locator('#chip-balance')).toContainText('1,000');
    await expect(page.locator('#video-poker-action')).toHaveText('Deal');

    await page.locator('[data-wager="2"]').click();
    await page.locator('#video-poker-action').click();
    await expect(page.locator('#video-poker-action')).toHaveText('Draw');

    const firstCard = page.locator('[data-card-index="0"]');
    const thirdCard = page.locator('[data-card-index="2"]');
    const firstText = await firstCard.textContent();
    const thirdText = await thirdCard.textContent();

    await firstCard.click();
    await thirdCard.click();
    await expect(firstCard).toHaveAttribute('aria-pressed', 'true');
    await expect(thirdCard).toHaveAttribute('aria-pressed', 'true');

    await page.locator('#video-poker-action').click();

    await expect(page.locator('#video-poker-action')).toHaveText('New Round');
    await expect(firstCard).toHaveText(firstText ?? '');
    await expect(thirdCard).toHaveText(thirdText ?? '');
    await expect(page.locator('#video-poker-result')).not.toBeEmpty();
    await expect(page.locator('#chip-balance')).toHaveText(/\d[\d,]*/);

    await page.locator('#video-poker-action').click();
    await expect(page.locator('#video-poker-action')).toHaveText('Deal');
    await expect(page.locator('#video-poker-result')).toBeEmpty();

    await page.waitForLoadState('networkidle');
    expect(settlementRequests).toEqual([]);
  });
});
```

Run:

```bash
bunx playwright test e2e/video-poker.spec.ts
```

Expected: FAIL because the route does not exist.

- [ ] **Step 2: Create the thin Astro page**

Create `src/pages/games/video-poker.astro` with:

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import { createPublicGameSession } from '../../lib/public-game-session';
import { PAYTABLE_ROWS, WAGER_OPTIONS } from '../../lib/video-poker';

const gameSession = createPublicGameSession(Astro.locals.user);
---

<CasinoLayout title="Video Poker - Arcturus Casino">
  <div
    id="video-poker-root"
    data-testid="video-poker-root"
    data-user-id={gameSession.clientUserId}
    data-guest-mode={gameSession.guestModeValue}
    data-initial-balance={gameSession.initialBalance}
    class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8"
  >
    <!-- markup below uses only static/session data -->
  </div>
</CasinoLayout>
```

Inside the root, render exactly these browser contracts:

- Heading `Video Poker` and subtitle `Jacks or Better · 9/6 paytable`.
- Balance label from `gameSession.balanceLabel` and value with `id="chip-balance"`.
- Five wager buttons from `WAGER_OPTIONS`, each with `data-wager={wager}` and `aria-pressed`.
- Five card buttons with `data-card-index={index}` and `aria-pressed="false"`.
- `id="video-poker-status"`, `role="status"`, and `aria-live="polite"`.
- Empty `id="video-poker-result"`, also a polite status region.
- One primary button `id="video-poker-action"` with initial text `Deal`.
- Empty `id="video-poker-recovery-host"`.
- Compact paytable rows rendered from `PAYTABLE_ROWS` without page-side payout logic.

End with only:

```astro
<script>
  import { initVideoPokerClient } from '../../lib/video-poker';
  initVideoPokerClient();
</script>
```

Reuse the existing Art Deco CSS/layout conventions; do not create a renderer/settings subsystem.

- [ ] **Step 3: Add Video Poker to the home-page lineup**

In `src/pages/index.astro`, add:

```ts
{
  name: 'Video Poker',
  emblem: 'cards' as const,
  players: 0,
  minBet: 1,
  href: '/games/video-poker',
},
```

Do not mark it `featured`.

- [ ] **Step 4: Run the focused acceptance and module validation**

```bash
bunx playwright test e2e/video-poker.spec.ts
bun test src/lib/video-poker src/lib/game-stats src/lib/profile-statistics-payload.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
bun run lint
bun run format:check
bun run build
```

Expected: all commands PASS.

- [ ] **Step 5: Commit the route and guest flow**

```bash
git add src/pages/games/video-poker.astro src/pages/index.astro e2e/video-poker.spec.ts
git commit -m "feat(video-poker): add playable Jacks or Better route"
```

---

## Final Verification

- [ ] **Run the full unit/integration suite**

```bash
bun run test
```

Expected: PASS.

- [ ] **Run the ordinary Playwright suite**

```bash
bun run test:e2e
```

Expected: PASS apart from repository-configured expected skips.

- [ ] **Run repository quality gates**

```bash
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Check the architecture boundary**

```bash
grep -R "from '../poker\|from '../blackjack" src/lib/video-poker || true
grep -R "/api/wallet/settle\|fetch(" src/lib/video-poker/game.ts src/lib/video-poker/evaluator.ts src/lib/video-poker/cards.ts src/lib/video-poker/paytable.ts || true
```

Expected: no output. `client.ts` may use wallet behavior only through imports from `../wallet`.

## Implementation Completion Criteria

The implementation is ready for review when:

- `/games/video-poker` supports Deal → hold any subset → Draw once → New Round.
- All final hands contain five unique cards and held cards survive the draw.
- The evaluator covers every Jacks or Better category plus non-paying hands, a wheel straight, a suited wheel straight flush, low-pair rejection, and the ace-pair qualifying boundary.
- Wagers outside whole-chip values 1–5 or above the available balance are rejected before dealing.
- Invalid UI actions surface a status message rather than escaping their DOM event handler.
- Deal is disabled whenever the current wager exceeds the current balance or authenticated settlement blocks play.
- Guest play persists only local bankroll state and sends no wallet request.
- Authenticated completion submits one `SettleRoundCommand`, adopts the returned authoritative balance, blocks New Round while unresolved, retries the exact pending command/ID, and restores the last confirmed server balance on Reset.
- The closed `GAME_TYPES` consumer suite passes after `video-poker` registration without unnecessary fixture churn.
- The Astro route contains no ranking, payout, or wallet-request implementation.
- No shared-card extraction, compatibility layer, new backend subsystem, generic game framework, or unrelated refactor is present.
