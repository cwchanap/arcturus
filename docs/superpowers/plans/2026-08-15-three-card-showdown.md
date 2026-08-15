# HPA-198 Three-Card Showdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused Three-Card Showdown game with Ante → Fold/Play gameplay, shared neutral card/deck primitives, guest-local bankrolls, and the existing authenticated wallet-settlement flow.

**Architecture:** Extract Video Poker's neutral 52-card type/deck helper into one `src/lib/cards.ts` shared primitive, then build a self-contained `src/lib/three-card-showdown` pure rules/state module. The Astro page/client composes existing card rendering, public-game session, wager validation, and wallet gate APIs; no new server route or persistence is introduced.

**Tech Stack:** Astro 5, TypeScript, Bun tests, Happy DOM, Playwright, existing Cloudflare Worker/D1 wallet APIs.

## Global Constraints

- Three-card hand order is `Straight Flush > Three of a Kind > Straight > Flush > Pair > High Card`.
- `A-K-Q` is the highest straight; `A-2-3` is the lowest; `K-A-2` is not a straight.
- Dealer qualifies with Queen-high or better.
- MVP has Ante + equal Play only: no Ante Bonus, Pair Plus, Hand Bonus, side bet, AI, ranked mode, history, or replay.
- `MIN_ANTE = 1`, `MAX_ANTE = 100`, `ANTE_OPTIONS = [1, 5, 10, 25, 50, 100]`.
- Deal is allowed only when `2 * ante <= balance`, so Play is always affordable after Deal.
- Guest play is local-only; authenticated Fold/Play submits exactly one net wallet settlement through the existing gate.
- No database migration, new API endpoint, automatic retry, persisted settlement queue, compatibility layer, generic poker evaluator, base game class, or Texas Hold'em refactor.

---

## File Structure

### Shared card primitive

- Create: `src/lib/cards.ts` — standard card types plus 52-card deck/shuffle helpers.
- Create: `src/lib/cards.test.ts` — moved/expanded deck tests.
- Delete: `src/lib/video-poker/cards.ts`.
- Delete: `src/lib/video-poker/cards.test.ts`.
- Modify: `src/lib/video-poker/types.ts` — import shared `Card` instead of defining card types.
- Modify: `src/lib/video-poker/game.ts` — import shared `createShuffledDeck`/`Card`.
- Modify: `src/lib/video-poker/client.ts` — import shared `Card` type.
- Modify: `src/lib/video-poker/index.ts` — stop re-exporting the old local `Card` alias.
- Modify any focused Video Poker tests importing the removed local card module/type.

### Three-Card Showdown module

- Create: `src/lib/three-card-showdown/types.ts` — game-only domain types.
- Create: `src/lib/three-card-showdown/rules.ts` — hand evaluation, comparison, qualification, payout resolution, Ante constants.
- Create: `src/lib/three-card-showdown/rules.test.ts`.
- Create: `src/lib/three-card-showdown/game.ts` — pure bankroll/deal/decision/reset state machine.
- Create: `src/lib/three-card-showdown/game.test.ts`.
- Create: `src/lib/three-card-showdown/client.ts` — DOM/session/wallet integration and settlement mapping.
- Create: `src/lib/three-card-showdown/client.test.ts`.
- Create: `src/lib/three-card-showdown/client.init.test.ts`.
- Create: `src/lib/three-card-showdown/index.ts` — narrow public exports.

### Product surface

- Create: `src/pages/games/three-card-showdown.astro`.
- Modify: `src/lib/game-stats/constants.ts`.
- Modify: `src/lib/game-stats/game-stats.test.ts` if it pins the game list/labels.
- Modify: `src/pages/index.astro` — add the lobby game card.
- Create: `e2e/three-card-showdown.spec.ts`.
- Modify: `e2e/profile-statistics.spec.ts` only where the registered game list is explicitly asserted.

---

### Task 1: Extract the neutral card/deck primitive without changing Video Poker behavior

