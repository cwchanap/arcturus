# HPA-198 Three-Card Showdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one focused Three-Card Showdown game with Ante → Fold/Play gameplay while extracting only the two shared seams now proven by multiple concrete consumers: the neutral 52-card primitive and the public-game net-round settlement/recovery composition.

**Architecture:** `src/lib/cards.ts` becomes the canonical card/deck primitive for Video Poker and Three-Card Showdown only. `src/lib/wallet/public-game-settlement.ts` owns simple public-game session parsing, guest bankroll persistence, one-sign-derived round command, shared balance surfaces, settlement gate/recovery, authoritative balance adoption, and achievement forwarding; Video Poker and Sic Bo migrate to it before Three-Card Showdown uses it. Three-Card rules, state, phases, DOM rendering, and result copy remain local.

**Tech Stack:** Astro 5, TypeScript, Bun tests, Happy DOM, Playwright, existing Cloudflare Worker/D1 wallet API.

## Global Constraints

- Hand order: `Straight Flush > Three of a Kind > Straight > Flush > Pair > High Card`.
- `A-K-Q` is highest straight; `A-2-3` is lowest; `K-A-2` is not a straight.
- Dealer qualifies with Queen-high or better.
- MVP has Ante + equal Play only. No Ante Bonus, Pair Plus, Hand Bonus, other side bet, AI, ranked mode, history, or replay.
- `MIN_ANTE = 1`, `MAX_ANTE = 100`, `ANTE_OPTIONS = [1, 5, 10, 25, 50, 100]`.
- Initial Ante is exactly `ANTE_OPTIONS[0]` (`1`).
- Deal requires `2 * ante <= balance`, so Play is always affordable after Deal.
- Guest completion is local-only. Authenticated Fold/Play produces exactly one net wallet settlement.
- Register exact game key `three-card-showdown`, label `Three-Card Showdown`, icon `♠️`; it becomes `GAME_TYPES` entry 10.
- No schema migration, API endpoint, automatic retry, persisted queue, generic poker evaluator, base game class, paytable engine, generic game client controller, or Poker/Blackjack card refactor.
- The new public-game settlement controller may know wallet/session/recovery mechanics only; it must not learn game phases, wager rules, cards/dice, action buttons, or result rendering.

---

## Task 1: Move the neutral card/deck primitive and update Video Poker directly

**Files:**
- Move: `src/lib/video-poker/cards.ts` → `src/lib/cards.ts`
- Move: `src/lib/video-poker/cards.test.ts` → `src/lib/cards.test.ts`
- Modify: `src/lib/video-poker/types.ts`
- Modify: `src/lib/video-poker/evaluator.ts`
- Modify: `src/lib/video-poker/evaluator.test.ts`
- Modify: `src/lib/video-poker/game.ts`
- Modify: `src/lib/video-poker/client.ts`
- Modify: `src/lib/video-poker/index.ts`
- Modify only if grep proves necessary: other `src/lib/video-poker/*.test.ts`

**Interfaces:**

`src/lib/cards.ts` remains the exact small primitive:

```ts
export type Suit = 'hearts' | 'diamonds' | 'clubs' | 'spades';
export type Rank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;

export interface Card {
  rank: Rank;
  suit: Suit;
}

export function createDeck(): Card[];
export function shuffleDeck(deck: readonly Card[], random?: () => number): Card[];
export function createShuffledDeck(random?: () => number): Card[];
```

- [ ] **Step 1: Move the existing implementation and tests instead of recreating them**

```bash
git mv src/lib/video-poker/cards.ts src/lib/cards.ts
git mv src/lib/video-poker/cards.test.ts src/lib/cards.test.ts
```

In the moved test, change:

```ts
import { createDeck, shuffleDeck } from './cards';
import type { Card } from './cards';
```

Rename the suite from `video poker cards` to `shared cards`.

- [ ] **Step 2: Add the one new deterministic fixture assertion**

Add to `src/lib/cards.test.ts`:

```ts
test('constant-zero Fisher-Yates pins the first six cards', () => {
  expect(shuffleDeck(createDeck(), () => 0).slice(0, 6)).toEqual([
    { rank: 3, suit: 'hearts' },
    { rank: 4, suit: 'hearts' },
    { rank: 5, suit: 'hearts' },
    { rank: 6, suit: 'hearts' },
    { rank: 7, suit: 'hearts' },
    { rank: 8, suit: 'hearts' },
  ]);
});
```

Keep the existing 52-card uniqueness and non-mutating shuffle tests.

- [ ] **Step 3: Make `src/lib/cards.ts` the only canonical card import path**

`src/lib/video-poker/types.ts` uses the shared type internally but re-exports nothing card-shaped:

