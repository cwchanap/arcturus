# HPA-197 Focused Pai Gow Poker Design

## Summary

Build HPA-197 as the next concrete Arcturus roadmap slice: one self-contained single-player Pai Gow Poker game at `/games/pai-gow-poker`.

The design stays intentionally narrow:

- Reuse the neutral standard-card primitive from `src/lib/cards.ts`, but keep the Joker and all Pai Gow-specific card rules local.
- Extract only the private **standard five-card poker ranking/comparison** logic that Texas Hold'em and Pai Gow now genuinely share.
- Keep Pai Gow's Joker semantics, unusual straight ordering, two-card low-hand rules, split validation, deterministic dealer arrangement policy, payouts, state, and UI inside `src/lib/pai-gow-poker/`.
- Reuse `validateBet`, `CardSlot`, `setSlotState`, `createPublicGameSession`, and `createPublicGameSettlementController` unchanged.
- Keep one main wager only. No side bets, banking, drag-and-drop system, AI, ranked mode, history, replay, server-authoritative dealing, schema change, or compatibility layer.

This is not a generic poker platform. The only new shared seam is a five-card comparator that already exists privately in Texas Hold'em and now has a second concrete consumer.

## Why HPA-197 is next

HPA-198 Three-Card Showdown is complete. The other remaining open HPA-167 children are either explicitly deferred (`HPA-174`, `HPA-177`) or the roadmap umbrella itself. HPA-197 is therefore the next concrete, unblocked game slice.

HPA-197's former blocker, HPA-545 wallet settlement simplification, is complete. The newly merged HPA-198 work also gives Pai Gow two useful stable seams that did not exist when HPA-197 was first written:

- `src/lib/cards.ts` for neutral 52-card creation/shuffling.
- `src/lib/wallet/public-game-settlement.ts` for guest bankroll + one net authenticated settlement + retry/reset recovery.

## Approaches considered

### A. Extract one structural five-card ranker; keep Pai Gow rules local — selected

Move the exact standard five-card ranking/comparison logic out of `src/lib/poker/handEvaluator.ts` into one neutral pure module. Texas Hold'em keeps its existing player/community-card logic and AI heuristics; it merely calls the extracted comparator. Pai Gow wraps that comparator with its own Joker and Pai Gow ordering rules.

Why this is the best fit:

- There is now real duplicate pressure: Texas Hold'em already has a correct private five-card comparator and Pai Gow needs the same base poker categories/tie breaking.
- The shared function can accept structural `{ rank, suit }` cards, so Texas Hold'em does not need a card-model migration and Pai Gow does not need an adapter object with Hold'em's extra `value` field.
- Video Poker remains untouched because Jacks-or-Better is a payout evaluator, not a generic showdown comparator.
- The shared API stays small enough to understand in one file.

### B. Copy a full five-card evaluator into Pai Gow — rejected

This keeps the ticket locally isolated but would duplicate the longest non-Pai-Gow-specific part of the rules. Fixes to ordinary full-house, wheel, kicker, or tie behavior could drift between Hold'em and Pai Gow immediately.

A local **Pai Gow wrapper** is still required, but copying standard poker comparison underneath it is unnecessary now that there is a real second consumer.

### C. Unify all card models or build a generic card-arrangement/poker-rules framework — rejected

Do not refactor Texas Hold'em's `{ value, suit, rank }` model, Video Poker's Jacks-or-Better evaluator, Three-Card Showdown's three-card ordering, or Blackjack's cards. Do not introduce a configurable poker rules engine, generic split-hand UI, base game class, strategy service, or paytable framework.

Those abstractions would be configuration for hypothetical consumers rather than reuse demanded by HPA-197.

## Shared seam 1: make shuffle type-generic, not rule-generic

`src/lib/cards.ts` already owns standard 52-card creation and Fisher-Yates shuffling. Pai Gow needs to append one local Joker and shuffle a 53-card union.

Change only the shuffle signature:

```ts
export function shuffleDeck<T>(
  deck: readonly T[],
  random: () => number = Math.random,
): T[];
```

`createDeck()` and `createShuffledDeck()` remain standard-52-card functions returning `Card[]`.

This is a type-level generalization of an already generic algorithm, not a new deck framework. Do not add Joker knowledge, deck configuration, number-of-decks options, or game rules to `src/lib/cards.ts`.

