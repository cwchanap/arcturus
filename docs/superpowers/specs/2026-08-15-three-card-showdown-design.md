# HPA-198 Three-Card Showdown Design

## Summary

Build HPA-198 as the next small single-player Arcturus game: a focused Ante → Fold/Play → result loop at `/games/three-card-showdown`.

The design intentionally stays close to the current Video Poker and Sic Bo module shape:

- Extract only the neutral 52-card `Card`/deck helpers from Video Poker into one shared `src/lib/cards.ts` file, because Three-Card Showdown becomes the second concrete consumer.
- Keep Three-Card Showdown hand ranking, dealer qualification, payout resolution, state transitions, settlement mapping, and UI behavior inside `src/lib/three-card-showdown/`.
- Reuse `src/lib/bet-validation.ts`, `src/lib/public-game-session.ts`, `src/lib/wallet`, `src/components/CardSlot.astro`, and `src/lib/card-slot-utils.ts` as-is.
- Add no database table, API route, server-authoritative card flow, generic poker evaluator, game framework, strategy layer, history, AI, ranked mode, side bet, or compatibility layer.

This is deliberately smaller than HPA-197 Pai Gow Poker. HPA-198 has one wager, one decision, six dealt cards, and no arrangement UI or house-way logic, so it is the better next feature for fast iteration.

## Why HPA-198 is next

The parent architecture roadmap's required cleanup sequence is already complete: private-room Poker isolation, wallet settlement simplification, BYOK AI cleanup, Video Poker, and Blackjack Run consolidation have all landed. Sic Bo, the next small game slice, is also complete.

The remaining open roadmap children fall into two groups:

- Explicitly deferred features: recent Blackjack run history and a weekly Daily leaderboard.
- Future games: HPA-197 Pai Gow Poker and HPA-198 Three-Card Showdown.

Choose HPA-198 before HPA-197 because it validates card-domain reuse with much less new UI and rules surface. Pai Gow remains a good later consumer once the simpler three-card module is proven.

## Reuse survey

### Shared cards: extract now, but only the neutral primitive

Video Poker currently owns a small standard 52-card model and Fisher-Yates deck helper in `src/lib/video-poker/cards.ts`:

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

When HPA-195 was designed, keeping those rules local was correct because there was only one clean consumer. HPA-198 creates the second concrete consumer with exactly the same 52-card shape and shuffle semantics. The extraction is now justified.

Move only those types/functions into:

```text
src/lib/cards.ts
src/lib/cards.test.ts
```

Then update Video Poker to import `Card`, `Rank`, `Suit`, and `createShuffledDeck` from `../cards` and delete its old local `cards.ts`/`cards.test.ts`.

Do **not** migrate `src/lib/poker/DeckManager.ts` or `src/lib/poker/types.ts`. Texas Hold'em currently uses a different `{ value, suit, rank }` shape and has broader engine coupling. Converting it would turn HPA-198 into an unrelated Poker refactor.

Do **not** extract any evaluator. Five-card Jacks-or-Better evaluation and three-card showdown evaluation have materially different hand ordering and tie-break rules.

### Card rendering

Reuse the already-shared rendering seam:

- `src/components/CardSlot.astro`
- `src/lib/card-slot-utils.ts`

Three player slots render face-up after Deal. Three dealer slots render face-down during the decision phase and face-up only after Fold or Play resolves the round.

No new generic card-row component is needed; six `CardSlot` instances in the page are simpler.

### Wager validation

Reuse `validateBet()` from `src/lib/bet-validation.ts` for numeric min/max validation.

Three-Card Showdown owns one additional affordability rule: before Deal, the account must be able to cover **two Ante units** so the player is never dealt into a state where Play is impossible solely because the second equal wager cannot be funded.

Use:

```ts
export const MIN_ANTE = 1;
export const MAX_ANTE = 100;
export const ANTE_OPTIONS = [1, 5, 10, 25, 50, 100] as const;
```

`getAnteError(ante)` requires:

1. a whole number;
2. `MIN_ANTE <= ante <= MAX_ANTE` through `validateBet()`; and
3. `ante * 2 <= current balance`.

The UI exposes only `ANTE_OPTIONS`, but the pure domain contract remains the integer range rather than introducing a denomination type.

### Guest/public session

