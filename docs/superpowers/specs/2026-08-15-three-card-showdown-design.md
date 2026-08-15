# HPA-198 Three-Card Showdown Design

## Summary

Build HPA-198 as the next small single-player Arcturus game: a focused Ante → Fold/Play → result loop at `/games/three-card-showdown`.

The design stays deliberately small:

- Extract only the neutral 52-card `Card`/deck helpers from Video Poker into `src/lib/cards.ts`, because Three-Card Showdown becomes the second clean consumer.
- Keep three-card ranking, dealer qualification, payout resolution, state, settlement mapping, and UI behavior inside `src/lib/three-card-showdown/`.
- Reuse the existing wager validation, public-game session, wallet settlement/recovery, `CardSlot`, and card-slot rendering APIs unchanged.
- Add no database table, API route, server-authoritative card flow, generic poker evaluator, base game class, strategy layer, history, AI, ranked mode, side bet, or compatibility path.

HPA-198 is a better next slice than HPA-197 Pai Gow Poker because it adds one wager and one decision rather than seven-card arrangement, foul validation, and dealer house-way UI.

## Why this is actionable now

The HPA-167 architecture sequence is complete: private-room Poker isolation, wallet settlement simplification, BYOK AI cleanup, Video Poker, and Blackjack Run consolidation have landed. Sic Bo is also complete.

The other open roadmap children are either explicitly deferred (`HPA-174`, `HPA-177`) or larger future games (`HPA-197`). HPA-198 is therefore the smallest unblocked product slice that continues the single-player modular direction.

## Reuse decisions

### 1. Share only the neutral card/deck primitive

Video Poker currently owns exactly the standard card concept HPA-198 needs:

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

Move those types/functions to:

```text
src/lib/cards.ts
src/lib/cards.test.ts
```

Then update Video Poker to consume the shared file and delete its local `cards.ts`/`cards.test.ts`.

Do **not** refactor `src/lib/poker/**`. Texas Hold'em uses a different `{ value, suit, rank }` card shape and is coupled to its existing engine. No compatibility alias is needed for Video Poker's old local card exports.

Do **not** share an evaluator. Five-card Jacks-or-Better and three-card showdown use different category ordering and tie-break semantics.

### 2. Reuse existing card presentation

Reuse:

- `src/components/CardSlot.astro`
- `src/lib/card-slot-utils.ts`

The page owns six slots directly. Player cards are face-up after Deal. Dealer cards are facedown during `decision` and face-up at `complete`.

No generic card-row component is needed.

### 3. Reuse wager validation, with one game-local affordability rule

Reuse `validateBet()` from `src/lib/bet-validation.ts`.

Three-Card Showdown constants:

```ts
export const MIN_ANTE = 1;
export const MAX_ANTE = 100;
export const ANTE_OPTIONS = [1, 5, 10, 25, 50, 100] as const;
```

`getAnteError(ante)` requires:

1. a whole number;
2. `MIN_ANTE <= ante <= MAX_ANTE`; and
3. `ante * 2 <= balance`.

The third rule guarantees that after Deal the equal Play wager is always affordable. It avoids a second decision-state error path.

### 4. Reuse public-game session and guest bankroll

Use the existing:

- `createPublicGameSession()`
- `loadGuestBankroll()`
- `persistGuestBankroll()`
- `isGuestModeValue()`
- `shouldSyncAccountChips()`

Use game key `three-card-showdown` for guest storage and game statistics.

### 5. Reuse the existing wallet gate unchanged

Use:

- `newSettlementId(game)`
- `createSettlementGate()`
- `ensureSettlementRecoveryControls()`
- `SettleRoundCommand`
- `SettleRoundResult`

Every completed Fold or Play creates exactly one logical authenticated settlement. Retry reuses the exact pending command/ID through the gate.

Keep command construction local:

```ts
buildThreeCardShowdownSettlementCommand(settlementId, result)
```

Mapping:

```ts
{
  settlementId,
  game: 'three-card-showdown',
  delta: result.netDelta,
  stats: {
    rounds: 1,
    wins: result.netDelta > 0 ? 1 : 0,
    losses: result.netDelta < 0 ? 1 : 0,
    biggestWin: Math.max(result.netDelta, 0),
  },
}
```

A tie is one round with zero wins/losses. Folding is a loss. No `stats.netProfit` override is needed because `delta` is already the true game net result.

## Alternatives considered

### A. Minimal shared cards + local Three-Card module — selected

This removes one real duplication now that there are two clean consumers while keeping game semantics isolated.

### B. Duplicate Video Poker's deck — rejected

It is only a few lines, but the exact same 52-card model and Fisher-Yates helper would immediately exist twice. This is now a real shared concept rather than hypothetical reuse.

### C. Reuse/refactor Texas Hold'em Poker internals — rejected

That would turn HPA-198 into an unrelated legacy Poker refactor and increase coupling.

### D. Build a configurable poker evaluator — rejected

Three-card ranking differs from five-card poker, notably Straight > Flush. A generic evaluator adds configuration and abstraction without a concrete need.

