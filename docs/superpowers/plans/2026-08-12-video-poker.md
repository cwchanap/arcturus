# Video Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HPA-195 Jacks or Better Video Poker as a self-contained single-player module that reuses the existing public-session and wallet boundaries.

**Architecture:** Keep card mechanics, hand evaluation, payouts, and round state pure inside `src/lib/video-poker/`. Keep browser composition in one `client.ts`, keep the Astro route to session bootstrap and markup, and use only the existing `bet-validation`, `public-game-session`, `card-format`, and `wallet` public seams outside the module.

**Tech Stack:** Astro 5, TypeScript, Bun test, Playwright, existing Cloudflare Worker/D1 wallet settlement.

## Global Constraints

- `src/lib/video-poker/` is the module home; do not introduce a parallel `src/modules` tree.
- Wagers are whole chips from 1 through 5.
- Use one 9/6 Jacks or Better paytable; a five-chip Royal Flush pays 4,000 chips total.
- Keep the deck and evaluator local to Video Poker; do not extract or migrate Poker/Blackjack card internals in this ticket.
- Do not add a base game class, plug-in registry, generic paytable engine, generic state machine, repository interface, new API endpoint, or database migration.
- Do not add AI advice, ranked/Daily modes, alternate Video Poker variants, persisted hand history, sound/settings systems, server-authoritative deals, anti-cheat, automatic wallet retries, settlement outboxes, crash recovery, cross-tab coordination, or compatibility code.
- Pure game/evaluator code must not import DOM, fetch, localStorage, wallet, or Astro APIs.
- Authenticated settlement must go through the existing `src/lib/wallet` public API and must reuse the same settlement ID when the shared gate retries a failed command.
- Guest play must remain local and must not call `/api/wallet/settle`.

---

## Task 1: Add local card primitives and the fixed paytable

**Files:**
- Create: `src/lib/video-poker/types.ts`
- Create: `src/lib/video-poker/cards.ts`
- Create: `src/lib/video-poker/cards.test.ts`
- Create: `src/lib/video-poker/paytable.ts`
- Create: `src/lib/video-poker/paytable.test.ts`

**Interfaces:**
- Produces: `Card`, `HandCategory`, `HandEvaluation`, `VideoPokerRoundResult`, `VideoPokerState` for later tasks.
- Produces: `createDeck()`, `shuffleDeck()`, and `createShuffledDeck()` for `game.ts`.
- Produces: `WAGER_OPTIONS`, `PAYTABLE_ROWS`, and `calculatePayout()` for `game.ts` and the Astro page.