## Shared seam 2: standard five-card poker comparison

Create:

```text
src/lib/five-card-poker.ts
src/lib/five-card-poker.test.ts
```

The public surface is deliberately small:

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

Rules in this shared module are **ordinary poker rules**:

- straight flush > four of a kind > full house > flush > straight > three of a kind > two pair > pair > high card;
- A-K-Q-J-10 is the highest straight;
- A-2-3-4-5 is the lowest straight and uses straight-high `5`;
- suits never break ties;
- Royal Flush is not a separate comparison category; it is the highest straight flush.

Move the existing private `rankFiveCardHand` / ranking comparison logic from `src/lib/poker/handEvaluator.ts` rather than independently rewriting it.

Texas Hold'em keeps local:

- `evaluatePreflopHand`;
- `evaluatePostflopHand`;
- draw/outs estimates;
- generation of 5-card combinations from 7 cards;
- player/community-card mapping and winner selection.

Only the exact five-card ranking/comparison implementation moves.

Do not migrate Video Poker to this module. Video Poker's evaluator intentionally owns Jacks-or-Better categories and payout semantics.

## Pai Gow card model

Create a local 53-card model without widening the shared `Card` union:

```ts
import type { Card } from '../cards';

export interface PaiGowJoker {
  rank: 'joker';
  suit: 'joker';
}

export type PaiGowCard = Card | PaiGowJoker;

export const PAI_GOW_JOKER: PaiGowJoker = {
  rank: 'joker',
  suit: 'joker',
};

export function isPaiGowJoker(card: PaiGowCard): card is PaiGowJoker;
export function createPaiGowDeck(): PaiGowCard[];
export function createShuffledPaiGowDeck(random?: () => number): PaiGowCard[];
```

Implementation:

```ts
export function createPaiGowDeck(): PaiGowCard[] {
  return [...createDeck(), PAI_GOW_JOKER];
}

export function createShuffledPaiGowDeck(
  random: () => number = Math.random,
): PaiGowCard[] {
  return shuffleDeck(createPaiGowDeck(), random);
}
```

No other game imports `PaiGowCard` or the Joker.

## Pai Gow ranking rules

The MVP uses the conventional semi-wild Joker rule:

- The Joker is an Ace by default.
- It may instead represent a card needed to complete a straight, flush, straight flush, or royal flush.
- Four natural Aces plus the Joker form Five Aces.

The five-card high-hand order is:

1. Five Aces
2. Royal Flush
3. Straight Flush
4. Four of a Kind
5. Full House
6. Flush
7. Straight
8. Three of a Kind
9. Two Pair
10. Pair
11. High Card

Pai Gow's straight ordering is intentionally not identical to ordinary poker:

- Straight: A-K-Q-J-10 is highest; A-2-3-4-5 is second highest; K-Q-J-10-9 is third.
- Straight Flush: Royal Flush is its own higher category; among non-Royal straight flushes, A-2-3-4-5 is highest, then K-Q-J-10-9, then downward.

No suit ordering breaks ties.

### Local ranking API

Keep these functions in `src/lib/pai-gow-poker/rules.ts`:

```ts
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

export function rankPaiGowFiveCardHand(
  cards: readonly PaiGowCard[],
): PaiGowHandRanking;

export function rankPaiGowTwoCardHand(
  cards: readonly PaiGowCard[],
): PaiGowHandRanking;

export function comparePaiGowRankings(
  left: PaiGowHandRanking,
  right: PaiGowHandRanking,
): -1 | 0 | 1;
```

Two-card low hands can only be Pair or High Card. In a two-card hand the Joker always acts as Ace because a two-card hand cannot complete a straight or flush.

### Joker evaluation algorithm

Do not build a configurable wildcard engine.

For a five-card hand containing the Joker:

1. Detect Four Aces + Joker directly as Five Aces.
2. Enumerate the 52 standard cards as possible Joker substitutions, excluding an exact standard card already present.
3. A substitution with rank Ace is always allowed because the Joker may act as Ace.
4. A non-Ace substitution is allowed only when the resulting hand is a Straight, Flush, Straight Flush, or Royal Flush under Pai Gow normalization.
5. Choose the highest allowed Pai Gow ranking.

There is only one Joker, so this bounded search is small and easier to verify than a wildcard rules abstraction.

## Player arrangement and foul validation