**Files:**
- Create: `src/lib/cards.ts`
- Create: `src/lib/cards.test.ts`
- Delete: `src/lib/video-poker/cards.ts`
- Delete: `src/lib/video-poker/cards.test.ts`
- Modify: `src/lib/video-poker/types.ts`
- Modify: `src/lib/video-poker/game.ts`
- Modify: `src/lib/video-poker/client.ts`
- Modify: `src/lib/video-poker/index.ts`
- Test: `src/lib/cards.test.ts`
- Test: existing `src/lib/video-poker/*.test.ts`

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

- Consumed by: Video Poker and Task 2/3 Three-Card Showdown code.

- [ ] **Step 1: Create the shared deck test by moving the existing Video Poker behavior**

Create `src/lib/cards.test.ts` with focused assertions:

```ts
import { describe, expect, test } from 'bun:test';
import { createDeck, shuffleDeck } from './cards';

describe('shared cards', () => {
  test('creates all 52 unique cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map((card) => `${card.rank}-${card.suit}`)).size).toBe(52);
  });

  test('shuffle is injectable and does not mutate the source', () => {
    const deck = createDeck();
    const snapshot = deck.map((card) => ({ ...card }));
    const shuffled = shuffleDeck(deck, () => 0);

    expect(deck).toEqual(snapshot);
    expect(shuffled).toHaveLength(52);
    expect(shuffled).not.toEqual(deck);
  });
});
```

- [ ] **Step 2: Run the new test to verify the shared module does not exist yet**

Run:

```bash
bun test src/lib/cards.test.ts
```

Expected: FAIL because `src/lib/cards.ts` has not been created.

- [ ] **Step 3: Move the exact neutral Video Poker card/deck implementation into `src/lib/cards.ts`**

Use:

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

Do not add an RNG interface, shoe class, formatter, evaluator, or barrel.

- [ ] **Step 4: Point Video Poker at the shared primitive and delete the old local files**

Make these concrete import changes:

```ts
// src/lib/video-poker/types.ts
import type { Card } from '../cards';
```

Remove local `Suit`, `Rank`, and `Card` declarations from `video-poker/types.ts`.

```ts
// src/lib/video-poker/game.ts
import { createShuffledDeck, type Card } from '../cards';
```

```ts
// src/lib/video-poker/client.ts
import type { Card } from '../cards';
```

Remove `Card` from `src/lib/video-poker/index.ts`'s type exports. Update any tests that imported the deleted `./cards` path to import from `../cards`.

Delete:

```text
src/lib/video-poker/cards.ts
src/lib/video-poker/cards.test.ts
```

- [ ] **Step 5: Run shared-card and all Video Poker unit/DOM tests**

Run:

```bash
bun test src/lib/cards.test.ts src/lib/video-poker/
```

Expected: PASS with no Video Poker behavior changes.

- [ ] **Step 6: Commit the extraction**

```bash
git add src/lib/cards.ts src/lib/cards.test.ts src/lib/video-poker
git commit -m "refactor(cards): share neutral deck primitive"
```

---

### Task 2: Implement three-card evaluation, comparison, qualification, and payouts

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

- [ ] **Step 1: Define the game-domain types**

Create `types.ts` with:

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

- [ ] **Step 2: Write failing evaluator/ranking tests first**

Create `rules.test.ts` helpers and pin the unusual ordering:

```ts
const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ rank, suit });

expect(evaluateThreeCardHand([
  card(14, 'hearts'), card(13, 'hearts'), card(12, 'hearts'),
]).category).toBe('straight-flush');

expect(compareThreeCardHands(
  evaluateThreeCardHand([card(9, 'hearts'), card(8, 'clubs'), card(7, 'spades')]),
  evaluateThreeCardHand([card(14, 'diamonds'), card(9, 'diamonds'), card(4, 'diamonds')]),
)).toBe(1); // Straight beats Flush in three-card poker.

expect(evaluateThreeCardHand([
  card(14, 'hearts'), card(2, 'clubs'), card(3, 'spades'),
]).tieBreakers).toEqual([3]);
```

Also test Pair kicker comparison, suit-insensitive exact ties, and K-A-2 as High Card.

- [ ] **Step 3: Run rules tests and verify they fail**

```bash
bun test src/lib/three-card-showdown/rules.test.ts
```

