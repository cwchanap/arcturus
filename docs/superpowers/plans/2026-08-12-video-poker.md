# Video Poker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add HPA-195 Jacks or Better Video Poker as a self-contained single-player module using the existing guest-session and wallet seams.

**Architecture:** Keep cards, hand evaluation, payouts, and round state pure inside `src/lib/video-poker/`. Keep DOM/session/wallet composition in one `client.ts`, keep the Astro route thin, and reuse only `bet-validation`, `public-game-session`, `card-format`, and the `wallet` barrel.

**Tech Stack:** Astro 5, TypeScript, Bun test, Happy DOM, Playwright, existing Cloudflare Worker/D1 wallet settlement.

## Global Constraints

- Module home is `src/lib/video-poker/`; do not add `src/modules`.
- Wagers are whole chips from 1 through 5.
- Use one 9/6 Jacks or Better paytable; five-chip Royal Flush pays 4,000 total.
- Keep deck/evaluator local; do not extract Poker/Blackjack cards in this ticket.
- No generic game base class, state-machine framework, paytable engine, repository interface, renderer class, new API, or database migration.
- No AI, ranked/Daily mode, alternate variants, settings/sound, hand history, server-authoritative deals, anti-cheat, outbox, automatic retry, crash recovery, cross-tab coordination, or compatibility layer.
- Pure game files must not import DOM, fetch, localStorage, wallet, or Astro APIs.
- Guest play never calls `/api/wallet/settle`.
- Authenticated retry must call the existing settlement gate's `retry()` and therefore reuse the exact pending command/settlement ID.
- Browser action errors must be caught and rendered in `#video-poker-status`.
- `GAME_TYPES` is a closed canonical list; Task 4 must run its profile/statistics consumer tests before completion.

---

## Task 1: Local card primitives and fixed paytable

**Files:**
- Create: `src/lib/video-poker/types.ts`
- Create: `src/lib/video-poker/cards.ts`
- Create: `src/lib/video-poker/cards.test.ts`
- Create: `src/lib/video-poker/paytable.ts`
- Create: `src/lib/video-poker/paytable.test.ts`

**Interfaces:**
- Produces `Card`, `HandCategory`, `HandEvaluation`, `VideoPokerRoundResult`, `VideoPokerState`.
- Produces `createDeck()`, `shuffleDeck()`, `createShuffledDeck()`.
- Produces `WAGER_OPTIONS`, `PAYTABLE_ROWS`, `calculatePayout()`.

- [ ] **Step 1: Write failing deck/paytable tests**

`cards.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createDeck, shuffleDeck } from './cards';
import type { Card } from './types';

const id = (card: Card) => `${card.rank}-${card.suit}`;

describe('video poker cards', () => {
  test('creates 52 unique cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(id)).size).toBe(52);
    expect(new Set(deck.map((card) => card.suit))).toEqual(
      new Set(['hearts', 'diamonds', 'clubs', 'spades']),
    );
  });

  test('shuffle copies the input and accepts deterministic random', () => {
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

`paytable.test.ts`:

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

  test('uses the five-chip royal exception', () => {
    expect(calculatePayout('royal-flush', 4)).toBe(1000);
    expect(calculatePayout('royal-flush', 5)).toBe(4000);
  });

  test('rejects invalid wagers', () => {
    expect(() => calculatePayout('flush', 0)).toThrow(RangeError);
    expect(() => calculatePayout('flush', 2.5)).toThrow(RangeError);
    expect(() => calculatePayout('flush', 6)).toThrow(RangeError);
  });
});
```

- [ ] **Step 2: Verify the tests fail before implementation**

```bash
bun test src/lib/video-poker/cards.test.ts src/lib/video-poker/paytable.test.ts
```

Expected: FAIL because the module files do not exist.

- [ ] **Step 3: Add domain types**

`types.ts`:

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

`cards.ts`:

```ts
import type { Card, Rank, Suit } from './types';

const SUITS: readonly Suit[] = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS: readonly Rank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];

export function createDeck(): Card[] {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ rank, suit })));
}

export function shuffleDeck(deck: readonly Card[], random: () => number = Math.random): Card[] {
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

`paytable.ts`:

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

## Task 2: Pure five-card evaluator

**Files:**
- Create: `src/lib/video-poker/evaluator.ts`
- Create: `src/lib/video-poker/evaluator.test.ts`

**Interfaces:** `evaluateHand(cards: readonly Card[]): HandEvaluation`.

- [ ] **Step 1: Write the failing evaluator matrix**

`evaluator.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { evaluateHand } from './evaluator';
import type { Card, Rank, Suit } from './types';