```ts
import type { Card } from '../cards';
```

Update direct users:

```ts
// evaluator.ts / evaluator.test.ts
import type { Card, Rank, Suit } from '../cards';

// game.ts
import { createShuffledDeck, type Card } from '../cards';

// client.ts
import type { Card } from '../cards';
```

Remove `Card` from `src/lib/video-poker/index.ts`'s type exports. Do not preserve a second `video-poker` import path for `Card`/`Rank`/`Suit`; there are no external consumers to support.

- [ ] **Step 4: Verify only the intended card primitive moved**

```bash
git grep -n "video-poker/cards\|from './cards'" -- src/lib/video-poker src/pages e2e
```

Expected: no imports of the deleted local file.

```bash
git diff -- src/lib/poker src/lib/blackjack
```

Expected: empty.

- [ ] **Step 5: Run the moved and adjacent tests**

```bash
bun test src/lib/cards.test.ts src/lib/video-poker/
```

Expected: PASS.

- [ ] **Step 6: Commit the extraction**

```bash
git add src/lib/cards.ts src/lib/cards.test.ts src/lib/video-poker
git commit -m "refactor(cards): share neutral deck primitive"
```

---

## Task 2: Extract the public-game net-round settlement controller and migrate Video Poker + Sic Bo

**Files:**
- Create: `src/lib/wallet/public-game-settlement.ts`
- Create: `src/lib/wallet/public-game-settlement.test.ts`
- Modify: `src/lib/wallet/index.ts`
- Modify: `src/lib/video-poker/client.ts`
- Modify: `src/lib/video-poker/client.test.ts`
- Modify: `src/lib/video-poker/client.init.test.ts`
- Modify: `src/lib/sic-bo/client.ts`
- Modify: `src/lib/sic-bo/client.test.ts`
- Modify: `src/lib/sic-bo/client.init.test.ts`

**Interfaces:**

```ts
import type { GameType } from '../game-stats/types';
import type { SettleRoundCommand } from './types';

export function buildRoundSettlementCommand(
  game: GameType,
  settlementId: string,
  netDelta: number,
): SettleRoundCommand;

export type PublicGameSettlementMessages = {
  failed: string;
  retrying: string;
  retryFailed: string;
};

export interface PublicGameSettlementController {
  readonly isGuestMode: boolean;
  readonly clientUserId: string;
  readonly startingBalance: number;
  readonly isBlocked: boolean;
  readonly statusMessage: string | null;
  syncBalance(balance: number): void;
  completeRound(netDelta: number, localBalance: number): Promise<void>;
}

export function createPublicGameSettlementController(options: {
  gameKey: GameType;
  root: HTMLElement;
  recoveryHost: HTMLElement | null;
  resetLabel: string;
  messages: PublicGameSettlementMessages;
  render: () => void;
  onAdoptBalance: (balance: number) => void;
  onResetRound: () => void;
}): PublicGameSettlementController;
```

- [ ] **Step 1: Write the pure command-helper tests**

Create `src/lib/wallet/public-game-settlement.test.ts` with:

```ts
test.each([
  [-10, { wins: 0, losses: 1, biggestWin: 0 }],
  [0, { wins: 0, losses: 0, biggestWin: 0 }],
  [25, { wins: 1, losses: 0, biggestWin: 25 }],
] as const)('builds one net round for %i', (netDelta, stats) => {
  expect(buildRoundSettlementCommand('video-poker', 'round-1', netDelta)).toEqual({
    settlementId: 'round-1',
    game: 'video-poker',
    delta: netDelta,
    stats: { rounds: 1, ...stats },
  });
});
```

Run:

```bash
bun test src/lib/wallet/public-game-settlement.test.ts
```

Expected: FAIL because the shared module does not exist.

- [ ] **Step 2: Implement the pure helper**

```ts
export function buildRoundSettlementCommand(
  game: GameType,
  settlementId: string,
  netDelta: number,
): SettleRoundCommand {
  return {
    settlementId,
    game,
    delta: netDelta,
    stats: {
      rounds: 1,
      wins: netDelta > 0 ? 1 : 0,
      losses: netDelta < 0 ? 1 : 0,
      biggestWin: Math.max(netDelta, 0),
    },
  };
}
```

Do not add options for alternate stats semantics. Games that do not match this exact contract do not use this helper.

- [ ] **Step 3: Add controller tests for the proven shared behavior**

Use Happy DOM and the real wallet fetch path. Build a root with:

```ts
root.dataset.userId = 'anonymous';
root.dataset.guestMode = 'true';
root.dataset.initialBalance = '1000';
```

Cover these behaviors in this one shared suite:

```text
guest root -> startingBalance uses persisted bankroll when present
syncBalance(990) -> #chip-balance = "990" and [data-chip-balance] = "990 chips"
guest completeRound(-10, 990) -> localStorage stores 990; fetch count remains 0
auth success -> exact sign-derived command, onAdoptBalance(server balance), achievement-earned dispatch
auth failure -> statusMessage = failed, recovery visible, isBlocked = true
Retry -> same command body, Retry+Reset disabled while in flight, returned balance adopted
Reset -> gate cleared, last server balance adopted, onResetRound called, recovery hidden
```

For the exact-command Retry assertion, capture both request bodies and assert:

```ts
expect(commands).toHaveLength(2);
expect(commands[1]).toEqual(commands[0]);
```

- [ ] **Step 4: Implement session resolution and balance synchronization**

Use existing helpers rather than duplicating storage semantics:

```ts
const clientUserId = options.root.dataset.userId ?? 'anonymous';
const isGuestMode = isGuestModeValue(options.root.dataset.guestMode ?? 'false');
const initialBalance = Number(options.root.dataset.initialBalance ?? '1000');
const startingBalance = isGuestMode
  ? loadGuestBankroll(options.gameKey, clientUserId, initialBalance)
  : initialBalance;
```

`syncBalance(balance)` must use one implementation:

```ts
const formatted = balance.toLocaleString('en-US');
const primary = document.getElementById('chip-balance');
if (primary) primary.textContent = formatted;
document.querySelectorAll<HTMLElement>('[data-chip-balance]').forEach((el) => {
  el.textContent = `${formatted} chips`;
});
```

This is the shared fix for the stale-header drift that previously appeared separately in Video Poker and Sic Bo.

- [ ] **Step 5: Implement recovery/adoption inside the controller**

Create one `createSettlementGate()` and one `serverSyncedBalance = startingBalance`.

Create controls with existing `ensureSettlementRecoveryControls()` using IDs derived only from `gameKey`:

```ts
containerId: `${gameKey}-settlement-recovery`
retryId: `${gameKey}-retry-settlement`
resetId: `${gameKey}-reset-settlement`
containerClass: 'hidden mt-4 flex flex-wrap justify-center gap-3'
retryLabel: 'Retry settlement'
resetLabel: options.resetLabel
retryClass: 'deco-btn px-4 py-2 rounded-lg'
resetClass: 'deco-btn px-4 py-2 rounded-lg'
```

Adoption is exactly:

```ts
function adopt(result: SettleRoundResult): void {
  serverSyncedBalance = result.balance;
  options.onAdoptBalance(result.balance);
  statusMessage = null;
  recovery.container?.classList.add('hidden');
  if (result.newAchievements?.length) {
    window.dispatchEvent(
      new CustomEvent('achievement-earned', {
        detail: { achievements: result.newAchievements },
      }),
    );
  }
}
```

Retry must disable both recovery buttons until the request settles.

Reset must:

```ts
gate.reset();
options.onAdoptBalance(serverSyncedBalance);
options.onResetRound();
statusMessage = null;
recovery.container?.classList.add('hidden');
options.render();
```

- [ ] **Step 6: Implement `completeRound()` without absorbing game logic**

```ts
async function completeRound(netDelta: number, localBalance: number): Promise<void> {
  if (isGuestMode) {
    persistGuestBankroll(options.gameKey, clientUserId, localBalance);
    return;
  }

  try {
    const pending = gate.settle(
      buildRoundSettlementCommand(
        options.gameKey,
        newSettlementId(options.gameKey),
        netDelta,
      ),
    );
    options.render();
    adopt(await pending);
  } catch (error) {
    console.error(`[WALLET_SETTLEMENT] ${options.gameKey} settlement failed:`, error);
    statusMessage = options.messages.failed;
    recovery.container?.classList.remove('hidden');
  }
  options.render();
}
```

Do not pass round objects, phases, or game actions into this module.

- [ ] **Step 7: Export only the focused shared API**

Add to `src/lib/wallet/index.ts`:

```ts
export {
  buildRoundSettlementCommand,
  createPublicGameSettlementController,
  type PublicGameSettlementController,
  type PublicGameSettlementMessages,
} from './public-game-settlement';
```

- [ ] **Step 8: Migrate Video Poker without changing Video Poker gameplay**

Remove:

```text
buildVideoPokerSettlementCommand
manual root dataset -> guest bankroll -> gate setup
manual [data-chip-balance] loop
manual recovery creation/show/hide/adopt/retry/reset
manual guest persistence/auth command construction
```

Keep local:

```text
card rendering
wager validation/buttons
Deal/Hold/Draw/New Round phases
Video Poker status/result copy
```