A dealt player hand always contains seven cards. The player chooses exactly two card indexes for the Low hand; the remaining five cards form the High hand.

Use indexes into the original seven-card deal as the arrangement state instead of copying/moving domain card arrays:

```ts
export type LowHandIndexes = readonly [number, number];

export interface PaiGowArrangement {
  lowIndexes: LowHandIndexes;
  high: PaiGowCard[];
  low: PaiGowCard[];
  highRanking: PaiGowHandRanking;
  lowRanking: PaiGowHandRanking;
}
```

Expose:

```ts
export function getArrangement(
  cards: readonly PaiGowCard[],
  lowIndexes: readonly number[],
): PaiGowArrangement | null;

export function getArrangementError(
  cards: readonly PaiGowCard[],
  lowIndexes: readonly number[],
): string | null;
```

Validation rules:

- exactly two distinct low-hand indexes;
- both indexes are within `0..6`;
- the remaining five cards form the High hand;
- the High hand must rank **strictly higher** than the Low hand.

If High and Low compare equal, the arrangement is fouled and cannot be confirmed.

## Dealer house way and Auto Arrange

Keep one deterministic function in its own focused file:

```text
src/lib/pai-gow-poker/house-way.ts
src/lib/pai-gow-poker/house-way.test.ts
```

```ts
export function arrangeHouseWay(
  cards: readonly PaiGowCard[],
): PaiGowArrangement;
```

The MVP does **not** reproduce a named casino's multi-page house-way chart. It uses one stable, explainable policy:

1. Enumerate all 21 ways to choose two Low-hand cards.
2. Discard fouled arrangements.
3. Prefer the arrangement with the strongest five-card High hand.
4. If High hands tie, prefer the strongest two-card Low hand.
5. If both rankings tie, prefer the lexicographically smaller original low-index pair for deterministic output.

This keeps premium five-card hands intact and avoids a large strategy rules table. The function is isolated so a more authentic house-way chart can replace it later without touching game state or UI.

The player's **Auto Arrange** button calls this same function. It is a convenience default, not an AI recommendation system.

## Comparing player and dealer

Dealer copies win, matching normal bank comparison semantics.

For each sub-hand:

```ts
const highCompare = comparePaiGowRankings(player.highRanking, dealer.highRanking);
const lowCompare = comparePaiGowRankings(player.lowRanking, dealer.lowRanking);

const playerWonHigh = highCompare > 0;
const playerWonLow = lowCompare > 0;
```

Overall outcome:

- `win`: player wins both High and Low;
- `push`: player wins exactly one of High/Low;
- `loss`: player wins neither hand, including copies/ties that go to the dealer.

There is no separate `tie` round outcome.

## Main wager and commission

Use one main wager only.

```ts
export const MIN_WAGER = 20;
export const MAX_WAGER = 500;
export const WAGER_OPTIONS = [20, 40, 100, 200, 500] as const;
export const COMMISSION_PERCENT = 5;
```

A valid wager must:

1. be a whole number;
2. pass `validateBet(wager, MIN_WAGER, MAX_WAGER)`;
3. be divisible by 20;
4. be no greater than the current balance.

Restricting wagers to 20-chip increments makes the 5% commission an exact integer number of play-money chips. No fractional-chip or rounding policy is needed.

Settlement math after the wager is deducted at Deal:

| Outcome | Gross payout credited | Net delta |
| --- | ---: | ---: |
| Player wins both | `2 * wager - wager / 20` | `wager - wager / 20` |
| Push | `wager` | `0` |
| Player loses | `0` | `-wager` |

`wager / 20` is the 5% commission on the amount won.

No Fortune Bonus, Envy Bonus, progressive, insurance, Tiger, commission-free variant, or banking is included.

## Pure game state

Create:

```text
src/lib/pai-gow-poker/game.ts
src/lib/pai-gow-poker/game.test.ts
```

State:

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

Lifecycle:

```text
betting --Deal--> arranging --Confirm--> complete --New Round--> betting
                       |  |  |
                       |  |  +-- Reset arrangement
                       |  +----- Auto Arrange
                       +-------- click cards into/out of Low hand
```

`PaiGowPokerGame` exposes:

```ts
constructor(initialBalance: number, random?: () => number)
getState(): Readonly<PaiGowPokerState>
getWagerError(wager: number): string | null
setWager(wager: number): void
deal(): void
toggleLowCard(index: number): void
autoArrange(): void
resetArrangement(): void
getArrangementError(): string | null
confirm(): PaiGowRoundResult
resetRound(): void
setBalance(balance: number): void
```

Behavior:

- Initial wager is `WAGER_OPTIONS[0]` (`20`).
- Deal validates affordability, deducts one wager, shuffles the 53-card deck, deals the first seven cards to the player and next seven to the dealer, clears selection, and enters `arranging`.
- `toggleLowCard` only runs during `arranging`, keeps indexes distinct, and never allows more than two selected cards.
- `autoArrange` sets `lowIndexes` from `arrangeHouseWay(playerCards)`.
- `resetArrangement` clears `lowIndexes` but does not redeal.
- `confirm` rejects incomplete/fouled arrangements, arranges the dealer with `arrangeHouseWay`, resolves the round, credits gross payout, stores result, and enters `complete`.
- `resetRound` clears cards/result/selection and retains the wager.
- `setBalance` is only for authoritative settlement adoption/recovery and uses the same non-negative finite balance normalization as the recent small game modules.

## Round result shape

Keep enough immutable data to render the completed round without recomputation:

```ts
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

`commission` is nonzero only on a player win.

## Page and client design

Add:

```text
src/pages/games/pai-gow-poker.astro
src/lib/pai-gow-poker/client.ts
src/lib/pai-gow-poker/client.init.test.ts
src/lib/pai-gow-poker/index.ts
```

The Astro root uses the existing public-game session contract:

```astro
<main
  id="pai-gow-poker-root"
  data-testid="pai-gow-poker-root"
  data-user-id={gameSession.clientUserId}
  data-guest-mode={gameSession.guestModeValue}
  data-initial-balance={gameSession.initialBalance}
>
```

The client creates:

```ts
const settlement = createPublicGameSettlementController({
  gameKey: 'pai-gow-poker',
  // game-local messages/callbacks
});