- [ ] **Step 1: Write the failing card and paytable tests**

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

  test('uses the 9/6 per-chip payouts', () => {
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

  test('applies the five-chip royal flush exception', () => {
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

- [ ] **Step 2: Run the new tests and verify they fail because the module does not exist yet**

Run:

```bash
bun test src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
```

Expected: FAIL because `./cards`, `./paytable`, and `./types` have not been implemented.

- [ ] **Step 3: Add the Video Poker domain types**

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

- [ ] **Step 5: Implement the fixed paytable**

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

Run:

```bash
bun test src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/lib/video-poker/types.ts src/lib/video-poker/cards.ts src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.ts src/lib/video-poker/paytable.test.ts
git commit -m "feat(video-poker): add cards and paytable"
```

---

## Task 2: Implement the pure five-card evaluator

**Files:**
- Create: `src/lib/video-poker/evaluator.ts`
- Create: `src/lib/video-poker/evaluator.test.ts`

**Interfaces:**
- Consumes: `Card` and `HandEvaluation` from `types.ts`.
- Produces: `evaluateHand(cards: readonly Card[]): HandEvaluation` for `game.ts`.

- [ ] **Step 1: Write the failing evaluator matrix**

Create `src/lib/video-poker/evaluator.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { evaluateHand } from './evaluator';
import type { Card, Rank, Suit } from './types';

const card = (rank: Rank, suit: Suit): Card => ({ rank, suit });
const category = (cards: Card[]) => evaluateHand(cards).category;

describe('evaluateHand', () => {
  test('recognizes all paying categories and nothing', () => {
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

  test('requires exactly five cards', () => {
    expect(() => evaluateHand([card(14, 'hearts')])).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Run the evaluator test and verify it fails**

Run:

```bash
bun test src/lib/video-poker/evaluator.test.ts
```

Expected: FAIL because `evaluateHand` does not exist yet.

- [ ] **Step 3: Implement category precedence explicitly**

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
  const consecutive =
    uniqueRanks.length === 5 && uniqueRanks[4] - uniqueRanks[0] === 4;
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

- [ ] **Step 4: Run the evaluator plus foundation tests and commit**

Run:

```bash
bun test src/lib/video-poker/evaluator.test.ts src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/lib/video-poker/evaluator.ts src/lib/video-poker/evaluator.test.ts
git commit -m "feat(video-poker): evaluate Jacks or Better hands"
```

---

## Task 3: Add the pure Video Poker round state

**Files:**
- Create: `src/lib/video-poker/game.ts`
- Create: `src/lib/video-poker/game.test.ts`

**Interfaces:**
- Consumes: `validateBet()` from `src/lib/bet-validation.ts`.
- Consumes: `createShuffledDeck()`, `evaluateHand()`, `calculatePayout()`, `MIN_WAGER`, and `MAX_WAGER` from Tasks 1–2.
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

  test('keeps balance math consistent with the frozen result', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.setWager(3);
    game.deal();
    const result = game.draw();

    expect(result.netDelta).toBe(result.payout - 3);
    expect(game.getState().balance).toBe(100 + result.netDelta);
    expect(game.getState().result).toEqual(result);
  });

  test('rejects invalid or over-balance wagers before dealing', () => {
    const game = new VideoPokerGame(3, () => 0);
    expect(() => game.setWager(2.5)).toThrow();
    expect(() => game.setWager(4)).toThrow();
    expect(game.getState().phase).toBe('ready');
  });

  test('allows wager changes only while ready', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    expect(() => game.setWager(2)).toThrow();
  });

  test('preserves the result until an explicit reset', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    game.draw();
    const completedBalance = game.getState().balance;

    expect(game.getState().result).not.toBeNull();
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

Run:

```bash
bun test src/lib/video-poker/game.test.ts
```

Expected: FAIL because `VideoPokerGame` has not been implemented.

- [ ] **Step 3: Implement the minimum pure round state**

Create `src/lib/video-poker/game.ts` with this state model:

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

- [ ] **Step 4: Run the game and pure rule tests**

Run:

```bash
bun test src/lib/video-poker/game.test.ts src/lib/video-poker/evaluator.test.ts src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the pure game state**

```bash
git add src/lib/video-poker/game.ts src/lib/video-poker/game.test.ts
git commit -m "feat(video-poker): add deal hold draw flow"
```

---

## Task 4: Register Video Poker and wire guest/authenticated settlement

**Files:**
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.test.ts`
- Create: `src/lib/video-poker/client.ts`
- Create: `src/lib/video-poker/client.test.ts`
- Create: `src/lib/video-poker/index.ts`

**Interfaces:**
- Consumes: `isGuestModeValue()`, `loadGuestBankroll()`, `persistGuestBankroll()`, and `shouldSyncAccountChips()` from `src/lib/public-game-session.ts`.
- Consumes: `getSuitGlyph()` and `isRedSuit()` from `src/lib/card-format.ts`.
- Consumes: `createSettlementGate()`, `ensureSettlementRecoveryControls()`, `newSettlementId()`, `SettleRoundCommand`, and `SettleRoundResult` from `src/lib/wallet/index.ts`.
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

export function initVideoPokerClient(): void;
```

- [ ] **Step 1: Add a failing game-type registration assertion**

In `src/lib/game-stats/game-stats.test.ts`, add a focused test beside the existing constant/type-guard tests:

```ts
test('registers Video Poker as a valid game type', () => {
  expect(isValidGameType('video-poker')).toBe(true);
  expect(GAME_TYPE_LABELS['video-poker']).toBe('Video Poker');
  expect(GAME_TYPE_ICONS['video-poker']).toBe('♠️');
});
```

Ensure `GAME_TYPE_ICONS` is imported in that test file if it is not already imported.

Run:

```bash
bun test src/lib/game-stats/game-stats.test.ts
```

Expected: FAIL because `video-poker` is not registered.

- [ ] **Step 2: Register the new textual game type**

Update `src/lib/game-stats/constants.ts` so the three mirrored structures contain:

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

Run:

```bash
bun test src/lib/game-stats/game-stats.test.ts
```

Expected: PASS.

- [ ] **Step 3: Write failing settlement-helper tests**

Create `src/lib/video-poker/client.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildVideoPokerSettlementCommand, canStartVideoPokerRound } from './client';

describe('video poker wallet boundary', () => {
  test('maps a winning hand to one wallet command', () => {
    expect(buildVideoPokerSettlementCommand('video-poker-test', { netDelta: 8 })).toEqual({
      settlementId: 'video-poker-test',
      game: 'video-poker',
      delta: 8,
      stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 8 },
    });
  });

  test('treats break-even as neither a win nor a loss', () => {
    expect(buildVideoPokerSettlementCommand('video-poker-push', { netDelta: 0 }).stats).toEqual({
      rounds: 1,
      wins: 0,
      losses: 0,
      biggestWin: 0,
    });
  });

  test('maps a losing hand to a loss with no biggest win', () => {
    expect(buildVideoPokerSettlementCommand('video-poker-loss', { netDelta: -5 }).stats).toEqual({
      rounds: 1,
      wins: 0,
      losses: 1,
      biggestWin: 0,
    });
  });

  test('guest play ignores wallet blocking while authenticated play does not', () => {
    expect(canStartVideoPokerRound({ isGuestMode: true, gate: { isBlocked: true } })).toBe(true);
    expect(canStartVideoPokerRound({ isGuestMode: false, gate: { isBlocked: true } })).toBe(false);
    expect(canStartVideoPokerRound({ isGuestMode: false, gate: { isBlocked: false } })).toBe(true);
  });
});
```

Run:

```bash
bun test src/lib/video-poker/client.test.ts
```

Expected: FAIL because `client.ts` has not been created.

- [ ] **Step 4: Implement the small settlement helpers**

Start `src/lib/video-poker/client.ts` with the shared imports and these exported helpers:

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
```

- [ ] **Step 5: Implement browser composition without moving rules into the client**

In the same `client.ts`, use these selectors exactly:

```ts
const root = document.getElementById('video-poker-root');
const balanceEl = document.getElementById('chip-balance');
const statusEl = document.getElementById('video-poker-status');
const resultEl = document.getElementById('video-poker-result');
const action = document.getElementById('video-poker-action') as HTMLButtonElement | null;
const recoveryHost = document.getElementById('video-poker-recovery-host');
const cardButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-card-index]')];
const wagerButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-wager]')];
```

Use this rank formatter only for display:

```ts
function rankLabel(rank: Card['rank']): string {
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  if (rank === 14) return 'A';
  return String(rank);
}
```

Inside `initVideoPokerClient()`:

1. Return early when `window` or `#video-poker-root` is unavailable.
2. Read `data-user-id`, `data-guest-mode`, and `data-initial-balance` from the root.
3. For guests, initialize the game balance with `loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)`; for authenticated users, use `initialBalance`.
4. Create exactly one `VideoPokerGame` and one `createSettlementGate()`.
5. Keep one local `serverSyncedBalance` initialized to the starting authenticated balance.
6. Render state by reading `game.getState()`; never recalculate hand categories or payouts in the renderer.
7. Render cards with `rankLabel(card.rank) + getSuitGlyph(card.suit)` and use `isRedSuit(card.suit)` only to choose the existing red/ivory text classes.
8. Render `Deal`, `Draw`, or `New Round` from `state.phase`.
9. Disable `New Round` for authenticated play while `gate.isBlocked` is true.
10. Wager buttons call only `game.setWager(Number(button.dataset.wager))` while the phase is `ready`.
11. Card buttons call only `game.toggleHold(Number(button.dataset.cardIndex))` while the phase is `holding`.

Use the primary action flow below:

```ts
async function onPrimaryAction(): Promise<void> {
  const state = game.getState();

  if (state.phase === 'ready') {
    if (!canStartVideoPokerRound({ isGuestMode, gate })) return;
    game.deal();
    render();
    return;
  }

  if (state.phase === 'holding') {
    const round = game.draw();
    render();

    if (!shouldSyncAccountChips({ isGuestMode })) {
      persistGuestBankroll(GAME_KEY, clientUserId, game.getState().balance);
      render();
      return;
    }

    try {
      const settled = await gate.settle(
        buildVideoPokerSettlementCommand(newSettlementId('video-poker'), round),
      );
      adoptSettlementResult(settled);
    } catch (error) {
      console.error('[WALLET_SETTLEMENT] Video Poker settlement failed:', error);
      showSettlementRecovery('Settlement failed. Retry or reset before starting another hand.');
    }
    render();
    return;
  }

  if (canStartVideoPokerRound({ isGuestMode, gate })) {
    game.resetRound();
    render();
  }
}
```

Adopt authoritative results in one helper:

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

Create recovery controls through the shared helper rather than adding retry state:

```ts
const recovery = ensureSettlementRecoveryControls({
  attachTo: recoveryHost,
  containerId: 'video-poker-settlement-recovery',
  retryId: 'video-poker-retry-settlement',
  resetId: 'video-poker-reset-settlement',
  containerClass: 'hidden mt-4 flex gap-3 justify-center',
  retryLabel: 'Retry settlement',
  resetLabel: 'Reset hand',
  retryClass: 'deco-btn px-4 py-2 rounded-lg',
  resetClass: 'deco-btn px-4 py-2 rounded-lg',
});
```

Wire Retry and Reset directly to the shared gate:

```ts
recovery.retry?.addEventListener('click', async () => {
  try {
    const result = await gate.retry();
    if (result) adoptSettlementResult(result);
  } catch (error) {
    console.error('[WALLET_SETTLEMENT] Video Poker retry failed:', error);
    showSettlementRecovery('Settlement failed again. Retry or reset the hand.');
  }
  render();
});

recovery.reset?.addEventListener('click', () => {
  gate.reset();
  game.setBalance(serverSyncedBalance);
  if (game.getState().phase === 'complete') game.resetRound();
  hideSettlementRecovery();
  render();
});
```

Keep `showSettlementRecovery()`, `hideSettlementRecovery()`, and `render()` as small DOM-only functions in `client.ts`. Do not introduce a renderer class for this one screen.

- [ ] **Step 6: Add the module barrel**

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

- [ ] **Step 7: Run the client, game-type, and pure module tests**

Run:

```bash
bun test src/lib/video-poker src/lib/game-stats/game-stats.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit the integration boundary**

```bash
git add src/lib/game-stats/constants.ts src/lib/game-stats/game-stats.test.ts src/lib/video-poker/client.ts src/lib/video-poker/client.test.ts src/lib/video-poker/index.ts
git commit -m "feat(video-poker): integrate wallet settlement"
```

---

## Task 5: Add the thin route, lobby entry, and one acceptance flow

**Files:**
- Create: `src/pages/games/video-poker.astro`
- Modify: `src/pages/index.astro`
- Create: `e2e/video-poker.spec.ts`

**Interfaces:**
- Consumes: `createPublicGameSession()` from `src/lib/public-game-session.ts`.
- Consumes: `PAYTABLE_ROWS` and `WAGER_OPTIONS` from `src/lib/video-poker/index.ts`.
- Consumes: `initVideoPokerClient()` from `src/lib/video-poker/index.ts`.
- Produces: `/games/video-poker` with stable selectors used by the Playwright acceptance test.

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

Expected: FAIL because `/games/video-poker` does not exist yet.

- [ ] **Step 2: Create the thin Astro page**

Create `src/pages/games/video-poker.astro` with this frontmatter:

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import { createPublicGameSession } from '../../lib/public-game-session';
import { PAYTABLE_ROWS, WAGER_OPTIONS } from '../../lib/video-poker';

const gameSession = createPublicGameSession(Astro.locals.user);
---
```

Use these exact root/session attributes:

```astro
<CasinoLayout title="Video Poker - Arcturus Casino">
  <div
    id="video-poker-root"
    data-testid="video-poker-root"
    data-user-id={gameSession.clientUserId}
    data-guest-mode={gameSession.guestModeValue}
    data-initial-balance={gameSession.initialBalance}
    class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8"
  >
```

Render:

- Heading `Video Poker` and subtitle `Jacks or Better · 9/6 paytable`.
- Balance label from `gameSession.balanceLabel` and balance value with `id="chip-balance"`.
- Five wager buttons generated from `WAGER_OPTIONS`, each with `data-wager={wager}` and `aria-pressed`.
- Five card buttons generated from `Array.from({ length: 5 })`, each with `id={`video-poker-card-${index}`}`, `data-card-index={index}`, `aria-pressed="false"`, and initial text `Card {index + 1}`.
- Status element `id="video-poker-status"` with `role="status"` and `aria-live="polite"`.
- Empty result element `id="video-poker-result"` with `role="status"` and `aria-live="polite"`.
- One primary button `id="video-poker-action"` whose initial text is `Deal`.
- Empty `id="video-poker-recovery-host"` for the shared wallet recovery controls.
- A compact paytable generated directly from `PAYTABLE_ROWS`; the page displays data but does not calculate payouts.

End the page with only this behavior bootstrap:

```astro
<script>
  import { initVideoPokerClient } from '../../lib/video-poker';
  initVideoPokerClient();
</script>
```

Keep styling local to the page and reuse the existing `CasinoLayout`, `felt-table`, `deco-*`, and CSS variable conventions. Do not add a new component library or renderer class.

- [ ] **Step 3: Add Video Poker to the home-page lineup**

In the `games` array in `src/pages/index.astro`, add one non-featured entry:

```ts
{
  name: 'Video Poker',
  emblem: 'cards' as const,
  players: 0,
  minBet: 1,
  href: '/games/video-poker',
},
```

Do not mark it `featured` in this ticket.

- [ ] **Step 4: Run the focused acceptance flow**

Run:

```bash
bunx playwright test e2e/video-poker.spec.ts
```

Expected: PASS.

- [ ] **Step 5: Run focused module and build validation**

Run:

```bash
bun test src/lib/video-poker src/lib/game-stats
bun run lint
bun run format:check
bun run build
```

Expected: all commands PASS.

- [ ] **Step 6: Commit the route and acceptance coverage**

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

- [ ] **Run the full ordinary Playwright suite**

```bash
bun run test:e2e
```

Expected: PASS apart from tests already marked as expected skips by the repository configuration.

- [ ] **Run repository quality gates one final time**

```bash
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Check the architecture boundary before opening the implementation PR**

Run:

```bash
grep -R "from '../poker\|from '../blackjack" src/lib/video-poker || true
grep -R "/api/wallet/settle\|fetch(" src/lib/video-poker/game.ts src/lib/video-poker/evaluator.ts src/lib/video-poker/cards.ts src/lib/video-poker/paytable.ts || true
```

Expected: no output. `client.ts` may reach wallet behavior only through imports from `../wallet`; the pure files must contain no game-internal imports, fetch calls, or wallet endpoint strings.

## Implementation Completion Criteria

The implementation is ready for review when:

- `/games/video-poker` supports Deal → hold any subset → Draw once → New Round.
- All final hands contain five unique cards and held cards survive the draw.
- The evaluator covers the nine paying Jacks or Better categories plus non-paying hands, including the wheel straight and the Jacks-or-better pair boundary.
- Wagers outside whole-chip values 1–5 or above the available balance are rejected before dealing.
- Guest play persists only the local guest bankroll and sends no wallet request.
- Authenticated completion submits one `SettleRoundCommand` through the existing wallet gate, adopts the returned authoritative balance, and blocks New Round while settlement is unresolved.
- Failed authenticated settlement exposes only manual Retry/Reset through the existing shared recovery primitives.
- The Astro route contains no hand-ranking, payout, or wallet-request implementation.
- No shared-card extraction, compatibility layer, new backend subsystem, generic game framework, or unrelated refactor is present.