Use construction order:

```ts
let game: VideoPokerGame;
let settlement: PublicGameSettlementController;

function render(): void {
  const state = game.getState();
  settlement.syncBalance(state.balance);
  // existing Video Poker rendering...
}

settlement = createPublicGameSettlementController({
  gameKey: 'video-poker',
  root,
  recoveryHost,
  resetLabel: 'Reset hand',
  messages: {
    failed: 'Settlement failed. Retry or reset before starting another hand.',
    retrying: 'Retrying settlement...',
    retryFailed: 'Settlement failed again. Retry or reset the hand.',
  },
  render,
  onAdoptBalance: (balance) => game.setBalance(balance),
  onResetRound: () => {
    if (game.getState().phase === 'complete') game.resetRound();
    wagerMessage = null;
  },
});
game = new VideoPokerGame(settlement.startingBalance);
```

On completed Draw:

```ts
await settlement.completeRound(round.netDelta, game.getState().balance);
```

Use `settlement.isBlocked` and `settlement.statusMessage` from render. Do not re-create wallet logic locally.

- [ ] **Step 9: Migrate Sic Bo the same way**

Keep bet-slip, dice, phase, and result rendering local. Use:

```ts
gameKey: 'sic-bo'
resetLabel: 'Reset round'
failed: 'Settlement failed. Retry or reset before rolling again.'
retrying: 'Retrying settlement...'
retryFailed: 'Settlement failed again. Retry or reset before rolling again.'
```

On completed Roll:

```ts
await settlement.completeRound(result.netDelta, game.getState().balance);
```

- [ ] **Step 10: Collapse duplicated settlement tests, keep game-specific composition tests**

Delete Video Poker/Sic Bo tests whose only subject is the gate/retry/reset/achievement implementation now covered by `public-game-settlement.test.ts`.

Keep game-specific tests that prove each client:

```text
constructs against settlement.startingBalance
calls completeRound after its own terminal action
blocks New Round/Roll when settlement.isBlocked
renders its own failure/status copy through settlement.statusMessage
```

Do not remove their gameplay/DOM tests.

- [ ] **Step 11: Run high-risk migration validation**

```bash
bun run test
bunx playwright test e2e/video-poker.spec.ts e2e/sic-bo.spec.ts --workers=1
bun run lint
bun run build
```

Expected: PASS.

- [ ] **Step 12: Commit the shared settlement seam**

```bash
git add src/lib/wallet src/lib/video-poker src/lib/sic-bo
git commit -m "refactor(wallet): share public game settlement flow"
```

---

## Task 3: Implement Three-Card ranking, comparison, dealer qualification, and Play payouts

**Files:**
- Create: `src/lib/three-card-showdown/types.ts`
- Create: `src/lib/three-card-showdown/rules.ts`
- Create: `src/lib/three-card-showdown/rules.test.ts`

**Interfaces:**

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

export function evaluateThreeCardHand(cards: readonly Card[]): ThreeCardHandEvaluation;
export function compareThreeCardHands(
  left: ThreeCardHandEvaluation,
  right: ThreeCardHandEvaluation,
): -1 | 0 | 1;
export function dealerQualifies(evaluation: ThreeCardHandEvaluation): boolean;
export function resolvePlayedHand(
  playerCards: readonly Card[],
  dealerCards: readonly Card[],
  ante: number,
): ThreeCardShowdownRoundResult;
```

- [ ] **Step 1: Define the domain result/state types**

`ThreeCardShowdownRoundResult` stores:

```ts
outcome: 'fold' | 'dealer-not-qualified' | 'player-win' | 'tie' | 'dealer-win';
ante: number;
totalWager: number;
grossPayout: number;
netDelta: number;
dealerQualified: boolean;
playerHand: readonly Card[];
dealerHand: readonly Card[];
playerEvaluation: ThreeCardHandEvaluation;
dealerEvaluation: ThreeCardHandEvaluation;
```

`ThreeCardShowdownState` stores:

```ts
phase: 'betting' | 'decision' | 'complete';
balance: number;
ante: number;
playerHand: readonly Card[];
dealerHand: readonly Card[];
result: ThreeCardShowdownRoundResult | null;
```

- [ ] **Step 2: Write failing ranking tests**

Use helper:

```ts
const c = (rank: Rank, suit: Suit): Card => ({ rank, suit });
```

Pin all category precedence, especially:

```ts
expect(compareThreeCardHands(
  evaluateThreeCardHand([c(4, 'hearts'), c(5, 'clubs'), c(6, 'spades')]),
  evaluateThreeCardHand([c(14, 'hearts'), c(10, 'hearts'), c(8, 'hearts')]),
)).toBe(1); // Straight beats Flush
```

Also pin:

```text
A-K-Q highest straight
A-2-3 straightHigh = 3
K-A-2 is High Card
pair compares pair rank then kicker
flush/high-card compare lexicographically
same ranks with different suits tie
```

Run:

```bash
bun test src/lib/three-card-showdown/rules.test.ts
```

Expected: FAIL because rules are not implemented.

- [ ] **Step 3: Implement explicit category weights and tie breakers**

Use one local table:

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

No configurable evaluator or five-card reuse.

- [ ] **Step 4: Write and implement dealer qualification tests**

Pin:

```ts
expect(dealerQualifies(evaluateThreeCardHand([
  c(12, 'hearts'), c(9, 'clubs'), c(2, 'spades'),
]))).toBe(true);