Expected: FAIL because `rules.ts` is not implemented.

- [ ] **Step 4: Implement category strength and tie-break evaluation minimally**

Use a fixed local strength map:

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

Implementation rules:

- require exactly three cards;
- sort ranks descending;
- detect `A-2-3` and use straight high `3`;
- detect ordinary consecutive ranks with `r0 === r1 + 1 && r1 === r2 + 1`;
- detect flush by all suits equal;
- count duplicate ranks for Pair/Trips;
- return ordered `tieBreakers` as specified in the design.

Do not call the five-card Video Poker or Hold'em evaluators.

- [ ] **Step 5: Add dealer qualification tests**

Pin the boundary:

```ts
expect(dealerQualifies(evaluateThreeCardHand([
  card(12, 'hearts'), card(7, 'clubs'), card(2, 'spades'),
]))).toBe(true);

expect(dealerQualifies(evaluateThreeCardHand([
  card(11, 'hearts'), card(10, 'clubs'), card(8, 'spades'),
]))).toBe(false);
```

- [ ] **Step 6: Add payout-resolution tests for every Play outcome**

Use Ante `10` and assert:

```ts
expect(notQualified).toMatchObject({
  outcome: 'dealer-not-qualified',
  totalWager: 20,
  grossPayout: 30,
  netDelta: 10,
  dealerQualified: false,
});

expect(playerWin).toMatchObject({ grossPayout: 40, netDelta: 20 });
expect(tie).toMatchObject({ grossPayout: 20, netDelta: 0 });
expect(dealerWin).toMatchObject({ grossPayout: 0, netDelta: -20 });
```

- [ ] **Step 7: Implement `dealerQualifies()` and `resolvePlayedHand()`**

`dealerQualifies()` qualifies any Pair-or-better category or High Card with `tieBreakers[0] >= 12`.

`resolvePlayedHand()` evaluates both hands, compares only after checking qualification, and returns frozen copies in a new result object. It must not mutate either input hand.

- [ ] **Step 8: Run the full rules test**

```bash
bun test src/lib/three-card-showdown/rules.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit the pure rules**

```bash
git add src/lib/three-card-showdown/types.ts src/lib/three-card-showdown/rules.ts src/lib/three-card-showdown/rules.test.ts
git commit -m "feat(three-card-showdown): add hand rules"
```

---

### Task 3: Implement the pure Three-Card Showdown game lifecycle

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

- [ ] **Step 1: Write failing state-machine tests**

Cover the phase flow and bankroll contract:

```ts
const game = new ThreeCardShowdownGame(100, () => 0);
expect(game.getState()).toMatchObject({ phase: 'betting', balance: 100, ante: 1 });