## Game rules

### Hand order

Highest to lowest:

1. Straight Flush
2. Three of a Kind
3. Straight
4. Flush
5. Pair
6. High Card

Rules:

- Straight beats Flush.
- A-K-Q is the highest straight.
- A-2-3 is the lowest straight and uses straight-high `3` for comparison.
- K-A-2 is not a straight.
- Suits never break ties.

### Tie breakers

`evaluateThreeCardHand(cards)` returns a category plus ordered numeric tie breakers:

- Straight Flush / Straight: `[straightHigh]`
- Three of a Kind: `[tripRank]`
- Flush / High Card: ranks descending
- Pair: `[pairRank, kickerRank]`

`compareThreeCardHands(left, right)` compares category strength, then tie breakers lexicographically, returning `-1 | 0 | 1`.

### Dealer qualification

Dealer qualifies with Queen-high or better:

- every Pair-or-better hand qualifies;
- High Card qualifies when `tieBreakers[0] >= 12`.

No strategy object or rules version is needed.

### Round flow

```text
betting --Deal--> decision --Fold/Play--> complete --New Round--> betting
```

1. Player chooses Ante.
2. Deal validates two-Ante affordability, deducts one Ante, shuffles one 52-card deck, deals three player cards then three dealer cards, and enters `decision`.
3. Dealer cards remain facedown.
4. Fold completes immediately and loses only the Ante.
5. Play deducts one second wager equal to Ante, reveals dealer, resolves the comparison, credits gross payout, and completes.
6. Guest completion persists the local bankroll.
7. Authenticated completion submits one net settlement.
8. New Round clears cards/result, keeps the selected Ante, and is disabled while authenticated settlement is blocked.

### Payouts

There is **no Ante Bonus, Pair Plus, Hand Bonus, or other side/bonus wager**.

Fold:

| Outcome | Total wager | Gross payout | Net delta |
| --- | ---: | ---: | ---: |
| Fold | `ante` | `0` | `-ante` |

Play uses total wager `2 * ante`:

| Outcome | Gross payout | Net delta |
| --- | ---: | ---: |
| Dealer does not qualify | `3 * ante` | `+ante` |
| Qualified dealer, player wins | `4 * ante` | `+2 * ante` |
| Tie | `2 * ante` | `0` |
| Qualified dealer, dealer wins | `0` | `-2 * ante` |

Gross payout includes returned stake, matching the current Video Poker balance model: deduct wagers first, then credit gross payout.

## Module shape

```text
src/lib/cards.ts
src/lib/cards.test.ts

src/lib/three-card-showdown/
  types.ts
  rules.ts
  rules.test.ts
  game.ts
  game.test.ts
  client.ts
  client.test.ts
  client.init.test.ts
  index.ts

src/pages/games/three-card-showdown.astro
e2e/three-card-showdown.spec.ts
```

## Domain types

`types.ts` owns only Three-Card domain types:

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
```

`ThreeCardShowdownRoundResult` stores outcome, ante, total wager, gross payout, net delta, dealer-qualified flag, both hands, and both evaluations.

`ThreeCardShowdownState` stores phase, balance, ante, both hands, and optional result.

## Pure rules API

`rules.ts` exposes:

```ts
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

`evaluateThreeCardHand()` requires exactly three cards and throws only for programmer-invalid input. Rules code has no bankroll, DOM, fetch, storage, or wallet dependency.

## Pure game API

`game.ts` exposes:

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

The game owns deck/deal order and local balance math. It delegates hand evaluation/comparison to `rules.ts`.

## Client/page design

`client.ts` owns only DOM rendering, guest persistence, and wallet composition.

Responsibilities:

- initialize `ThreeCardShowdownGame` with the public-session balance;
- render cards through `setSlotState()`;
- render dealer as facedown in `decision` and face-up in `complete`;
- wire Ante, Deal, Fold, Play, and New Round;
- persist guest balance after completion;
- submit one authenticated settlement and adopt returned balance;
- use existing Retry/Reset recovery controls;
- update `#chip-balance` and shared `[data-chip-balance]` elements.

Do not extract a shared casino client controller from Video Poker/Sic Bo.

The page uses `CasinoLayout` and six `CardSlot` instances. It contains:

- Back to Games, title, `Ante · Fold or Play · Dealer qualifies with Queen-high`, and balance panel;
- Dealer three-card row;
- Player three-card row;
- status/result area;
- Ante buttons;
- phase-specific Deal / Fold + Play / New Round buttons;
- settlement recovery host;
- a small static Rules panel.

Result copy is compact and deterministic:

- Fold: `Fold · -<ante> net`
- Dealer not qualified: `Dealer does not qualify · +<ante> net`
- Player win: `Player wins · +<2 * ante> net`
- Tie: `Tie · 0 net`
- Dealer win: `Dealer wins · -<2 * ante> net`

Cards themselves show the compared hands, so do not duplicate hand labels in result copy.

No animation, sound, odds, strategy hints, drag/drop, history, or bonus-paytable UI.

## Game registration

