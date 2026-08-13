# Video Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HPA-195 Jacks or Better Video Poker as a self-contained single-player game that reuses the existing CardSlot, public-session, and wallet boundaries.

**Architecture:** Keep deck/evaluator/paytable/round state pure inside `src/lib/video-poker/`. Reuse `CardSlot.astro` + `card-slot-utils.ts` for card presentation, keep the Astro page thin, and use the existing wallet settlement gate/recovery primitives without adding a generic settlement-command builder.

**Tech Stack:** Astro 5, TypeScript, Bun test, Playwright, existing Cloudflare Worker/D1 wallet settlement.

## Global Constraints

- Module home is `src/lib/video-poker/`; do not add a parallel `src/modules` tree.
- Wagers are whole chips from 1 through 5.
- Use one 9/6 Jacks or Better paytable; a five-chip Royal Flush pays 4,000 total.
- Keep deck/evaluator local; do not expose/import Poker/Blackjack rule internals.
- Reuse `CardSlot.astro` and `setSlotState()`; do not create a bespoke text-card renderer.
- Keep `buildVideoPokerSettlementCommand()` game-local. HPA-545 explicitly assigns round/stat semantics to each game; do not add `buildSingleRoundSettlementCommand()` or `canStartRound()` to `wallet` here.
- Do not add one-line Retry/adopt wrappers solely for testing; call `gate.retry()` and `game.setBalance()` directly.
- No generic game base class, state-machine framework, paytable engine, renderer class, repository interface, new API, or database migration.
- No AI, ranked/Daily mode, alternate variants, settings/sound, hand history, server-authoritative deals, anti-cheat, outbox, automatic retry, crash recovery, cross-tab coordination, or compatibility layer.
- Pure game files must not import DOM, fetch, localStorage, wallet, or Astro APIs.
- Guest play never calls `/api/wallet/settle`.
- Authenticated Retry must use `SettlementGate.retry()` so the exact pending command/settlement ID is reused.
- Ordinary wager affordability is a `string | null` rule, not UI exception control flow.
- `GAME_TYPES` is a closed canonical list; Task 4 must run its profile/statistics consumers immediately after registration.

---

## Task 1: Add local card primitives and the fixed paytable

**Files:**
- Create: `src/lib/video-poker/types.ts`
- Create: `src/lib/video-poker/cards.ts`
- Create: `src/lib/video-poker/cards.test.ts`
- Create: `src/lib/video-poker/paytable.ts`
- Create: `src/lib/video-poker/paytable.test.ts`

**Interfaces:**
- Produces `Card`, `HandCategory`, `HandEvaluation`, `VideoPokerRoundResult`, `VideoPokerState`.
- Produces `createDeck()`, `shuffleDeck()`, `createShuffledDeck()`.
- Produces `MIN_WAGER`, `MAX_WAGER`, `WAGER_OPTIONS`, `PAYTABLE_ROWS`, `calculatePayout()`.