const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });
const category = (cards: Card[]) => evaluateHand(cards).category;

describe('evaluateHand', () => {
  test('recognizes every category', () => {
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

  test('treats A-2-3-4-5 as a straight', () => {
    expect(category([c(14,'hearts'),c(2,'diamonds'),c(3,'clubs'),c(4,'spades'),c(5,'hearts')])).toBe('straight');
  });

  test('treats a suited A-2-3-4-5 as a straight flush, not a royal', () => {
    expect(category([c(14,'spades'),c(2,'spades'),c(3,'spades'),c(4,'spades'),c(5,'spades')])).toBe('straight-flush');
  });

  test('treats a pair of aces as Jacks or Better', () => {
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

- [ ] **Step 3: Implement explicit precedence**

`evaluator.ts`:

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
  if (cards.length !== 5) throw new RangeError('Video Poker hands must contain exactly five cards');

  const ranks = cards.map((card) => card.rank);
  const unique = [...new Set(ranks)].sort((a, b) => a - b);
  const rankCounts = new Map<number, number>();
  for (const rank of ranks) rankCounts.set(rank, (rankCounts.get(rank) ?? 0) + 1);

  const counts = [...rankCounts.values()].sort((a, b) => b - a);
  const pairRanks = [...rankCounts.entries()].filter(([, n]) => n === 2).map(([rank]) => rank);
  const flush = new Set(cards.map((card) => card.suit)).size === 1;
  const wheel = unique.join(',') === '2,3,4,5,14';
  const straight = wheel || (unique.length === 5 && unique[4] - unique[0] === 4);
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

## Task 3: Pure round state

**Files:**
- Create: `src/lib/video-poker/game.ts`
- Create: `src/lib/video-poker/game.test.ts`

**Interfaces:**

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

- [ ] **Step 1: Write failing state tests**

`game.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { VideoPokerGame } from './game';

const id = (card: { rank: number; suit: string }) => `${card.rank}-${card.suit}`;

describe('VideoPokerGame', () => {
  test('Deal deducts wager and produces five unique cards', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.setWager(5);
    game.deal();
    const state = game.getState();
    expect(state.phase).toBe('holding');
    expect(state.balance).toBe(95);
    expect(new Set(state.hand.map(id)).size).toBe(5);
  });

  test('held cards survive Draw and replacements remain unique', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    const dealt = game.getState().hand.map(id);
    game.toggleHold(0);
    game.toggleHold(2);
    const result = game.draw();
    const final = result.finalHand.map(id);
    expect(final[0]).toBe(dealt[0]);
    expect(final[2]).toBe(dealt[2]);
    expect(new Set(final).size).toBe(5);
    expect(() => game.draw()).toThrow();
  });

  test('payout and net delta update balance consistently', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.setWager(3);
    game.deal();
    const result = game.draw();
    expect(result.netDelta).toBe(result.payout - 3);
    expect(game.getState().balance).toBe(100 + result.netDelta);
  });

  test('rejects invalid or over-balance wagers', () => {
    const game = new VideoPokerGame(3, () => 0);
    expect(() => game.setWager(2.5)).toThrow();
    expect(() => game.setWager(4)).toThrow();
    expect(game.getState().phase).toBe('ready');
  });

  test('rejects invalid hold indexes without mutating state', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    const before = game.getState();
    expect(() => game.toggleHold(5)).toThrow();
    expect(game.getState()).toEqual(before);
  });

  test('keeps result visible until explicit New Round reset', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    game.draw();
    const balance = game.getState().balance;
    game.resetRound();
    expect(game.getState()).toMatchObject({ phase: 'ready', balance, hand: [], heldIndexes: [], result: null });
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
bun test src/lib/video-poker/game.test.ts
```

Expected: FAIL because `VideoPokerGame` does not exist.

- [ ] **Step 3: Implement the pure state owner**

`game.ts`:

```ts
import { validateBet } from '../bet-validation';
import { createShuffledDeck } from './cards';
import { evaluateHand } from './evaluator';
import { calculatePayout, MAX_WAGER, MIN_WAGER } from './paytable';
import type { Card, VideoPokerRoundResult, VideoPokerState } from './types';

function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) throw new RangeError('Balance must be non-negative');
  return Math.trunc(balance);
}

export class VideoPokerGame {
  private readonly random: () => number;
  private deck: Card[] = [];
  private state: VideoPokerState;

  constructor(initialBalance: number, random: () => number = Math.random) {
    this.random = random;
    this.state = { phase: 'ready', balance: normalizeBalance(initialBalance), wager: 1, hand: [], heldIndexes: [], result: null };
  }

  getState(): Readonly<VideoPokerState> {
    return {
      ...this.state,
      hand: [...this.state.hand],
      heldIndexes: [...this.state.heldIndexes],
      result: this.state.result ? { ...this.state.result, finalHand: [...this.state.result.finalHand] } : null,
    };
  }

  setWager(wager: number): void {
    if (this.state.phase !== 'ready') throw new Error('Wager can only change before dealing');
    if (!Number.isInteger(wager)) throw new Error('Wager must be a whole number of chips');
    const error = validateBet(wager, MIN_WAGER, MAX_WAGER);
    if (error) throw new Error(error);
    if (wager > this.state.balance) throw new Error('Wager exceeds available balance');
    this.state.wager = wager;
  }

  deal(): void {
    if (this.state.phase !== 'ready') throw new Error('Finish the current hand first');
    if (this.state.wager > this.state.balance) throw new Error('Wager exceeds available balance');
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
    if (!Number.isInteger(index) || index < 0 || index >= 5) throw new RangeError('Card index must be 0 through 4');
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
    const result = {
      evaluation,
      wager: this.state.wager,
      payout,
      netDelta: payout - this.state.wager,
      finalHand: [...finalHand],
    } satisfies VideoPokerRoundResult;
    this.state = { ...this.state, phase: 'complete', balance: this.state.balance + payout, hand: [...finalHand], result };
    return result;
  }

  resetRound(): void {
    if (this.state.phase !== 'complete') throw new Error('Only a completed hand can be reset');
    this.deck = [];
    this.state = { ...this.state, phase: 'ready', hand: [], heldIndexes: [], result: null };
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

## Task 4: Register the game and wire browser/wallet settlement

**Files:**
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.test.ts`
- Create: `src/lib/video-poker/client.ts`
- Create: `src/lib/video-poker/client.test.ts`
- Create: `src/lib/video-poker/index.ts`

**Closed-enum consumers to validate without pre-emptive churn:**
- `src/lib/game-stats/player-statistics.test.ts`
- `src/lib/profile-statistics-payload.test.ts`
- `src/lib/profile-statistics-renderer.test.ts`
- `src/lib/profile-statistics-client.test.ts`

Current fixtures in those files derive canonical games from `GAME_TYPES`; only change a fixture if the focused suite proves a hard-coded assumption remains.

**Interfaces:**

```ts
export function buildVideoPokerSettlementCommand(
  settlementId: string,
  result: Pick<VideoPokerRoundResult, 'netDelta'>,
): SettleRoundCommand;
export function canStartVideoPokerRound(args: { isGuestMode: boolean; gate: Pick<SettlementGate, 'isBlocked'> }): boolean;
export function canDealVideoPokerRound(args: { isGuestMode: boolean; gate: Pick<SettlementGate, 'isBlocked'>; balance: number; wager: number }): boolean;
export function retryVideoPokerSettlement(gate: Pick<SettlementGate, 'retry'>): Promise<SettleRoundResult | null>;
export function applyVideoPokerSettlementResult(game: Pick<VideoPokerGame, 'setBalance'>, result: SettleRoundResult): number;
export function resetVideoPokerSettlement(
  gate: Pick<SettlementGate, 'reset'>,
  game: Pick<VideoPokerGame, 'getState' | 'setBalance' | 'resetRound'>,
  serverSyncedBalance: number,
): void;
export function initVideoPokerClient(): void;
```

- [ ] **Step 1: Add failing `GAME_TYPES` registration coverage**

In `game-stats.test.ts`:

```ts
test('registers Video Poker as a valid game type', () => {
  expect(isValidGameType('video-poker')).toBe(true);
  expect(GAME_TYPE_LABELS['video-poker']).toBe('Video Poker');
  expect(GAME_TYPE_ICONS['video-poker']).toBe('♠️');
});
```

Run:

```bash
bun test src/lib/game-stats/game-stats.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Register the new canonical game**

Add `'video-poker'` to `GAME_TYPES` after `keno`, add `'video-poker': 'Video Poker'` to `GAME_TYPE_LABELS`, and add `'video-poker': '♠️'` to `GAME_TYPE_ICONS`.

No schema migration is needed because game type storage is textual.

- [ ] **Step 3: Run the closed-enum consumer gate now**

```bash
bun test src/lib/game-stats src/lib/profile-statistics-payload.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
```

Expected: PASS. If a specific test hard-codes the old seven-game list, change that fixture to derive from `GAME_TYPES` and rerun this exact command.

- [ ] **Step 4: Write wallet-boundary tests before the client implementation**

`client.test.ts` starts with:

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
  test('maps win/push/loss to one wallet command', () => {
    expect(buildVideoPokerSettlementCommand('win', { netDelta: 8 })).toEqual({
      settlementId: 'win', game: 'video-poker', delta: 8,
      stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 8 },
    });
    expect(buildVideoPokerSettlementCommand('push', { netDelta: 0 }).stats).toEqual({ rounds: 1, wins: 0, losses: 0, biggestWin: 0 });
    expect(buildVideoPokerSettlementCommand('loss', { netDelta: -5 }).stats).toEqual({ rounds: 1, wins: 0, losses: 1, biggestWin: 0 });
  });

  test('blocks authenticated New Round while the gate is blocked', () => {
    const gate = { isBlocked: true } as SettlementGate;
    expect(canStartVideoPokerRound({ isGuestMode: false, gate })).toBe(false);
    expect(canStartVideoPokerRound({ isGuestMode: true, gate })).toBe(true);
  });

  test('disables Deal when the wager exceeds the current balance', () => {
    expect(canDealVideoPokerRound({ isGuestMode: false, gate: { isBlocked: false }, balance: 3, wager: 5 })).toBe(false);
  });

  test('delegates Retry to the shared gate', async () => {
    let calls = 0;
    const result = await retryVideoPokerSettlement({ retry: async () => { calls += 1; return { balance: 108, duplicate: false }; } });
    expect(calls).toBe(1);
    expect(result).toEqual({ balance: 108, duplicate: false });
  });

  test('adopts the authoritative server balance', () => {
    const game = new VideoPokerGame(100, () => 0);
    const synced = applyVideoPokerSettlementResult(game, { balance: 77, duplicate: false });
    expect(synced).toBe(77);
    expect(game.getState().balance).toBe(77);
  });

  test('Reset clears the gate and restores last confirmed balance', () => {
    const game = new VideoPokerGame(100, () => 0);
    game.deal();
    game.draw();
    let calls = 0;
    resetVideoPokerSettlement({ reset: () => { calls += 1; } }, game, 100);
    expect(calls).toBe(1);
    expect(game.getState()).toMatchObject({ phase: 'ready', balance: 100, result: null });
  });
});
```

Run `bun test src/lib/video-poker/client.test.ts`; expected FAIL before `client.ts` exists.

- [ ] **Step 5: Implement the wallet/client helper functions**

At the top of `client.ts` import the existing `card-format`, `public-game-session`, and `wallet` barrel APIs, then implement:

```ts
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

export function canStartVideoPokerRound({ isGuestMode, gate }: {
  isGuestMode: boolean;
  gate: Pick<SettlementGate, 'isBlocked'>;
}): boolean {
  return isGuestMode || !gate.isBlocked;
}

export function canDealVideoPokerRound({ isGuestMode, gate, balance, wager }: {
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

- [ ] **Step 6: Add one Happy DOM error-surfacing test**

Extend `client.test.ts` with Happy DOM globals and this minimal fixture/test:

```ts
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

test('invalid wager click writes status instead of escaping the handler', () => {
  const root = makeClientRoot();
  initVideoPokerClient();
  (root.querySelector('[data-wager="5"]') as HTMLButtonElement).click();
  expect(root.querySelector('#video-poker-status')?.textContent).toContain('Wager exceeds available balance');
  expect(root.querySelector('#video-poker-action')?.textContent).toBe('Deal');
  root.remove();
});
```

Use the same Happy DOM global setup/restore pattern already present in `src/lib/keno/kenoClient.test.ts`; do not introduce another test environment library.

- [ ] **Step 7: Implement browser composition with caught pure actions**

`initVideoPokerClient()` must:

- Read `#video-poker-root` session metadata.
- Load/persist guest bankroll through `public-game-session`.
- Create one `VideoPokerGame` and one `createSettlementGate()`.
- Keep `serverSyncedBalance` and `actionError` as client-local variables.
- Render Deal/Draw/New Round from `game.getState().phase`.
- Disable Deal when `!canDealVideoPokerRound(...)`.
- Disable authenticated New Round while `gate.isBlocked`.
- Wrap wager, hold, Deal, Draw, and `resetRound()` calls in `try/catch`; set `actionError = error instanceof Error ? error.message : 'Unable to complete action'` and rerender.
- Keep wallet settlement failure handling separate from pure game-action errors.

Use this primary action structure:

```ts
async function onPrimaryAction(): Promise<void> {
  const state = game.getState();

  if (state.phase === 'ready') {
    if (!canDealVideoPokerRound({ isGuestMode, gate, balance: state.balance, wager: state.wager })) return;
    try { game.deal(); actionError = null; render(); } catch (error) { showActionError(error); }
    return;
  }

  if (state.phase === 'holding') {
    let round: VideoPokerRoundResult;
    try { round = game.draw(); actionError = null; render(); } catch (error) { showActionError(error); return; }

    if (!shouldSyncAccountChips({ isGuestMode })) {
      persistGuestBankroll(GAME_KEY, clientUserId, game.getState().balance);
      render();
      return;
    }

    try {
      const result = await gate.settle(
        buildVideoPokerSettlementCommand(newSettlementId('video-poker'), round),
      );
      serverSyncedBalance = applyVideoPokerSettlementResult(game, result);
      hideSettlementRecovery();
      if (result.newAchievements?.length) {
        window.dispatchEvent(new CustomEvent('achievement-earned', { detail: { achievements: result.newAchievements } }));
      }
    } catch (error) {
      console.error('[WALLET_SETTLEMENT] Video Poker settlement failed:', error);
      showSettlementRecovery('Settlement failed. Retry or reset before starting another hand.');
    }
    render();
    return;
  }

  if (!canStartVideoPokerRound({ isGuestMode, gate })) return;
  try { game.resetRound(); actionError = null; render(); } catch (error) { showActionError(error); }
}
```

Wager/hold listeners use the same caught-action pattern. `render()` shows `actionError` in `#video-poker-status` when non-null.

- [ ] **Step 8: Wire settlement Retry/Reset**

Use `ensureSettlementRecoveryControls()` and wire:

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

The retry path must not call `newSettlementId()`, `gate.settle()`, or rebuild the command.

- [ ] **Step 9: Add barrel exports**

`index.ts`:

```ts
export { VideoPokerGame } from './game';
export { evaluateHand } from './evaluator';
export { calculatePayout, PAYTABLE_ROWS, WAGER_OPTIONS } from './paytable';
export { initVideoPokerClient } from './client';
export type { Card, HandCategory, HandEvaluation, VideoPokerRoundResult, VideoPokerState } from './types';
```

- [ ] **Step 10: Run the Task 4 gate and commit**

```bash
bun test src/lib/video-poker src/lib/game-stats src/lib/profile-statistics-payload.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
git add src/lib/game-stats/constants.ts src/lib/game-stats/game-stats.test.ts src/lib/video-poker/client.ts src/lib/video-poker/client.test.ts src/lib/video-poker/index.ts
git commit -m "feat(video-poker): integrate wallet settlement"
```

Expected: PASS. Do not modify dynamic profile/statistics fixtures if this suite already passes.

---

## Task 5: Thin Astro route, lobby card, and one guest E2E

**Files:**
- Create: `src/pages/games/video-poker.astro`
- Modify: `src/pages/index.astro`
- Create: `e2e/video-poker.spec.ts`

- [ ] **Step 1: Write the failing guest flow**

`e2e/video-poker.spec.ts`:

```ts
import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('guest can Deal, hold a subset, Draw once, and start New Round locally', async ({ page }) => {
  const walletRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
  });
  await page.addInitScript(() => { Math.random = () => 0; });
  await page.goto('/games/video-poker', { waitUntil: 'domcontentloaded' });

  await expect(page.locator('#video-poker-root')).toHaveAttribute('data-guest-mode', 'true');
  await expect(page.locator('#chip-balance')).toContainText('1,000');
  await page.locator('[data-wager="2"]').click();
  await page.locator('#video-poker-action').click();
  await expect(page.locator('#video-poker-action')).toHaveText('Draw');

  const first = page.locator('[data-card-index="0"]');
  const third = page.locator('[data-card-index="2"]');
  const firstText = await first.textContent();
  const thirdText = await third.textContent();
  await first.click();
  await third.click();
  await page.locator('#video-poker-action').click();

  await expect(page.locator('#video-poker-action')).toHaveText('New Round');
  await expect(first).toHaveText(firstText ?? '');
  await expect(third).toHaveText(thirdText ?? '');
  await expect(page.locator('#video-poker-result')).not.toBeEmpty();
  await page.locator('#video-poker-action').click();
  await expect(page.locator('#video-poker-action')).toHaveText('Deal');
  expect(walletRequests).toEqual([]);
});
```

Run `bunx playwright test e2e/video-poker.spec.ts`; expected FAIL because the route does not exist.

- [ ] **Step 2: Create the complete thin Astro page**

`video-poker.astro`:

```astro
---
import CasinoLayout from '../../layouts/casino.astro';
import { createPublicGameSession } from '../../lib/public-game-session';
import { PAYTABLE_ROWS, WAGER_OPTIONS } from '../../lib/video-poker';

const gameSession = createPublicGameSession(Astro.locals.user);
---

<CasinoLayout title="Video Poker - Arcturus Casino">
  <main
    id="video-poker-root"
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
        <div id="chip-balance" class="text-2xl font-bold text-[var(--deco-brass)]">
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
          <button type="button" data-card-index={index} aria-pressed="false" class="deco-panel min-h-36 rounded-xl p-3">
            Card {index + 1}
          </button>
        ))}
      </div>
      <div id="video-poker-result" role="status" aria-live="polite" class="mt-4 min-h-6 text-center"></div>
      <div class="mt-5 flex flex-wrap justify-center gap-2">
        {WAGER_OPTIONS.map((wager) => (
          <button type="button" data-wager={wager} aria-pressed={wager === 1 ? 'true' : 'false'} class="deco-btn px-4 py-2 rounded-lg">
            {wager}
          </button>
        ))}
      </div>
      <div class="mt-5 flex justify-center">
        <button id="video-poker-action" type="button" class="deco-btn px-8 py-3 rounded-lg">Deal</button>
      </div>
      <div id="video-poker-recovery-host"></div>
    </section>

    <aside class="deco-panel mt-6 p-5">
      <h2 class="deco-section-title text-2xl">Paytable</h2>
      <div class="mt-3 grid gap-2">
        {PAYTABLE_ROWS.map(([label, payout]) => (
          <div class="flex justify-between gap-4"><span>{label}</span><span>{payout}</span></div>
        ))}
      </div>
    </aside>
  </main>
</CasinoLayout>

<script>
  import { initVideoPokerClient } from '../../lib/video-poker';
  initVideoPokerClient();
</script>
```

The page contains no ranking, payout, or wallet-request logic.

- [ ] **Step 3: Add the lobby entry**

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

Do not mark it featured.

- [ ] **Step 4: Run focused validation**

```bash
bunx playwright test e2e/video-poker.spec.ts
bun test src/lib/video-poker src/lib/game-stats src/lib/profile-statistics-payload.test.ts src/lib/profile-statistics-renderer.test.ts src/lib/profile-statistics-client.test.ts
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

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
grep -R "/api/wallet/settle\|fetch(" src/lib/video-poker/game.ts src/lib/video-poker/evaluator.ts src/lib/video-poker/cards.ts src/lib/video-poker/paytable.ts || true
```

Expected: no output.

## Completion Criteria

- Deal → hold subset → Draw once → New Round works.
- Held cards survive Draw and final hand has no duplicates.
- Evaluator covers all categories, wheel straight, suited wheel straight flush, low-pair rejection, and ace-pair qualification.
- Invalid/over-balance wagers are rejected; Deal disables when current wager exceeds current balance.
- Invalid DOM actions surface status text rather than throw out of the click handler.
- Guest mode remains local and performs no wallet request.
- Authenticated settlement adopts server balance, blocks New Round while unresolved, retries the exact pending command/ID, and Reset restores last confirmed server balance.
- `GAME_TYPES` consumer tests pass without unnecessary fixture churn.
- No shared-card extraction, generic game framework, new backend subsystem, or unrelated refactor is introduced.