expect(dealerQualifies(evaluateThreeCardHand([
  c(11, 'hearts'), c(10, 'clubs'), c(8, 'spades'),
]))).toBe(false);
```

Every Pair-or-better evaluation qualifies.

- [ ] **Step 5: Write and implement the four Play payout outcomes**

For Ante 10 pin:

```text
dealer-not-qualified -> totalWager 20, grossPayout 30, netDelta +10
player-win           -> totalWager 20, grossPayout 40, netDelta +20
tie                  -> totalWager 20, grossPayout 20, netDelta 0
dealer-win           -> totalWager 20, grossPayout 0,  netDelta -20
```

`resolvePlayedHand()` evaluates both hands exactly once and returns frozen round data; it does not touch balance or wallet state.

- [ ] **Step 6: Run and commit pure rules**

```bash
bun test src/lib/three-card-showdown/rules.test.ts
```

Expected: PASS.

```bash
git add src/lib/three-card-showdown/types.ts src/lib/three-card-showdown/rules.ts src/lib/three-card-showdown/rules.test.ts
git commit -m "feat(three-card-showdown): add pure rules"
```

---

## Task 4: Implement the pure Three-Card game lifecycle and explicit Ante contract

**Files:**
- Create: `src/lib/three-card-showdown/game.ts`
- Create: `src/lib/three-card-showdown/game.test.ts`

**Interfaces:**

```ts
export const MIN_ANTE = 1;
export const MAX_ANTE = 100;
export const ANTE_OPTIONS = [1, 5, 10, 25, 50, 100] as const;

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

- [ ] **Step 1: Write the failing initial/default-Ante and affordability tests**

```ts
const game = new ThreeCardShowdownGame(100);
expect(game.getState().ante).toBe(1);

const short = new ThreeCardShowdownGame(15);
expect(short.getAnteError(10)).toBe('Ante plus Play wager exceeds available balance');
expect(() => short.setAnte(10)).toThrow('Ante plus Play wager exceeds available balance');
```

Also pin non-integer, 0, and 101.

- [ ] **Step 2: Implement normalization and Ante validation**

```ts
function normalizeBalance(balance: number): number {
  if (!Number.isFinite(balance) || balance < 0) {
    throw new RangeError('Balance must be a non-negative finite number');
  }
  return Math.trunc(balance);
}
```

Initial state:

```ts
{
  phase: 'betting',
  balance: normalizeBalance(initialBalance),
  ante: ANTE_OPTIONS[0],
  playerHand: [],
  dealerHand: [],
  result: null,
}
```

`getAnteError()` order:

```text
not integer -> "Ante must be a whole number of chips"
validateBet(ante, MIN_ANTE, MAX_ANTE)
ante * 2 > balance -> "Ante plus Play wager exceeds available balance"
```

`setAnte()` requires `phase === 'betting'` and throws the exact returned validation message.

- [ ] **Step 3: Write the deterministic Deal test**

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

Also assert six unique cards.

- [ ] **Step 4: Implement Deal**

`deal()` must:

```text
require betting
re-check selected Ante
create one shuffled deck using injected random
player = first 3; dealer = next 3
subtract one Ante
enter decision
```

No UI/reveal state belongs here.

- [ ] **Step 5: Write Fold and Play accounting tests**

Fold:

```ts
const foldGame = new ThreeCardShowdownGame(100, () => 0);
foldGame.setAnte(10);
foldGame.deal();
const folded = foldGame.fold();
expect(folded).toMatchObject({
  outcome: 'fold',
  totalWager: 10,
  grossPayout: 0,
  netDelta: -10,
});
expect(foldGame.getState().balance).toBe(90);
```

Play with constant-zero shuffle:

```ts
const playGame = new ThreeCardShowdownGame(100, () => 0);
playGame.setAnte(10);
playGame.deal();
const played = playGame.play();
expect(played.outcome).toBe('dealer-win');
expect(played.netDelta).toBe(-20);
expect(playGame.getState().balance).toBe(80);
```