game.setAnte(10);
game.deal();
expect(game.getState().phase).toBe('decision');
expect(game.getState().balance).toBe(90);
expect(game.getState().playerHand).toHaveLength(3);
expect(game.getState().dealerHand).toHaveLength(3);
expect(new Set([
  ...game.getState().playerHand,
  ...game.getState().dealerHand,
].map((card) => `${card.rank}-${card.suit}`)).size).toBe(6);
```

Add separate tests for Fold, Play, reset, invalid phase transitions, and authoritative `setBalance()`.

- [ ] **Step 2: Pin the two-Ante affordability rule**

```ts
const game = new ThreeCardShowdownGame(15);
expect(game.getAnteError(10)).toBe('Ante plus Play wager exceeds available balance');
expect(() => game.setAnte(10)).toThrow('Ante plus Play wager exceeds available balance');
```

Also test non-integer and 0/101 bounds.

- [ ] **Step 3: Run game tests and verify failure**

```bash
bun test src/lib/three-card-showdown/game.test.ts
```

Expected: FAIL because `game.ts` does not exist.

- [ ] **Step 4: Implement normalization, cloning, and Ante validation**

Use the same balance normalization contract as Video Poker:

```ts
function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new RangeError('Balance must be a non-negative finite number');
  }
  return Math.trunc(balance);
}
```

`getAnteError()` order:

1. whole-number check;
2. `validateBet(ante, MIN_ANTE, MAX_ANTE)`;
3. `ante * 2 > balance` → `Ante plus Play wager exceeds available balance`.

- [ ] **Step 5: Implement Deal**

`deal()` must:

- require `phase === 'betting'`;
- re-check `getAnteError(state.ante)`;
- create one shuffled deck through the injected random function;
- deal first three cards to the player and next three to dealer;
- subtract one Ante;
- enter `decision` with `result: null`.

No animation/timer state belongs in the pure game.

- [ ] **Step 6: Implement Fold**

`fold()` must:

- require `phase === 'decision'`;
- evaluate both already-dealt hands so the frozen result can render them consistently;
- set `{ outcome: 'fold', totalWager: ante, grossPayout: 0, netDelta: -ante, dealerQualified: dealerQualifies(...) }`;
- not deduct another wager;
- enter `complete`;
- return a deep-cloned result.

- [ ] **Step 7: Implement Play**

`play()` must:

- require `phase === 'decision'`;
- subtract the second equal Ante before payout credit;
- call `resolvePlayedHand()`;
- credit `result.grossPayout`;
- enter `complete` and return a cloned result.

Example accounting for Ante 10 / dealer-not-qualified:

```text
100 start -> 90 after Deal -> 80 after Play stake -> 110 after 30 gross payout
```

- [ ] **Step 8: Implement reset/adopt-balance behavior**

`resetRound()` requires `complete`, clears both hands/result, keeps the selected Ante, and returns to `betting`.

`setBalance()` updates only the balance through `normalizeBalance()`; the client uses it after authoritative wallet success or Reset recovery.

- [ ] **Step 9: Run Task 3 tests**

```bash
bun test src/lib/three-card-showdown/game.test.ts src/lib/three-card-showdown/rules.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit the pure lifecycle**

```bash
git add src/lib/three-card-showdown/game.ts src/lib/three-card-showdown/game.test.ts
git commit -m "feat(three-card-showdown): add pure game state"
```

---

### Task 4: Register the game and add the playable page/client using existing session/wallet/card seams

**Files:**
- Create: `src/lib/three-card-showdown/client.ts`
- Create: `src/lib/three-card-showdown/client.test.ts`
- Create: `src/lib/three-card-showdown/client.init.test.ts`
- Create: `src/lib/three-card-showdown/index.ts`
- Create: `src/pages/games/three-card-showdown.astro`
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.test.ts` if list assertions require it
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

- [ ] **Step 1: Register `three-card-showdown` in game statistics first**

Append to `GAME_TYPES` and both maps in `src/lib/game-stats/constants.ts`:

```ts
GAME_TYPES: 'three-card-showdown'
GAME_TYPE_LABELS['three-card-showdown'] = 'Three-Card Showdown'
GAME_TYPE_ICONS['three-card-showdown'] = '🂡'
```

If `game-stats.test.ts` pins the entire list/label/icon record, update only those expected values.

Run:

```bash
bun test src/lib/game-stats/
```

Expected: PASS.

- [ ] **Step 2: Write settlement-command mapping test before client code**

Create `client.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { buildThreeCardShowdownSettlementCommand } from './client';

describe('buildThreeCardShowdownSettlementCommand', () => {
  test('maps net result to one game-stat round', () => {
    expect(buildThreeCardShowdownSettlementCommand('three-card-1', { netDelta: -20 })).toEqual({
      settlementId: 'three-card-1',
      game: 'three-card-showdown',
      delta: -20,
      stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0 },
    });
  });
});
```

Add +20 and 0 cases for win and push semantics.

- [ ] **Step 3: Implement the game-local command builder**

Use exactly:

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

Do not add this mapping to `wallet`.

- [ ] **Step 4: Add the Astro page with six existing CardSlot instances**

Create `src/pages/games/three-card-showdown.astro` using `CasinoLayout` and `createPublicGameSession(Astro.locals.user)`.

Required stable IDs/data attributes:

```text
three-card-showdown-root
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
[data-ante]
```

Render:

- dealer row: three `CardSlot` components;
- player row: three `CardSlot` components;
- Ante buttons from `ANTE_OPTIONS`;
- Deal/Fold/Play/New Round buttons, with the client controlling visibility/disabled state;
- concise rules panel containing the hand order and Queen-high qualification.

No custom dynamic card HTML; use `CardSlot` only.

- [ ] **Step 5: Implement client initialization/session state**

Mirror the established Video Poker flow without extracting shared controller code:

```ts
const GAME_KEY = 'three-card-showdown';
const startingBalance = isGuestMode
  ? loadGuestBankroll(GAME_KEY, clientUserId, initialBalance)
  : initialBalance;