Reuse `createPublicGameSession()`, `loadGuestBankroll()`, `persistGuestBankroll()`, `isGuestModeValue()`, and `shouldSyncAccountChips()` exactly as Video Poker does.

Use game key `three-card-showdown` for guest bankroll storage and game statistics.

### Wallet settlement

Reuse the existing public wallet boundary:

- `newSettlementId(game)`
- `createSettlementGate()`
- `ensureSettlementRecoveryControls()`
- `SettleRoundCommand`
- `SettleRoundResult`

Every completed Fold or Play produces exactly one logical settlement command for authenticated play. Retry reuses the exact pending command and settlement ID through the existing gate.

Keep the command builder game-local:

```ts
buildThreeCardShowdownSettlementCommand(settlementId, result)
```

The wallet delta is already the full game net result, so no `RoundStats.netProfit` override is needed.

Statistics mapping:

```ts
{
  rounds: 1,
  wins: result.netDelta > 0 ? 1 : 0,
  losses: result.netDelta < 0 ? 1 : 0,
  biggestWin: Math.max(result.netDelta, 0),
}
```

A tie records one round with zero wins/losses. Folding records a loss.

## Alternatives considered

### A. Extract a minimal shared card/deck primitive + local game module — selected

Move the now-duplicated neutral card/deck concept into `src/lib/cards.ts`. Keep every Three-Card-specific rule local.

**Why:** it removes one real duplication with two active consumers while preserving clear module ownership.

### B. Duplicate Video Poker's deck inside Three-Card Showdown — rejected

This would be only a few lines, but the exact same card shape and Fisher-Yates deck would immediately exist in two clean single-player modules. The roadmap explicitly allows sharing domain-neutral card primitives when there is a real consumer.

### C. Reuse or refactor Texas Hold'em Poker internals — rejected

Poker's `DeckManager`, card type, evaluator, and engine are coupled to the older Hold'em module and use a different card shape. Pulling HPA-198 through that code would increase coupling and scope without improving the new game's rules.

### D. Create a generic poker-hand evaluator for 3-card and 5-card games — rejected

Three-card hand precedence differs from standard five-card poker: Straight beats Flush, and the evaluator needs dealer-qualification/tie-break semantics that Video Poker does not. A configurable evaluator would be more abstraction than either game needs.

## Game rules

### Hand ranking

Highest to lowest:

1. Straight Flush
2. Three of a Kind
3. Straight
4. Flush
5. Pair
6. High Card

Important three-card rules:

- Straight ranks above Flush.
- A-K-Q is the highest straight.
- A-2-3 is the lowest straight.
- K-A-2 is not a straight.
- Suits never break ties.

### Tie breakers

`evaluateThreeCardHand(cards)` returns a category plus ordered numeric tie breakers.

Use these keys:

- Straight Flush / Straight: `[straightHigh]`, where A-2-3 uses `3`.
- Three of a Kind: `[tripRank]`.
- Flush / High Card: ranks descending, e.g. `[14, 11, 8]`.
- Pair: `[pairRank, kickerRank]`.

`compareThreeCardHands(left, right)` compares category strength first, then tie breakers lexicographically, returning `1`, `0`, or `-1`.

### Dealer qualification

The dealer qualifies with Queen-high or better.

Implement `dealerQualifies(evaluation)` without a separate strategy object:

- every Pair-or-better category qualifies;
- a High Card qualifies when its highest tie breaker is at least Queen (`12`).

### Round flow

1. Player chooses an Ante.
2. `Deal` validates that two Ante units are affordable, deducts one Ante, creates one shuffled deck, deals three player cards and three dealer cards, and enters `decision`.
3. Dealer cards stay face-down in the UI.
4. Player chooses exactly one action:
   - `Fold`: lose the Ante and complete the round.
   - `Play`: deduct one additional wager equal to the Ante, reveal the dealer, and compare hands.
5. On completion, credit the gross payout locally and freeze one `ThreeCardShowdownRoundResult`.
6. Guest mode persists the resulting local bankroll. Authenticated mode submits one wallet settlement using `netDelta`.
7. `New Round` clears cards/result and keeps the selected Ante.
8. Authenticated `New Round` remains disabled while settlement is pending or failed.

### Payout resolution

There is **no Ante Bonus, Pair Plus, Hand Bonus, or any other side/bonus wager** in HPA-198.