const game = new PaiGowPokerGame(settlement.startingBalance);
```

No game-specific settlement builder or recovery state is added.

### Card arrangement UI

Pre-render seven player card buttons, each containing an existing `CardSlot`.

During `arranging`:

- all seven cards are visible;
- buttons whose indexes are in `lowIndexes` are moved into the Low-hand container and have `aria-pressed="true"`;
- the other buttons remain in the High/unassigned container;
- once two cards are selected, the High container naturally contains five cards;
- clicking a selected Low card moves it back;
- no DOM card elements are created during interaction; the existing seven button/slot nodes are only reordered between two containers.

Dealer UI uses five High-hand slots and two Low-hand slots. They are placeholders in `betting`, face-down in `arranging`, and revealed from the dealer arrangement in `complete`.

The Joker is rendered through the existing string-based `CardData` contract without changing `CardSlot`:

```ts
const jokerDisplay = { rank: '★', suit: '★' };
```

Standard cards keep the existing J/Q/K/A rank labels.

### Controls

`betting`:

- wager buttons;
- Deal.

`arranging`:

- seven clickable cards;
- Auto Arrange;
- Reset;
- Confirm.

`complete`:

- New Round.

Confirm remains unavailable until exactly two Low cards are selected. If the selected split is fouled, show `getArrangementError()` in the live status region and do not resolve the round.

New Round is disabled while authenticated settlement is blocked.

### Settlement flow

`confirm()` resolves locally first. Then:

```ts
const result = game.confirm();
render();
await settlement.completeRound(result.netDelta, game.getState().balance);
render();
```

Guest completion persists locally only. Authenticated completion submits exactly one net round through the existing wallet controller. Retry reuses the exact pending command because that behavior already belongs to the shared controller.

## Game registration

Add `pai-gow-poker` as the eleventh `GAME_TYPES` entry:

```text
key:   pai-gow-poker
label: Pai Gow Poker
icon:  🃏
```

Update:

- `src/lib/game-stats/constants.ts`;
- fixed game-count/type guard tests;
- `src/pages/index.astro` lobby card;
- `e2e/profile-statistics.spec.ts` canonical game list.

No database migration is required because the wallet/game-stat paths validate application-level text game keys rather than a database enum.

## Testing strategy

### Shared five-card tests

Pin the extracted standard behavior:

- A-high straight beats K-high straight;
- standard wheel is 5-high and loses to 6-high;
- full house comparison uses trip rank before pair rank;
- two pair and pair kickers compare correctly;
- perfect ties compare `0`;
- existing Texas Hold'em showdown tests remain green after extraction.

### Pai Gow card/ranking tests

Cover:

- deck contains 52 unique standard cards + exactly one Joker;
- constant-zero shuffle pins the first fourteen cards as `3♥..A♥, 2♦, 3♦`;
- Four Aces + Joker => Five Aces;
- `10♠ J♠ Q♠ K♠ Joker` => Royal Flush;
- `A-2-3-4-5` straight beats K-high straight but loses to A-high straight;
- `A-2-3-4-5` straight flush is the highest non-Royal straight flush;
- Joker may complete a flush/straight but does not impersonate a non-Ace merely to create trips/full house;
- `Ace + Joker` in the two-card hand => Pair of Aces;
- two-card pair/high-card comparisons.

### Arrangement/house-way tests

Cover:

- fewer/more than two Low cards is invalid;
- duplicate/out-of-range indexes are invalid;
- High equal to or below Low is fouled;
- all 21 splits are considered implicitly through fixtures where the selected best High hand is not the first combination;
- house way prefers strongest High, then strongest Low;
- identical ranking ties use stable low-index ordering;
- Auto Arrange uses exactly the house-way low indexes.

### Payout/game-state tests

Cover:

- wager must be a whole 20-chip increment within 20..500 and affordable;
- Deal deducts exactly one wager and deals seven + seven cards;
- toggle prevents a third Low card;
- Reset clears selection only;
- Confirm rejects incomplete/fouled splits;
- win charges exactly 5% commission and produces `netDelta = wager - wager / 20`;
- push returns the wager with `netDelta = 0`;
- loss leaves the wager deducted with `netDelta = -wager`;
- New Round retains wager;
- authoritative balance adoption works in complete/recovery flow.

### Client/browser tests

Happy-DOM tests cover:

- clicked card nodes move between High and Low containers while retaining original index identity;
- `aria-pressed` follows Low selection;
- Auto Arrange populates two Low cards;
- Reset returns all cards to High/unassigned;
- dealer cards remain face-down until Confirm;
- foul message prevents completion;
- New Round is blocked while settlement is pending.

Add `e2e/pai-gow-poker.spec.ts` with one deterministic representative flow using `Math.random = () => 0` before page scripts run:

```text
Player: 3♥ 4♥ 5♥ 6♥ 7♥ 8♥ 9♥
Dealer: 10♥ J♥ Q♥ K♥ A♥ 2♦ 3♦
```

With the selected strongest-High house way:

```text
Player High: 5♥ 6♥ 7♥ 8♥ 9♥
Player Low:  3♥ 4♥
Dealer High: 10♥ J♥ Q♥ K♥ A♥
Dealer Low:  2♦ 3♦
Outcome: push
```

The guest test exercises Deal → Auto Arrange → Confirm → Push → New Round and asserts no wallet request. A second authenticated case may reuse the same fixture and assert exactly one `pai-gow-poker` settlement command with `delta: 0`; do not duplicate the shared Retry/Reset recovery matrix in this game-specific E2E.

## Scope guardrails

Do not add:

- Fortune/Envy/progressive/insurance/Tiger or any side wager;
- player banking or banker rotation;
- commission-free / Face Up Pai Gow variants;
- drag-and-drop, pointer gesture manager, or generic card-arrangement component;
- generic wildcard/Joker engine;
- configurable house-way strategy/rules versions;
- shared poker rules engine spanning Video Poker, Three-Card Showdown, and Hold'em;
- Texas Hold'em card-model migration;
- base game class/client controller;
- AI advice or LLM integration;
- ranked/daily mode, history, replay, or persistence;
- new API endpoint, database table, migration, settlement queue, automatic retry, or compatibility code.

## Scope gate

Implementation is accepted only if the shared changes remain smaller than the game-local code:

- `src/lib/cards.ts`: generic shuffle type only;
- one neutral five-card comparator extracted from already-existing Hold'em logic;
- all Joker, Pai Gow ordering, arrangement, house-way, payout, and UI behavior remains under `src/lib/pai-gow-poker/`.

If implementation starts adding options to the shared comparator for Joker rules, Pai Gow straight ordering, house-way policies, or other games, stop and move that behavior back into the Pai Gow module.