const game = new ThreeCardShowdownGame(startingBalance);
const gate = createSettlementGate();
let serverSyncedBalance = startingBalance;
```

Create a local `rankLabel()` for 11/12/13/14 → J/Q/K/A, then render cards via:

```ts
setSlotState(slot, 'card', { rank: rankLabel(card.rank), suit: card.suit });
```

Dealer state:

- `betting`: placeholder;
- `decision`: facedown;
- `complete`: card.

Player state:

- `betting`: placeholder;
- `decision`/`complete`: card.

- [ ] **Step 6: Wire phase actions with no extra controller abstraction**

Button behavior:

```text
betting: Deal visible; Fold/Play/New Round hidden
decision: Fold + Play visible; Deal/New Round hidden
complete: New Round visible; Deal/Fold/Play hidden
```

Deal calls `getAnteError()` then `deal()`.

Fold and Play both:

1. complete the pure game;
2. render the frozen result;
3. if guest, `persistGuestBankroll(GAME_KEY, clientUserId, balance)` and stop;
4. if authenticated, call `gate.settle(buildThreeCardShowdownSettlementCommand(newSettlementId('three-card-showdown'), round))`;
5. adopt returned authoritative balance.

New Round stays disabled while authenticated `gate.isBlocked`.

- [ ] **Step 7: Reuse wallet recovery controls exactly once**

Create controls through `ensureSettlementRecoveryControls()` with Three-Card-specific IDs:

```text
three-card-showdown-settlement-recovery
three-card-showdown-retry-settlement
three-card-showdown-reset-settlement
```

Retry:

- disables Retry and Reset while `gate.retry()` is in flight;
- adopts returned balance;
- keeps the same completed round until New Round.

Reset:

```ts
gate.reset();
game.setBalance(serverSyncedBalance);
if (game.getState().phase === 'complete') game.resetRound();
```

Then hide recovery and render betting state.

- [ ] **Step 8: Write focused Happy DOM tests**

`client.init.test.ts` should verify only client-specific composition:

1. guest Deal shows three player cards and three facedown dealer slots;
2. Fold reveals dealer, completes result, persists guest bankroll, sends no wallet request;
3. Play reveals dealer and updates displayed balance;
4. authenticated settlement failure shows recovery and disables New Round;
5. Retry reuses the exact command and authoritative returned balance updates both `#chip-balance` and `[data-chip-balance]`;
6. Reset restores the last server-synced balance and returns to betting.

Do not re-test settlement-gate internals already covered in `src/lib/wallet`.

Run:

```bash
bun test src/lib/three-card-showdown/client.test.ts src/lib/three-card-showdown/client.init.test.ts
```

Expected: PASS.

- [ ] **Step 9: Add the narrow public barrel**

`src/lib/three-card-showdown/index.ts` should export only:

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

- [ ] **Step 10: Add the lobby card**

Add one normal game card in `src/pages/index.astro` linking to `/games/three-card-showdown` with the `Three-Card Showdown` label. Follow adjacent Video Poker/Sic Bo markup; do not extract a lobby-card component as part of this ticket.

- [ ] **Step 11: Run Task 4 focused tests and build**

```bash
bun test src/lib/three-card-showdown/ src/lib/game-stats/
bun run build
```

Expected: PASS.

- [ ] **Step 12: Commit the playable feature surface**

```bash
git add src/lib/three-card-showdown src/pages/games/three-card-showdown.astro src/lib/game-stats src/pages/index.astro
git commit -m "feat(three-card-showdown): add playable game"
```

---

### Task 5: Add representative browser acceptance coverage and run full validation