Add one dealer-not-qualified fixture to prove the gross payout is credited after the second wager.

- [ ] **Step 6: Implement Fold/Play and immutable result snapshots**

`fold()` evaluates the already-dealt hands, deducts no second wager, and enters `complete`.

`play()` deducts the second equal wager, calls `resolvePlayedHand()`, credits `grossPayout`, and enters `complete`.

Deep-clone hands/evaluations/results from `getState()` and returned round results so client code cannot mutate game state through aliases.

- [ ] **Step 7: Implement reset and authoritative balance adoption**

`resetRound()` requires `complete`, clears hands/result, keeps the selected Ante, and returns to `betting`.

`setBalance()` updates balance only through `normalizeBalance()`.

- [ ] **Step 8: Run and commit pure game state**

```bash
bun test src/lib/three-card-showdown/game.test.ts src/lib/three-card-showdown/rules.test.ts
```

Expected: PASS.

```bash
git add src/lib/three-card-showdown/game.ts src/lib/three-card-showdown/game.test.ts
git commit -m "feat(three-card-showdown): add pure game state"
```

---

## Task 5: Register the game and ship the real page/client with guest E2E in the same slice

**Files:**
- Create: `src/lib/three-card-showdown/client.ts`
- Create: `src/lib/three-card-showdown/index.ts`
- Create: `src/pages/games/three-card-showdown.astro`
- Create: `e2e/three-card-showdown.spec.ts`
- Modify: `src/lib/game-stats/constants.ts`
- Modify: `src/lib/game-stats/game-stats.test.ts`
- Modify: `src/pages/index.astro`

**Interfaces:**

The Three-Card client imports `createPublicGameSettlementController`; it does **not** define a settlement-command builder, guest-bankroll code, recovery handlers, header-balance loop, or achievement forwarding.

- [ ] **Step 1: Register the tenth game and update only meaningful registry tests**

Append `three-card-showdown` to `GAME_TYPES` and add required typed record entries:

```ts
GAME_TYPE_LABELS['three-card-showdown'] = 'Three-Card Showdown';
GAME_TYPE_ICONS['three-card-showdown'] = '♠️';
```

In `game-stats.test.ts`, update the real tripwires:

```ts
expect(GAME_TYPES).toContain('three-card-showdown');
expect(GAME_TYPES.length).toBe(10);
expect(isValidGameType('three-card-showdown')).toBe(true);
```

Do not add a redundant exact label/icon unit assertion; TypeScript's `Record<GameType, string>` maps plus build require both entries.

Run:

```bash
bun test src/lib/game-stats/game-stats.test.ts
```

Expected: PASS.

- [ ] **Step 2: Create the Astro page with the exact public-game root contract**

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

Required IDs:

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

Use six existing `CardSlot`s. Ante buttons use `[data-ante]` generated from `ANTE_OPTIONS`.

- [ ] **Step 3: Create the narrow public barrel**

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

Do not export shared `Card` through this barrel.

- [ ] **Step 4: Build the client around the shared settlement controller**

Use local variables:

```ts
let game: ThreeCardShowdownGame;
let settlement: PublicGameSettlementController;
let anteMessage: string | null = null;
```

Render uses:

```ts
const state = game.getState();
settlement.syncBalance(state.balance);
```

Dealer slots:

```text
betting -> placeholder
decision -> facedown
complete -> card
```

Player slots:

```text
betting -> placeholder
decision/complete -> card
```

Phase actions:

```text
betting  -> Deal
decision -> Fold + Play
complete -> New Round
```

Status priority:

```text
settlement.statusMessage
anteMessage
phase-default copy
```

New Round is disabled when `settlement.isBlocked`.

- [ ] **Step 5: Create the shared settlement controller with game callbacks only**

```ts
settlement = createPublicGameSettlementController({
  gameKey: 'three-card-showdown',
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
    anteMessage = null;
  },
});

game = new ThreeCardShowdownGame(settlement.startingBalance);
```

The callbacks contain no wallet logic.

- [ ] **Step 6: Wire Ante buttons with the explicit non-throwing UI guard**

```ts
button.addEventListener('click', () => {
  if (game.getState().phase !== 'betting') return;
  const ante = Number(button.dataset.ante);
  const error = game.getAnteError(ante);
  if (error) {
    anteMessage = error;
    render();
    return;
  }
  game.setAnte(ante);
  anteMessage = null;
  render();
});
```

Do not call `setAnte()` unchecked from DOM input.

- [ ] **Step 7: Wire Deal/Fold/Play/New Round without copying settlement code**