- [ ] **Step 1: Write failing deck and paytable tests**

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

  test('shuffles a copy with injectable random', () => {
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
  test('offers one through five chips', () => {
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

  test('uses the five-chip Royal Flush exception', () => {
    expect(calculatePayout('royal-flush', 4)).toBe(1000);
    expect(calculatePayout('royal-flush', 5)).toBe(4000);
  });

  test('rejects invalid paytable wagers', () => {
    expect(() => calculatePayout('flush', 0)).toThrow(RangeError);
    expect(() => calculatePayout('flush', 2.5)).toThrow(RangeError);
    expect(() => calculatePayout('flush', 6)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Verify tests fail before implementation**

```bash
bun test src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
```

Expected: FAIL because the Video Poker module files do not exist.

- [ ] **Step 3: Add domain types**

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
export interface HandEvaluation { category: HandCategory; label: string; }
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

- [ ] **Step 4: Implement deck helpers**

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

- [ ] **Step 5: Implement paytable**

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
  ['Royal Flush', '250× / 4,000 at 5 chips'],
  ['Straight Flush', '50×'],
  ['Four of a Kind', '25×'],
  ['Full House', '9×'],
  ['Flush', '6×'],
  ['Straight', '4×'],
  ['Three of a Kind', '3×'],
  ['Two Pair', '2×'],
  ['Jacks or Better', '1×'],
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

- [ ] **Step 6: Run tests and commit**

```bash
bun test src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
git add src/lib/video-poker/types.ts src/lib/video-poker/cards.ts src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.ts src/lib/video-poker/paytable.test.ts
git commit -m "feat(video-poker): add cards and paytable"
```

Expected: PASS.

---

## Task 2: Implement the pure five-card evaluator

**Files:**
- Create: `src/lib/video-poker/evaluator.ts`
- Create: `src/lib/video-poker/evaluator.test.ts`

**Interfaces:** `evaluateHand(cards: readonly Card[]): HandEvaluation`.

- [ ] **Step 1: Write the failing category and overlap matrix**

Create `src/lib/video-poker/evaluator.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { evaluateHand } from './evaluator';
import type { Card, Rank, Suit } from './types';

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });
const category = (cards: Card[]) => evaluateHand(cards).category;

describe('evaluateHand', () => {
  test('recognizes every Jacks or Better category', () => {
    expect(category([c(10,'hearts'),c(11,'hearts'),c(12,'hearts'),c(13,'hearts'),c(14,'hearts')])).toBe('royal-flush');
    expect(category([c(5,'spades'),c(6,'spades'),c(7,'spades'),c(8,'spades'),c(9,'spades')])).toBe('straight-flush');
    expect(category([c(8,'hearts'),c(8,'diamonds'),c(8,'clubs'),c(8,'spades'),c(2,'hearts')])).toBe('four-of-kind');
    expect(category([c(7,'hearts'),c(7,'diamonds'),c(7,'clubs'),c(13,'hearts'),c(13,'spades')])).toBe('full-house');
    expect(category([c(2,'clubs'),c(5,'clubs'),c(8,'clubs'),c(11,'clubs'),c(14,'clubs')])).toBe('flush');
    expect(category([c(5,'hearts'),c(6,'diamonds'),c(7,'clubs'),c(8,'spades'),c(9,'hearts')])).toBe('straight');
    expect(category([c(4,'hearts'),c(4,'diamonds'),c(4,'clubs'),c(9,'spades'),c(13,'hearts')])).toBe('three-of-kind');
    expect(category([c(3,'hearts'),c(3,'diamonds'),c(12,'clubs'),c(12,'spades'),c(7,'hearts')])).toBe('two-pair');
    expect(category([c(11,'hearts'),c(11,'diamonds'),c(3,'clubs'),c(7,'spades'),c(9,'hearts')])).toBe('jacks-or-better');
    expect(category([c(10,'hearts'),c(10,'diamonds'),c(3,'clubs'),c(7,'spades'),c(9,'hearts')])).toBe('nothing');
  });

  test('recognizes the wheel straight', () => {
    expect(category([c(14,'hearts'),c(2,'diamonds'),c(3,'clubs'),c(4,'spades'),c(5,'hearts')])).toBe('straight');
  });

  test('classifies a suited wheel as Straight Flush, not Royal Flush', () => {
    expect(category([c(14,'spades'),c(2,'spades'),c(3,'spades'),c(4,'spades'),c(5,'spades')])).toBe('straight-flush');
  });

  test('counts a pair of aces as Jacks or Better', () => {
    expect(category([c(14,'hearts'),c(14,'clubs'),c(3,'diamonds'),c(7,'spades'),c(9,'hearts')])).toBe('jacks-or-better');
  });

  test('requires exactly five cards', () => {
    expect(() => evaluateHand([c(14,'hearts')])).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Verify failure**

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

const out = (category: HandCategory): HandEvaluation => ({ category, label: LABELS[category] });

export function evaluateHand(cards: readonly Card[]): HandEvaluation {
  if (cards.length !== 5) {
    throw new RangeError('Video Poker hands must contain exactly five cards');
  }

  const ranks = cards.map((card) => card.rank);
  const unique = [...new Set(ranks)].sort((a, b) => a - b);
  const countsByRank = new Map<number, number>();
  for (const rank of ranks) countsByRank.set(rank, (countsByRank.get(rank) ?? 0) + 1);

  const counts = [...countsByRank.values()].sort((a, b) => b - a);
  const pairRanks = [...countsByRank.entries()]
    .filter(([, count]) => count === 2)
    .map(([rank]) => rank);
  const flush = new Set(cards.map((card) => card.suit)).size === 1;
  const wheel = unique.join(',') === '2,3,4,5,14';
  const consecutive = unique.length === 5 && unique[4] - unique[0] === 4;
  const straight = wheel || consecutive;
  const royal = unique.join(',') === '10,11,12,13,14';

  if (flush && straight && royal) return out('royal-flush');
  if (flush && straight) return out('straight-flush');
  if (counts[0] === 4) return out('four-of-kind');
  if (counts[0] === 3 && counts[1] === 2) return out('full-house');
  if (flush) return out('flush');
  if (straight) return out('straight');
  if (counts[0] === 3) return out('three-of-kind');
  if (pairRanks.length === 2) return out('two-pair');
  if (pairRanks.length === 1 && pairRanks[0] >= 11) return out('jacks-or-better');
  return out('nothing');
}
```

- [ ] **Step 4: Run tests and commit**

```bash
bun test src/lib/video-poker/evaluator.test.ts src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
git add src/lib/video-poker/evaluator.ts src/lib/video-poker/evaluator.test.ts
git commit -m "feat(video-poker): evaluate Jacks or Better hands"
```

Expected: PASS.

---

## Task 3: Add the pure Video Poker round state and one wager-rule source

**Files:**
- Create: `src/lib/video-poker/game.ts`
- Create: `src/lib/video-poker/game.test.ts`

**Interfaces:**

```ts
export class VideoPokerGame {
  constructor(initialBalance: number, random?: () => number);
  getState(): Readonly<VideoPokerState>;
  getWagerError(wager: number): string | null;
  setWager(wager: number): void;
  deal(): void;
  toggleHold(index: number): void;
  draw(): VideoPokerRoundResult;
  resetRound(): void;
  setBalance(balance: number): void;
}
```

- [ ] **Step 1: Write failing state and wager-rule tests**

Create `src/lib/video-poker/game.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { VideoPokerGame } from './game';

const id = (card: { rank: number; suit: string }) => `${card.rank}-${card.suit}`;

describe('VideoPokerGame', () => {
  test('exposes one wager validation rule for the UI and game invariants', () => {
    const game = new VideoPokerGame(3, () => 0);
    expect(game.getWagerError(1)).toBeNull();
    expect(game.getWagerError(2.5)).toContain('whole');
    expect(game.getWagerError(0)).toContain('between');
    expect(game.getWagerError(4)).toBe('Wager exceeds available balance');
  });

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

  test('keeps held cards and replaces unheld cards once', () => {
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
    expect(() => game.draw()).toThrow();
  });

  test('keeps payout and balance math consistent', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.setWager(3);
    game.deal();
    const result = game.draw();
    expect(result.netDelta).toBe(result.payout - 3);
    expect(game.getState().balance).toBe(100 + result.netDelta);
  });

  test('keeps programmer-invalid phase/index calls as invariant failures', () => {
    const game = new VideoPokerGame(100, () => 0);
    expect(() => game.toggleHold(0)).toThrow();
    game.deal();
    const before = game.getState();
    expect(() => game.toggleHold(5)).toThrow();
    expect(game.getState()).toEqual(before);
    expect(() => game.setWager(2)).toThrow();
  });

  test('preserves completed result until explicit reset', () => {
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

- [ ] **Step 2: Verify failure**

```bash
bun test src/lib/video-poker/game.test.ts
```

Expected: FAIL because `VideoPokerGame` does not exist.

- [ ] **Step 3: Implement the pure state and centralized wager rule**

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

  getWagerError(wager: number): string | null {
    if (!Number.isInteger(wager)) return 'Wager must be a whole number of chips';
    const rangeError = validateBet(wager, MIN_WAGER, MAX_WAGER);
    if (rangeError) return rangeError;
    if (wager > this.state.balance) return 'Wager exceeds available balance';
    return null;
  }

  setWager(wager: number): void {
    if (this.state.phase !== 'ready') throw new Error('Wager can only change before dealing');
    const error = this.getWagerError(wager);
    if (error) throw new Error(error); // invariant fallback; client checks the value first
    this.state.wager = wager;
  }

  deal(): void {
    if (this.state.phase !== 'ready') throw new Error('Finish the current hand first');
    const error = this.getWagerError(this.state.wager);
    if (error) throw new Error(error); // invariant fallback; Deal is disabled for this state

    this.deck = createShuffledDeck(this.random);
    this.state = {
      ...this.state,
      phase: 'holding',
      balance: this.state.balance - this.state.wager,
      hand: this.deck.splice(0, 5),
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
    if (held.has(index)) held.delete(index); else held.add(index);
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

- [ ] **Step 4: Run tests and commit**

```bash
bun test src/lib/video-poker
git add src/lib/video-poker/game.ts src/lib/video-poker/game.test.ts
git commit -m "feat(video-poker): add deal hold draw flow"
```

Expected: PASS.

---

## Task 4: Register Video Poker and wire the shared card/wallet browser seams

**Files:**
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.test.ts`
- Create: `src/lib/video-poker/client.ts`
- Create: `src/lib/video-poker/client.test.ts`
- Create: `src/lib/video-poker/index.ts`

**Existing `GAME_TYPES` consumers to validate without pre-emptive churn:**
- `src/lib/game-stats/player-statistics.test.ts`
- `src/lib/profile-statistics-payload.test.ts`
- `src/lib/profile-statistics-renderer.test.ts`
- `src/lib/profile-statistics-client.test.ts`

Current fixtures derive canonical games from `GAME_TYPES`; only change a fixture if the focused suite proves a hard-coded seven-game assumption.

**Client boundary:**

```ts
export function buildVideoPokerSettlementCommand(
  settlementId: string,
  result: Pick<VideoPokerRoundResult, 'netDelta'>,
): SettleRoundCommand;
export function initVideoPokerClient(): void;
```

Do not export Retry/adopt/can-start passthrough helpers.

- [ ] **Step 1: Add failing game-type registration coverage**

In `src/lib/game-stats/game-stats.test.ts` add:

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

Expected: FAIL.

- [ ] **Step 2: Register the canonical textual game type**

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

Add `'video-poker': 'Video Poker'` to `GAME_TYPE_LABELS` and `'video-poker': '♠️'` to `GAME_TYPE_ICONS`.

No schema migration is required.

- [ ] **Step 3: Run closed-enum consumer tests immediately**

```bash
bun test src/lib/game-stats \
  src/lib/profile-statistics-payload.test.ts \
  src/lib/profile-statistics-renderer.test.ts \
  src/lib/profile-statistics-client.test.ts
```

Expected: PASS. If a test hard-codes the old seven-game list, update only that proven fixture and rerun this exact command.

- [ ] **Step 4: Write the game-owned settlement command test**

Create `src/lib/video-poker/client.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildVideoPokerSettlementCommand } from './client';

describe('video poker wallet command', () => {
  test('maps win, push, and loss to Video Poker round stats', () => {
    expect(buildVideoPokerSettlementCommand('win', { netDelta: 8 })).toEqual({
      settlementId: 'win',
      game: 'video-poker',
      delta: 8,
      stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 8 },
    });
    expect(buildVideoPokerSettlementCommand('push', { netDelta: 0 }).stats).toEqual({
      rounds: 1, wins: 0, losses: 0, biggestWin: 0,
    });
    expect(buildVideoPokerSettlementCommand('loss', { netDelta: -5 }).stats).toEqual({
      rounds: 1, wins: 0, losses: 1, biggestWin: 0,
    });
  });
});
```

Run `bun test src/lib/video-poker/client.test.ts`; expected FAIL before `client.ts` exists.

- [ ] **Step 5: Implement the game-owned settlement command**

Start `src/lib/video-poker/client.ts` with imports from existing shared seams:

```ts
import { setSlotState } from '../card-slot-utils';
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
  type SettleRoundCommand,
  type SettleRoundResult,
} from '../wallet';
import { VideoPokerGame } from './game';
import { MIN_WAGER } from './paytable';
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

function rankLabel(rank: Card['rank']): string {
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  if (rank === 14) return 'A';
  return String(rank);
}
```

Do not move this builder into `wallet`: HPA-545 keeps game statistics mapping at the game boundary.

- [ ] **Step 6: Implement browser composition using CardSlot instead of text-card rendering**

Inside `initVideoPokerClient()` resolve:

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

Initialize one game and one settlement gate:

```ts
const clientUserId = root?.dataset.userId ?? 'anonymous';
const isGuestMode = isGuestModeValue(root?.dataset.guestMode ?? 'false');
const initialBalance = Number(root?.dataset.initialBalance ?? '1000');
const startingBalance = isGuestMode
  ? loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)
  : initialBalance;
const game = new VideoPokerGame(startingBalance);
const gate = createSettlementGate();
let serverSyncedBalance = startingBalance;
let wagerMessage: string | null = null;
let settlementMessage: string | null = null;
```

Render card slots with the shared helper:

```ts
function renderCards(): void {
  const state = game.getState();
  for (const button of cardButtons) {
    const index = Number(button.dataset.cardIndex);
    const slot = document.getElementById(`video-poker-slot-${index}`);
    if (!slot) continue;
    const card = state.hand[index];
    const held = state.heldIndexes.includes(index);

    if (!card) {
      setSlotState(slot, 'placeholder');
      button.dataset.cardId = '';
      button.setAttribute('aria-label', `Card ${index + 1}`);
    } else {
      setSlotState(slot, 'card', { rank: rankLabel(card.rank), suit: card.suit });
      button.dataset.cardId = `${card.rank}-${card.suit}`;
      button.setAttribute('aria-label', `Hold ${rankLabel(card.rank)} of ${card.suit}`);
    }

    button.setAttribute('aria-pressed', String(held));
    button.disabled = state.phase !== 'holding';
  }
}
```

`render()` must also:

- render `state.balance` into `#chip-balance`;
- mark the selected wager through `aria-pressed`;
- render result only from `state.result`;
- choose `Deal`, `Draw`, or `New Round` from `state.phase`;
- compute `const settlementBlocked = !isGuestMode && gate.isBlocked`;
- disable Deal when `game.getWagerError(state.wager) !== null || settlementBlocked`;
- disable New Round while `settlementBlocked`;
- when ready with `state.balance < MIN_WAGER`, show `Not enough chips to deal.` and append ` Sign in to get more chips.` for guests;
- otherwise prioritize `settlementMessage`, then `wagerMessage`, then the normal phase status.

Do not recalculate hand category or payout in the client.

- [ ] **Step 7: Keep ordinary wager errors on the value path**

Wager handlers must check `getWagerError()` before mutation:

```ts
for (const button of wagerButtons) {
  button.addEventListener('click', () => {
    if (game.getState().phase !== 'ready') return;
    const wager = Number(button.dataset.wager);
    const error = game.getWagerError(wager);
    if (error) {
      wagerMessage = error;
      render();
      return;
    }
    game.setWager(wager);
    wagerMessage = null;
    render();
  });
}
```

Hold handlers keep only an outer invariant guard:

```ts
for (const button of cardButtons) {
  button.addEventListener('click', () => {
    if (game.getState().phase !== 'holding') return;
    try {
      game.toggleHold(Number(button.dataset.cardIndex));
      render();
    } catch (error) {
      wagerMessage = error instanceof Error ? error.message : 'Unable to hold card';
      render();
    }
  });
}
```

- [ ] **Step 8: Wire settlement recovery explicitly with a real attach target**

Create controls before primary-action wiring:

```ts
const recovery = ensureSettlementRecoveryControls({
  attachTo: recoveryHost,
  containerId: 'video-poker-settlement-recovery',
  retryId: 'video-poker-retry-settlement',
  resetId: 'video-poker-reset-settlement',
  containerClass: 'hidden mt-4 flex flex-wrap justify-center gap-3',
  retryLabel: 'Retry settlement',
  resetLabel: 'Reset hand',
  retryClass: 'deco-btn px-4 py-2 rounded-lg',
  resetClass: 'deco-btn px-4 py-2 rounded-lg',
});

function showSettlementRecovery(message: string): void {
  settlementMessage = message;
  recovery.container?.classList.remove('hidden');
  render();
}

function hideSettlementRecovery(): void {
  settlementMessage = null;
  recovery.container?.classList.add('hidden');
}

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

Use direct gate Retry/Reset; do not export passthrough helpers:

```ts
recovery.retry?.addEventListener('click', async () => {
  if (!gate.pending) return;
  if (recovery.retry) recovery.retry.disabled = true;
  settlementMessage = 'Retrying settlement...';
  render();
  try {
    const result = await gate.retry();
    if (result) adoptSettlementResult(result);
  } catch (error) {
    console.error('[WALLET_SETTLEMENT] Video Poker retry failed:', error);
    showSettlementRecovery('Settlement failed again. Retry or reset the hand.');
  } finally {
    if (recovery.retry) recovery.retry.disabled = false;
  }
});

recovery.reset?.addEventListener('click', () => {
  gate.reset();
  game.setBalance(serverSyncedBalance);
  if (game.getState().phase === 'complete') game.resetRound();
  hideSettlementRecovery();
  wagerMessage = null;
  render();
});
```

- [ ] **Step 9: Implement Deal → Draw → New Round**

Primary action:

```ts
async function onPrimaryAction(): Promise<void> {
  const state = game.getState();
  const settlementBlocked = !isGuestMode && gate.isBlocked;

  if (state.phase === 'ready') {
    const wagerError = game.getWagerError(state.wager);
    if (wagerError) {
      wagerMessage = wagerError;
      render();
      return;
    }
    if (settlementBlocked) return;
    try {
      game.deal();
      wagerMessage = null;
      render();
    } catch (error) {
      wagerMessage = error instanceof Error ? error.message : 'Unable to deal';
      render();
    }
    return;
  }

  if (state.phase === 'holding') {
    let round: VideoPokerRoundResult;
    try {
      round = game.draw();
      render();
    } catch (error) {
      wagerMessage = error instanceof Error ? error.message : 'Unable to draw';
      render();
      return;
    }

    if (!shouldSyncAccountChips({ isGuestMode })) {
      persistGuestBankroll(GAME_KEY, clientUserId, game.getState().balance);
      return;
    }

    try {
      const result = await gate.settle(
        buildVideoPokerSettlementCommand(newSettlementId('video-poker'), round),
      );
      adoptSettlementResult(result);
    } catch (error) {
      console.error('[WALLET_SETTLEMENT] Video Poker settlement failed:', error);
      showSettlementRecovery('Settlement failed. Retry or reset before starting another hand.');
    }
    render();
    return;
  }

  if (settlementBlocked) return;
  try {
    game.resetRound();
    wagerMessage = null;
    render();
  } catch (error) {
    wagerMessage = error instanceof Error ? error.message : 'Unable to start a new hand';
    render();
  }
}
```

Attach it once to `#video-poker-action` and call `render()` once at initialization.

- [ ] **Step 10: Add the module barrel and run Task 4 tests**

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

Run:

```bash
bun test src/lib/video-poker src/lib/game-stats \
  src/lib/profile-statistics-payload.test.ts \
  src/lib/profile-statistics-renderer.test.ts \
  src/lib/profile-statistics-client.test.ts
```

Expected: PASS.

Commit:

```bash
git add src/lib/game-stats/constants.ts src/lib/game-stats/game-stats.test.ts src/lib/video-poker
git commit -m "feat(video-poker): integrate shared UI and wallet seams"
```

---

## Task 5: Add the thin route, lobby entry, guest E2E, and authenticated recovery E2E

**Files:**
- Create: `src/pages/games/video-poker.astro`
- Modify: `src/pages/index.astro`
- Create: `e2e/video-poker.spec.ts`

**Interfaces:**
- Route uses `createPublicGameSession()`.
- Route uses `CardSlot.astro`, `WAGER_OPTIONS`, `PAYTABLE_ROWS`.
- Client owns all behavior.

- [ ] **Step 1: Write the failing guest flow using card identity, not rendered text**

Create `e2e/video-poker.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

async function gotoVideoPoker(page: Page): Promise<void> {
  await page.goto('/games/video-poker', { waitUntil: 'domcontentloaded' });
}

const createIsolatedVideoPokerPage = (browser: Browser, baseURL?: string) =>
  createIsolatedPage(browser, baseURL, {
    emailPrefix: 'video-poker-wallet',
    namePrefix: 'Video Poker Wallet',
    navigate: gotoVideoPoker,
  });

test.describe('Video Poker guest', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('guest can Deal, hold, Draw once, and start New Round locally', async ({ page }) => {
    const walletRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
    });
    await page.addInitScript(() => { Math.random = () => 0; });
    await gotoVideoPoker(page);

    await expect(page.getByTestId('video-poker-root')).toHaveAttribute('data-guest-mode', 'true');
    await expect(page.getByTestId('chip-balance')).toContainText('1,000');
    await page.locator('[data-wager="2"]').click();
    await page.locator('#video-poker-action').click();
    await expect(page.locator('#video-poker-action')).toHaveText('Draw');

    const first = page.locator('[data-card-index="0"]');
    const third = page.locator('[data-card-index="2"]');
    const firstId = await first.getAttribute('data-card-id');
    const thirdId = await third.getAttribute('data-card-id');
    expect(firstId).toBeTruthy();
    expect(thirdId).toBeTruthy();

    await first.click();
    await third.click();
    await expect(first).toHaveAttribute('aria-pressed', 'true');
    await expect(third).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#video-poker-action').click();

    await expect(page.locator('#video-poker-action')).toHaveText('New Round');
    await expect(first).toHaveAttribute('data-card-id', firstId!);
    await expect(third).toHaveAttribute('data-card-id', thirdId!);
    await expect(page.locator('#video-poker-result')).not.toBeEmpty();

    await page.locator('#video-poker-action').click();
    await expect(page.locator('#video-poker-action')).toHaveText('Deal');
    expect(walletRequests).toEqual([]);
  });
});
```

Run `bunx playwright test e2e/video-poker.spec.ts`; expected FAIL because the route does not exist.

- [ ] **Step 2: Write the failing authenticated settlement-recovery flow**

Append to the same file:

```ts
test.describe('Video Poker wallet recovery', () => {
  test('failed settlement shows recovery and Retry reuses the exact command', async ({
    browser,
    baseURL,
  }) => {
    const { context, page } = await createIsolatedVideoPokerPage(browser, baseURL);
    try {
      const commands: Array<Record<string, unknown>> = [];
      const startingBalance = Number(
        (await page.getByTestId('chip-balance').textContent())?.replace(/[^0-9]/g, '') ?? '0',
      );

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

      await page.locator('#video-poker-action').click(); // Deal
      await page.locator('#video-poker-action').click(); // Draw + settlement

      await expect(page.locator('#video-poker-settlement-recovery')).toBeVisible();
      await expect(page.locator('#video-poker-retry-settlement')).toBeVisible();
      await expect(page.locator('#video-poker-reset-settlement')).toBeVisible();
      await expect(page.locator('#video-poker-action')).toHaveText('New Round');
      await expect(page.locator('#video-poker-action')).toBeDisabled();
      expect(commands).toHaveLength(1);

      await page.locator('#video-poker-retry-settlement').click();

      await expect(page.locator('#video-poker-settlement-recovery')).toBeHidden();
      await expect(page.locator('#video-poker-action')).toBeEnabled();
      expect(commands).toHaveLength(2);
      expect(commands[1]).toEqual(commands[0]);
    } finally {
      await context.close();
    }
  });
});
```

This test is intentionally limited to visible recovery + exact Retry identity. Do not add reload/crash/outbox cases.

- [ ] **Step 3: Create the thin Astro page with shared CardSlot markup**

Create `src/pages/games/video-poker.astro`:

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import CardSlot from '../../components/CardSlot.astro';
import { createPublicGameSession } from '../../lib/public-game-session';
import { PAYTABLE_ROWS, WAGER_OPTIONS } from '../../lib/video-poker';

const gameSession = createPublicGameSession(Astro.locals.user);
---

<CasinoLayout title="Video Poker - Arcturus Casino">
  <main
    id="video-poker-root"
    data-testid="video-poker-root"
    data-user-id={gameSession.clientUserId}
    data-guest-mode={gameSession.guestModeValue}
    data-initial-balance={gameSession.initialBalance}
    class="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8"
  >
    <header class="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <a href="/games" class="text-[var(--deco-muted)]">← Back to Games</a>
        <h1 class="deco-section-title text-4xl">Video Poker</h1>
        <p class="text-[var(--deco-muted)]">Jacks or Better · 9/6 paytable</p>
      </div>
      <div class="deco-panel px-5 py-3">
        <div class="text-xs text-[var(--deco-muted)]">{gameSession.balanceLabel}</div>
        <div
          id="chip-balance"
          data-testid="chip-balance"
          class="text-2xl font-bold text-[var(--deco-brass)]"
        >
          {gameSession.initialBalance.toLocaleString()}
        </div>
      </div>
    </header>

    <section class="felt-table rounded-3xl p-6">
      <div id="video-poker-status" role="status" aria-live="polite" class="mb-4 text-center">
        Choose a wager and deal
      </div>

      <div class="grid grid-cols-5 gap-3">
        {Array.from({ length: 5 }, (_, index) => (
          <div class="relative flex justify-center">
            <CardSlot id={`video-poker-slot-${index}`} size="large" showPlaceholder={true} />
            <button
              type="button"
              data-card-index={index}
              data-card-id=""
              aria-label={`Card ${index + 1}`}
              aria-pressed="false"
              disabled
              class="card-hold-toggle absolute inset-0 rounded-xl border-2 border-transparent"
            ></button>
          </div>
        ))}
      </div>

      <div id="video-poker-result" role="status" aria-live="polite" class="mt-4 min-h-6 text-center"></div>

      <div class="mt-5 flex flex-wrap justify-center gap-2">
        {WAGER_OPTIONS.map((wager) => (
          <button
            type="button"
            data-wager={wager}
            aria-pressed={wager === 1 ? 'true' : 'false'}
            class="deco-btn rounded-lg px-4 py-2"
          >
            {wager}
          </button>
        ))}
      </div>

      <div class="mt-5 flex justify-center">
        <button id="video-poker-action" type="button" class="deco-btn rounded-lg px-8 py-3">
          Deal
        </button>
      </div>
      <div id="video-poker-recovery-host"></div>
    </section>

    <aside class="deco-panel mt-6 p-5">
      <h2 class="deco-section-title text-2xl">Paytable</h2>
      <div class="mt-3 grid gap-2">
        {PAYTABLE_ROWS.map(([label, payout]) => (
          <div class="flex justify-between gap-4">
            <span>{label}</span><span>{payout}</span>
          </div>
        ))}
      </div>
    </aside>
  </main>
</CasinoLayout>

<style>
  .card-hold-toggle[aria-pressed='true'] {
    border-color: var(--deco-brass);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--deco-brass) 35%, transparent);
  }
</style>

<script>
  import { initVideoPokerClient } from '../../lib/video-poker';
  initVideoPokerClient();
</script>
```

The overlay button keeps valid interactive markup: `CardSlot.astro` is a sibling inside a relative wrapper, not nested inside `<button>`.

- [ ] **Step 4: Add the lobby entry**

In `src/pages/index.astro` add:

```ts
{
  name: 'Video Poker',
  emblem: 'cards' as const,
  players: 0,
  minBet: 1,
  href: '/games/video-poker',
},
```

Do not mark it Featured.

- [ ] **Step 5: Run Task 5 validation before committing**

```bash
bunx playwright test e2e/video-poker.spec.ts
bun test src/lib/video-poker src/lib/game-stats \
  src/lib/profile-statistics-payload.test.ts \
  src/lib/profile-statistics-renderer.test.ts \
  src/lib/profile-statistics-client.test.ts
bun run lint
bun run format:check
bun run build
```

Expected: all commands PASS.

Commit:

```bash
git add src/pages/games/video-poker.astro src/pages/index.astro e2e/video-poker.spec.ts
git commit -m "feat(video-poker): add playable Jacks or Better route"
```

---

## Final Verification

- [ ] `bun run test`
- [ ] `bun run test:e2e`
- [ ] `bun run lint`
- [ ] `bun run format:check`
- [ ] `bun run build`

Architecture check:

```bash
grep -R "from '../poker\|from '../blackjack" src/lib/video-poker || true
grep -R "/api/wallet/settle\|fetch(" \
  src/lib/video-poker/game.ts \
  src/lib/video-poker/evaluator.ts \
  src/lib/video-poker/cards.ts \
  src/lib/video-poker/paytable.ts || true
grep -R "buildSingleRoundSettlementCommand\|canStartRound" src/lib/wallet src/lib/video-poker || true
```

Expected: first two commands have no output. The third has no output because this ticket keeps command semantics game-local rather than expanding the wallet public API.

## Completion Criteria

- Deal → hold subset → Draw once → New Round works.
- Held cards survive Draw and final hand has no duplicates.
- Evaluator covers all categories, wheel straight, suited wheel Straight Flush, low-pair rejection, and ace-pair qualification.
- `getWagerError()` is the single ordinary wager-rule source; Deal disables for invalid/over-balance wager.
- Balance below one chip shows an explicit no-chips status instead of a silently dead Deal button.
- Card faces use shared `CardSlot.astro` + `setSlotState()`; hold state is only an overlay-button concern.
- Root and balance follow existing `data-testid` conventions.
- Guest mode remains local and performs no wallet request.
- Authenticated settlement creates one game-owned command, adopts server balance, shows Retry/Reset on failure, blocks New Round while unresolved, and Retry resends the exact pending command/ID.
- `GAME_TYPES` consumer tests pass without unnecessary fixture churn.
- The Astro route contains no ranking, payout, or wallet-request logic.
- No shared card-rule extraction, generic wallet command builder, generic game framework, new backend subsystem, or unrelated refactor is introduced.