**Files:**
- Create: `e2e/three-card-showdown.spec.ts`
- Modify: `e2e/profile-statistics.spec.ts` only if fixed expectations require the new game

**Interfaces:**
- Consumes the completed `/games/three-card-showdown` route and existing `createIsolatedPage()` E2E helper.
- Produces no runtime API.

- [ ] **Step 1: Add one deterministic guest Play E2E**

Use guest storage state and override `Math.random` before navigation.

The test must assert:

```text
- data-guest-mode="true"
- starting balance is visible
- choose an Ante
- Deal enters decision state
- exactly three player card slots show card and three dealer slots show facedown
- Play completes the round and reveals all dealer cards
- result text is non-empty and New Round is available
- no /api/wallet/settle request occurred
- New Round returns to Deal/betting state
```

Choose one deterministic random sequence and assert a concrete outcome/net delta after confirming it against the pure rules test. Do not assert shuffled card text without first pinning the same sequence in a unit fixture.

- [ ] **Step 2: Add one authenticated 503 → Retry recovery E2E**

Use `createIsolatedPage()` like Video Poker:

```ts
const commands: Array<Record<string, unknown>> = [];
await page.route('**/api/wallet/settle', async (route) => {
  const command = route.request().postDataJSON() as Record<string, unknown>;
  commands.push(command);
  if (commands.length === 1) {
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'offline' }) });
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

Assert:

- completed Play causes one command;
- recovery appears after the 503;
- New Round is disabled;
- Retry produces a second request exactly equal to the first command;
- recovery hides and New Round enables;
- both local and shared header balances adopt `startingBalance + delta`.

- [ ] **Step 3: Extend profile statistics coverage only if the current test enumerates every game**

If `e2e/profile-statistics.spec.ts` has an exact game-label/icon list, add `Three-Card Showdown`. Do not add a separate profile E2E solely for this game if the existing generic registration assertion already covers it.

- [ ] **Step 4: Run the new and adjacent E2E files serially**

```bash
bunx playwright test e2e/three-card-showdown.spec.ts e2e/video-poker.spec.ts e2e/profile-statistics.spec.ts --workers=1
```

Expected: all selected tests pass.

- [ ] **Step 5: Run the complete unit/integration suite**

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

- [ ] **Step 7: Run the full Playwright suite serially before merge**

```bash
bunx playwright test --workers=1
```

Expected: PASS except only repository-documented intentionally skipped tests.

- [ ] **Step 8: Verify scope did not expand**

Inspect the final diff and confirm all of the following:

```text
- no schema/migration files changed
- no new API route exists
- src/lib/poker/** is untouched
- no generic evaluator/base game/client controller was added
- only shared card/deck primitives moved out of Video Poker
- no side bet/bonus/AI/ranked/history/replay code exists
```

If any of these are false, simplify before merge.

- [ ] **Step 9: Commit acceptance coverage**

```bash
git add e2e/three-card-showdown.spec.ts e2e/profile-statistics.spec.ts
git commit -m "test(three-card-showdown): cover guest and wallet flows"
```

---

## Final Review Checklist

Before marking HPA-198 complete:

- [ ] Shared `cards.ts` has exactly two active clean consumers: Video Poker and Three-Card Showdown.
- [ ] Texas Hold'em Poker was not refactored.
- [ ] Straight beats Flush in all evaluator/comparison paths.
- [ ] Dealer Q-high boundary is pinned by tests.
- [ ] A player can never Deal an Ante that makes the equal Play wager unaffordable.
- [ ] Fold loses one Ante; Play outcomes account for both wagers exactly once.
- [ ] There is no Ante Bonus or side-bet payout hidden in `resolvePlayedHand()`.
- [ ] Guest completion never calls `/api/wallet/settle`.
- [ ] Authenticated completion creates one settlement command; Retry reuses it unchanged.
- [ ] New Round is blocked while settlement is pending/failed.
- [ ] Wallet Reset restores the last authoritative server balance and clears the completed hand.
- [ ] Game registration appears in the lobby/statistics surfaces that enumerate game types.
- [ ] `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`, and serial Playwright validation pass.