For Fold:

- total wager: `ante`
- gross payout: `0`
- net delta: `-ante`

For Play, total wager is `2 * ante`:

| Outcome | Gross payout | Net delta |
| --- | ---: | ---: |
| Dealer does not qualify | `3 * ante` | `+ante` |
| Dealer qualifies, player wins | `4 * ante` | `+2 * ante` |
| Tie | `2 * ante` | `0` |
| Dealer qualifies, dealer wins | `0` | `-2 * ante` |

“Gross payout” includes returned stake, matching how Video Poker credits payout after locally deducting wager(s).

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

### `src/lib/cards.ts`

Own only:

- `Suit`
- `Rank`
- `Card`
- `createDeck()`
- `shuffleDeck()`
- `createShuffledDeck()`

No evaluator, card formatting, UI behavior, shoe, discard pile, or Poker compatibility adapter belongs here.

### `three-card-showdown/types.ts`

Own only game-domain types:

```ts
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

`ThreeCardShowdownRoundResult` stores the chosen outcome, ante, total wager, gross payout, net delta, both frozen hands/evaluations, and whether the dealer qualified.

`ThreeCardShowdownState` stores phase, balance, ante, player hand, dealer hand, and optional result.

### `three-card-showdown/rules.ts`

Own the game-specific pure rules:

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

`evaluateThreeCardHand()` requires exactly three cards and throws for programmer-invalid input. It does not know about bankroll, DOM, wallet, or settlement IDs.

### `three-card-showdown/game.ts`

`ThreeCardShowdownGame` owns the pure lifecycle:

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

State transitions:

```text
betting --deal--> decision --fold/play--> complete --resetRound--> betting
```

The game class owns deck creation/deal order and local balance math. It delegates hand ranking and played-hand payout resolution to `rules.ts`.

### `three-card-showdown/client.ts`

Own DOM rendering, guest persistence, and wallet integration only.

Responsibilities:

- initialize the pure game with session balance;
- render player/dealer slots through `setSlotState()`;
- hide dealer faces in `decision` and reveal them in `complete`;
- wire Ante buttons, Deal, Fold, Play, and New Round;
- build one game-local settlement command;
- persist guest balance after a completed action;
- submit authenticated settlement through one `createSettlementGate()`;
- use the existing recovery controls for Retry/Reset;
- adopt the authoritative returned balance after successful settlement;
- update both local balance text and shared header `[data-chip-balance]` text.

Do not extract a shared “casino game client controller” from Video Poker/Sic Bo. Their DOM/state semantics are still different and the duplicated glue is small.

### `three-card-showdown/index.ts`

Export only the page/test-facing public surface:

- `ThreeCardShowdownGame`
- rule functions needed by focused tests
- `ANTE_OPTIONS`
- `initThreeCardShowdownClient`
- relevant game-domain result/evaluation types

Do not create a second barrel hierarchy.

## Page/UI

Add `/games/three-card-showdown` using the existing casino layout.

Layout:

- header with Back to Games, game title, concise “Ante · Fold or Play · Dealer qualifies with Queen-high” copy, and balance panel;
- felt table with a three-card Dealer row and three-card Player row;
- compact status/result area;
- Ante option buttons;
- phase actions:
  - `Deal` in betting;
  - `Fold` and `Play` in decision;
  - `New Round` in complete;
- existing wallet recovery controls attached below actions when needed;
- a small static “Rules” panel listing hand order and dealer qualification.

No card animations, drag/drop, sound, strategy hints, odds display, history, or bonus-paytable UI.

## Game registration

Add `three-card-showdown` as the next `GameType` in `src/lib/game-stats/constants.ts` with:

- label: `Three-Card Showdown`
- icon: `🂡` or the existing card-style fallback if the project font renders it poorly

Add the lobby card in `src/pages/index.astro` and any game-directory fixture/assertion that enumerates all games.

No schema migration is required; game statistics use the application-level game identifier.

## Error and recovery behavior

Keep normal errors user-visible and local:

- invalid/unaffordable Ante disables Deal and renders `getAnteError()`;
- Fold/Play outside `decision` are programmer-invalid and may throw;
- Deal while another hand is active may throw;
- missing DOM elements make client initialization no-op where existing clients already tolerate them.

Wallet failure behavior remains exactly the existing gate policy:

- the completed round stays visible;
- New Round is disabled;
- Retry resubmits the exact command;
- Reset discards the failed local round, restores the last server-synced balance, clears the gate, and returns to betting.

No timers, automatic retry, localStorage pending command, outbox, background sync, or cross-tab coordination.

## Testing

### Shared card extraction

Move the existing Video Poker deck tests to `src/lib/cards.test.ts` and keep coverage for:

- 52 unique cards;
- all suits/ranks;
- deterministic injectable shuffle;
- source deck not mutated.

Run Video Poker focused tests after moving imports to prove no behavior change.

### Rules

`rules.test.ts` covers:

- category order: Straight Flush > Trips > Straight > Flush > Pair > High Card;
- A-K-Q highest straight;
- A-2-3 lowest straight;
- K-A-2 not straight;
- Pair kicker comparison;
- Flush/High Card lexicographic comparison;
- exact ties ignore suit;
- dealer qualification at Q-high versus J-high;
- dealer-not-qualified payout;
- player win, tie, and dealer win payouts.

### Game state

`game.test.ts` covers:

- Ante validation and two-unit affordability;
- Deal deducts one Ante and deals six unique cards;
- Fold loses only the Ante;
- Play deducts the second Ante and resolves once;
- New Round keeps Ante and clears cards/result;
- `setBalance()` adopts an authoritative non-negative balance;
- invalid phase transitions reject.

### Client unit/DOM tests

Follow the Video Poker/Sic Bo pattern:

- `client.test.ts` asserts settlement command mapping only;
- `client.init.test.ts` covers phase-specific buttons, dealer facedown/reveal rendering, balance updates, guest persistence, settlement blocking, Retry exact-command reuse, and Reset restoring the last server balance.

Do not duplicate the wallet settlement gate's internal state-machine tests.

### E2E

Keep HPA-198 to two representative browser flows:

1. Guest Ante → Deal → Play → result → New Round, with deterministic `Math.random` and no `/api/wallet/settle` request.
2. Authenticated completed hand with first settlement returning `503`, recovery shown, Retry using the exact same command, then authoritative balance adoption.

Also extend `e2e/profile-statistics.spec.ts` only if its current fixed game list requires the new registered game to appear.

## Delivery risks

### Shared-card extraction can accidentally widen scope

Mitigation: move only the exact Video Poker card type/deck helper. Do not touch Hold'em Poker.

### Three-card hand ordering is easy to implement like five-card Poker by mistake

Mitigation: pin Straight > Flush and A-2-3 low-straight behavior in focused rules tests before implementing the evaluator.

### Local balance math can double-count returned stakes

Mitigation: tests assert both gross payout and net delta for all four Play outcomes plus Fold. The game deducts wagers before crediting gross payout, mirroring Video Poker's balance model.

### Settlement recovery can allow a second round too early

Mitigation: use the existing settlement gate and keep New Round disabled whenever authenticated settlement is blocked, matching Video Poker and Sic Bo.

## Non-goals

- Pair Plus, Ante Bonus, Hand Bonus, side bets, progressive prizes.
- More than one Ante/Play wager pair.
- AI advice, strategy hints, Q-6-4 recommendations, or post-round coaching.
- Ranked/Daily mode, server-authoritative dealing, anti-cheat, signatures, or replay verification.
- History, replays, persisted unfinished hands, crash recovery, automatic retries, or cross-tab coordination.
- Generic poker evaluator, generic paytable system, base game class, generic casino client controller, game plugin system, or card-layout framework.
- Refactoring Texas Hold'em Poker to the new shared card type.
- Backward-compatible aliases for Video Poker's old local card exports.

## Definition of done

- HPA-198 provides one complete, understandable Ante → Fold/Play → result game loop.
- Video Poker and Three-Card Showdown share exactly one neutral `cards.ts` primitive and no game-specific evaluator/state.
- Guest play is local; authenticated completed rounds use one existing wallet settlement command/gate.
- Three-card ranking, dealer qualification, wager accounting, and state transitions are thoroughly unit tested.
- One representative guest flow and one authenticated recovery flow pass in Playwright.
- The final implementation introduces no database migration, new API endpoint, generic framework, compatibility layer, or unrelated Poker refactor.