Add `three-card-showdown` to `src/lib/game-stats/constants.ts` with exact values:

```ts
GAME_TYPE_LABELS['three-card-showdown'] = 'Three-Card Showdown';
GAME_TYPE_ICONS['three-card-showdown'] = '♠️';
```

Use the already-proven `♠️` card icon rather than adding a new font-dependent playing-card glyph.

Update the fixed canonical game list in `e2e/profile-statistics.spec.ts` and add one focused `game-stats.test.ts` registration assertion.

Add a normal lobby card in `src/pages/index.astro` linking to `/games/three-card-showdown`.

No schema migration is required.

## Error and recovery behavior

Normal invalid Ante state is rendered from `getAnteError()` and disables Deal.

Programmer-invalid phase transitions may throw:

- Deal outside `betting`;
- Fold/Play outside `decision`;
- New Round outside `complete`.

Wallet failure uses the existing gate policy only:

- completed result remains visible;
- New Round is disabled;
- Retry resubmits the exact pending command;
- Reset clears the gate, restores the last server-synced balance, discards the failed completed round, and returns to `betting`.

No timer, auto-retry, pending-command persistence, outbox, background sync, or cross-tab coordination.

## Testing

### Shared cards

Move Video Poker's deck tests to `src/lib/cards.test.ts` and cover:

- 52 unique cards;
- all ranks/suits;
- deterministic injectable shuffle;
- source deck is not mutated.

Run all Video Poker unit/DOM tests after the import move.

### Rules

Cover:

- every category and exact category order;
- Straight > Flush;
- A-K-Q highest straight;
- A-2-3 lowest straight;
- K-A-2 not straight;
- Pair kicker comparison;
- High Card/Flush lexicographic comparison;
- suit-insensitive ties;
- Q-high qualifies / J-high does not;
- dealer-not-qualified, player-win, tie, dealer-win payouts.

### Game state

Cover:

- Ante bounds/integer/two-unit affordability;
- Deal deducts one Ante and produces six unique cards;
- Fold loses one Ante only;
- Play deducts the second Ante and resolves exactly once;
- New Round retains Ante but clears cards/result;
- authoritative `setBalance()`;
- invalid transitions.

### Client tests

Keep `client.test.ts` to settlement-command mapping.

`client.init.test.ts` covers composition only:

- phase-specific action buttons;
- dealer facedown/reveal behavior;
- balance rendering;
- guest persistence and no wallet call;
- settlement blocks New Round;
- Retry uses exact command;
- Reset restores last server balance.

Do not duplicate wallet-gate internals.

### E2E

Use two representative flows.

**Guest deterministic flow:** set `Math.random = () => 0`, select Ante `10`, Deal then Play. With the shared deck order and Fisher-Yates shuffle, player receives `3♥ 4♥ 5♥`; dealer receives `6♥ 7♥ 8♥`. Both are Straight Flushes, dealer wins by straight high. Assert `Dealer wins · -20 net`, final balance `980`, revealed dealer cards, and zero `/api/wallet/settle` requests. Then New Round returns to betting.

**Authenticated recovery flow:** complete one Play, make the first `/api/wallet/settle` return 503, assert recovery and blocked New Round, Retry, assert the second request body exactly equals the first, then adopt the returned authoritative balance.

Also update `e2e/profile-statistics.spec.ts`'s fixed `CANONICAL_GAME_TYPES` array with `three-card-showdown`.

## Delivery risks

### Shared-card extraction grows into a Poker rewrite

Mitigation: touch only Video Poker and the new game. `src/lib/poker/**` stays unchanged.

### Five-card ranking assumptions leak into three-card rules

Mitigation: test Straight > Flush and A-2-3 before implementation.

### Returned stakes are double-counted

Mitigation: assert gross payout and net delta for Fold plus all four Play outcomes. Game code deducts stake before applying gross payout.

### A second round starts before settlement resolves

Mitigation: use the existing gate and disable New Round whenever authenticated settlement is blocked.

## Non-goals

- Pair Plus, Ante Bonus, Hand Bonus, side bets, progressive prizes.
- AI advice or strategy coaching.
- Ranked/Daily mode or server-authoritative dealing.
- History, replay, persisted unfinished hands, crash recovery, automatic retry, cross-tab coordination.
- Generic poker evaluator, paytable engine, base game class, generic casino client controller, plugin system, or card-layout framework.
- Texas Hold'em card/evaluator refactor.
- Backward-compatible Video Poker card aliases.

## Definition of done

- One complete Ante → Fold/Play → result loop exists at `/games/three-card-showdown`.
- Video Poker and Three-Card Showdown share exactly the neutral `src/lib/cards.ts` primitive.
- Guest play remains local; authenticated completion uses one existing wallet settlement command/gate.
- Three-card ranking, qualification, wager accounting, and state transitions have focused unit coverage.
- The deterministic guest E2E and authenticated recovery E2E pass.
- The new game is registered in statistics/profile/lobby surfaces.
- No schema migration, new API, framework, compatibility layer, or unrelated Poker refactor is introduced.