Deal:

```ts
const error = game.getAnteError(game.getState().ante);
if (error) {
  anteMessage = error;
  render();
  return;
}
game.deal();
anteMessage = null;
render();
```

Fold/Play helper:

```ts
async function completeDecision(action: 'fold' | 'play'): Promise<void> {
  const round = action === 'fold' ? game.fold() : game.play();
  render(); // reveal dealer and show local result immediately
  await settlement.completeRound(round.netDelta, game.getState().balance);
  render();
}
```

New Round:

```ts
if (settlement.isBlocked) return;
game.resetRound();
anteMessage = null;
render();
```

Result strings stay local:

```ts
fold                 -> `Fold · -${result.ante} net`
dealer-not-qualified -> `Dealer does not qualify · +${result.ante} net`
player-win           -> `Player wins · +${result.netDelta} net`
tie                  -> `Tie · 0 net`
dealer-win           -> `Dealer wins · ${result.netDelta} net`
```

- [ ] **Step 8: Add one normal lobby card**

Modify `src/pages/index.astro` at the existing game-card list:

```text
Three-Card Showdown
/games/three-card-showdown
♠️
```

Do not extract a lobby component.

- [ ] **Step 9: Add the deterministic guest E2E now, before this slice is complete**

In `e2e/three-card-showdown.spec.ts` use guest storage state and:

```ts
await page.addInitScript(() => {
  Math.random = () => 0;
});
```

Before Deal:

```ts
await expect(page.getByTestId('three-card-showdown-root'))
  .toHaveAttribute('data-guest-mode', 'true');
await expect(page.getByTestId('chip-balance')).toContainText('1,000');
```

Select Ante 10 and Deal:

```ts
await expect(page.getByTestId('chip-balance')).toContainText('990');
await expect(page.locator('[id^="three-card-showdown-player-slot-"][data-slot-state="card"]'))
  .toHaveCount(3);
await expect(page.locator('[id^="three-card-showdown-dealer-slot-"][data-slot-state="facedown"]'))
  .toHaveCount(3);
```

Click Play. Constant-zero shuffle produces player `3♥4♥5♥` and dealer `6♥7♥8♥`:

```ts
await expect(page.locator('#three-card-showdown-result'))
  .toHaveText('Dealer wins · -20 net');
await expect(page.getByTestId('chip-balance')).toContainText('980');
await expect(page.locator('[id^="three-card-showdown-dealer-slot-"][data-slot-state="card"]'))
  .toHaveCount(3);
expect(walletRequests).toEqual([]);
```

This E2E is the page↔client ID/dataset contract test. Do not postpone it to the final coverage task.

- [ ] **Step 10: Run slice validation and commit**

```bash
bun test src/lib/three-card-showdown/rules.test.ts src/lib/three-card-showdown/game.test.ts src/lib/game-stats/game-stats.test.ts
bunx playwright test e2e/three-card-showdown.spec.ts --workers=1
bun run build
```

Expected: PASS.

```bash
git add src/lib/three-card-showdown src/lib/game-stats src/pages/games/three-card-showdown.astro src/pages/index.astro e2e/three-card-showdown.spec.ts
git commit -m "feat(three-card-showdown): add playable game"
```

---

## Task 6: Add remaining composition/recovery/profile coverage and run full validation

**Files:**
- Create: `src/lib/three-card-showdown/client.init.test.ts`
- Modify: `e2e/three-card-showdown.spec.ts`
- Modify: `e2e/profile-statistics.spec.ts`

**Interfaces:**
- No new runtime interface.

- [ ] **Step 1: Add focused Happy-DOM guest Play/Fold composition tests**

Create a root fixture with the same dataset contract as the real page.

Guest Play with start 1000, Ante 10, `Math.random = () => 0`:

```text
before Deal: 1000
Deal: 990, player cards visible, dealer facedown
Play: Dealer wins · -20 net, 980, dealer revealed
localStorage three-card-showdown-bankroll:anonymous = 980
wallet fetch count = 0
```

Guest Fold:

```text
Deal -> 990
Fold -> Fold · -10 net
balance 990
localStorage = 990
wallet fetch count = 0
dealer slots revealed at complete
```

These tests cover Three-Card composition only; do not duplicate the shared controller's retry/achievement matrix.

- [ ] **Step 2: Add the unaffordable Ante button regression**

Start with balance 150, click Ante 100, and assert:

```ts
expect(statusEl.textContent).toBe('Ante plus Play wager exceeds available balance');
expect(game-visible selected ante).to remain 1;
expect(no uncaught error).to be observed;
```

Implement the assertion using the page fixture's `[data-ante]` `aria-pressed` state rather than reaching into the private game instance:

```ts
expect(anteButton(1).getAttribute('aria-pressed')).toBe('true');
expect(anteButton(100).getAttribute('aria-pressed')).toBe('false');
```

- [ ] **Step 3: Add authenticated 503 → exact-command Retry E2E**

Extend `e2e/three-card-showdown.spec.ts` using `createIsolatedPage()`.

Intercept `**/api/wallet/settle` and capture request bodies. First request returns 503; second returns:

```ts
{
  balance: startingBalance + Number(command.delta ?? 0),
  duplicate: false,
}
```

After Deal → Play:

```ts
expect(commands).toHaveLength(1);
await expect(page.locator('#three-card-showdown-settlement-recovery')).toBeVisible();
await expect(page.locator('#three-card-showdown-new-round')).toBeDisabled();
```

Click Retry:

```ts
expect(commands).toHaveLength(2);
expect(commands[1]).toEqual(commands[0]);
await expect(page.locator('#three-card-showdown-settlement-recovery')).toBeHidden();
await expect(page.locator('#three-card-showdown-new-round')).toBeEnabled();
```

Assert local and shared-header balance surfaces both show the returned authoritative balance.

Detailed Retry button in-flight disabling, achievement dispatch, and Reset callback semantics remain tested once in `public-game-settlement.test.ts`.

- [ ] **Step 4: Update the fixed profile game list**

Append to `CANONICAL_GAME_TYPES` in `e2e/profile-statistics.spec.ts`:

```ts
'three-card-showdown',
```

Existing mapped fixtures/card-count assertions should then cover the tenth game without a second profile-specific test.

- [ ] **Step 5: Run focused final acceptance**

```bash
bun test src/lib/three-card-showdown/ src/lib/wallet/public-game-settlement.test.ts
bunx playwright test e2e/three-card-showdown.spec.ts e2e/video-poker.spec.ts e2e/sic-bo.spec.ts e2e/profile-statistics.spec.ts --workers=1
```

Expected: PASS.

- [ ] **Step 6: Run complete unit/integration/static validation**

```bash
bun run test
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

- [ ] **Step 8: Run the final anti-overbuild/anti-duplication gate**

Require all of these from the final diff:

```text
no schema/migration files changed
no new API route exists
src/lib/poker/** is untouched
Blackjack card representation is untouched
no generic evaluator/base game/paytable engine exists
src/lib/cards.ts is the canonical Card/Rank/Suit path
public-game settlement controller contains no game phases/rules/action-button logic
Video Poker and Sic Bo use the shared public-game settlement controller
Three-Card Showdown does not copy the old session/gate/recovery/adopt/retry/reset block
no unrelated Slots/Keno/Baccarat wallet migration was added
no side bet/bonus/AI/ranked/history/replay code exists
GAME_TYPES has exactly 10 entries
```

If any settlement/session/recovery block is copied verbatim from another public-game client, stop and move that behavior into the focused controller instead.

- [ ] **Step 9: Commit remaining coverage**

```bash
git add src/lib/three-card-showdown/client.init.test.ts e2e/three-card-showdown.spec.ts e2e/profile-statistics.spec.ts
git commit -m "test(three-card-showdown): cover guest and wallet flows"
```

---

## Final Review Checklist

- [ ] `src/lib/cards.ts` is neutral and only the intended clean consumers were migrated; Poker/Blackjack card shapes are untouched.
- [ ] Video Poker has no `types.ts` compatibility re-export for `Card`/`Rank`/`Suit`.
- [ ] Video Poker and Sic Bo no longer own duplicate public-game net-round settlement/recovery blocks.
- [ ] Shared settlement controller owns wallet/session/recovery mechanics only.
- [ ] Straight beats Flush in every Three-Card comparison path.
- [ ] Q-high qualifies; J-high does not.
- [ ] Initial Ante is exactly 1.
- [ ] Deal cannot enter decision state unless the equal Play wager is affordable.
- [ ] Ante button validates before calling throwing `setAnte()`.
- [ ] Fold loses one Ante; Play outcomes account for both wagers exactly once.
- [ ] No Ante Bonus or side bet exists.
- [ ] Guest Fold/Play makes no wallet request and persists local bankroll.
- [ ] Authenticated completion creates one command; Retry reuses it unchanged.
- [ ] Achievement forwarding/retry/reset mechanics are tested once in the shared controller suite.
- [ ] The real page/client contract is proven by the guest E2E in the page/client task.
- [ ] `three-card-showdown` appears in game stats, profile statistics, and lobby surfaces.
- [ ] Full tests, lint, format, build, focused E2E, and serial Playwright are green before implementation is declared complete.
