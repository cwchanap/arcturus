# HPA-197 Focused Pai Gow Poker Design

## Summary

Build HPA-197 as the next concrete Arcturus roadmap slice: one self-contained single-player Pai Gow Poker game at `/games/pai-gow-poker`.

Keep the implementation deliberately small:

- Reuse `src/lib/cards.ts` for the standard 52-card primitive; keep the Joker Pai-Gow-local.
- Make only the existing Fisher-Yates `shuffleDeck` signature type-generic so the local 53-card union can be shuffled.
- Extract only the ordinary five-card ranking/comparison core already private inside Texas Hold'em, because Pai Gow is now a second concrete consumer.
- Keep Joker semantics, Pai Gow straight ordering, two-card Low rules, split validation, deterministic house way, round resolution, commission, game state, immutable snapshots, and UI under `src/lib/pai-gow-poker/`.
- Reuse `validateBet`, `CardSlot`, `setSlotState`, `createPublicGameSession`, and `createPublicGameSettlementController` unchanged.
- Keep one main wager only.

Do not build a generic poker engine, card-arrangement framework, wildcard engine, strategy platform, base game class, test-only hand injection hook, or new settlement layer.

## Why HPA-197 is next

HPA-198 Three-Card Showdown is complete. The remaining HPA-167 children are either explicitly deferred (`HPA-174`, `HPA-177`) or the roadmap umbrella itself. HPA-197 is therefore the next concrete backlog item.

Its only recorded blocker, HPA-545 wallet settlement simplification, is complete. HPA-198 also established two stable seams that now exist on `main`:

- `src/lib/cards.ts` for standard cards/shuffling;
- `src/lib/wallet/public-game-settlement.ts` for guest bankroll, one net authenticated settlement, balance adoption, and Retry/Reset recovery.

Three-Card Showdown also established two local structural patterns worth copying directly rather than inventing alternatives:

- pure round economics in `resolvePlayedHand(...)`;
- deep-cloned state/result snapshots at the game boundary.

## Approaches considered

### A. Small shared comparator + Pai-Gow-local rules — selected

Move the exact standard five-card rank/comparison core out of `src/lib/poker/handEvaluator.ts` into a neutral pure module. Texas Hold'em keeps its player/community-card logic, combination generation, AI heuristics, and existing card type. Pai Gow wraps the comparator with local rules.

Why:

- Texas Hold'em already has the ordinary poker comparator Pai Gow needs.
- A structural `{ rank, suit }` input works with both card shapes without migrating Hold'em's extra `value` field.
- Ordinary kicker/full-house/wheel behavior should not be copied into a second implementation now that there is a real second consumer.
- The shared API remains only two pure functions.
- Pai Gow's Joker and unusual straight ordering remain local and cannot leak into Hold'em.

### B. Copy the full comparator into Pai Gow — rejected

This avoids a shared edit but immediately duplicates ordinary full-house, straight, pair, kicker, and tie logic. That is maintenance cost with no product benefit.

### C. Unify all card/evaluator/arrangement systems — rejected

Do not migrate Texas Hold'em's `{ value, suit, rank }` card type, Video Poker's Jacks-or-Better evaluator, Three-Card Showdown's three-card ordering, or Blackjack cards. Do not add rule configuration so unrelated games can share one abstraction.

## Shared seam 1: type-generic shuffle only

`src/lib/cards.ts` already implements Fisher-Yates for standard cards. Pai Gow needs to append one local Joker and shuffle the resulting union.

Change only:

```ts
export function shuffleDeck<T>(
  deck: readonly T[],
  random: () => number = Math.random,
): T[];
```

Keep:

```ts
createDeck(): Card[];
createShuffledDeck(random?: () => number): Card[];
```

as standard-52-card APIs.

This is a type-level generalization of an already generic algorithm. Do not add Joker awareness, deck options, number-of-decks configuration, or game rules to `cards.ts`.

## Shared seam 2: ordinary five-card poker comparison

Create:

```text
src/lib/five-card-poker.ts
src/lib/five-card-poker.test.ts
```

Public API:

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

Shared rules are ordinary poker only:

- straight flush > four of a kind > full house > flush > straight > three of a kind > two pair > pair > high card;
- Broadway is straight-high `14`;
- A-2-3-4-5 is the standard 5-high wheel;
- Royal Flush is not a separate category;
- suits never break ties.

Move the existing private five-card ranking/comparison behavior from `src/lib/poker/handEvaluator.ts` rather than rewriting it independently.

The seam tests must explicitly pin the two facts the Pai Gow wrapper relies on:

```text
ordinary unsuited wheel < ordinary unsuited 6-high straight
Broadway straight flush > K-high straight flush
```

For the straight-flush case, both rankings remain category `straight-flush`; Broadway carries tie breaker `[14]` and K-high carries `[13]`. This locks Royal-collapse behavior in the neutral comparator and prevents Pai Gow-specific Royal/wheel ordering from creeping into it.

Texas Hold'em keeps local:

- preflop/postflop strength heuristics;
- draw/outs estimates;
- generation of 5-card combinations from 7 cards;
- player/community-card mapping;
- winner selection.

Do not migrate Video Poker or Three-Card Showdown to this module.

## Pai Gow-local card model

Do not widen shared `Card` with a Joker variant.

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

Implementation remains trivial:

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

No other game imports the Joker type.

## Pai Gow ranking rules

Use one conventional semi-wild Joker rule:

- Joker is Ace by default.
- It may instead represent a needed card to complete a straight, flush, straight flush, or Royal Flush.
- Four natural Aces + Joker is Five Aces.

Five-card order:

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

No suit order breaks ties.

### Exact Pai Gow straight ordering

Pai Gow intentionally differs from ordinary poker.

For `straight`, use local comparison keys:

```text
A-K-Q-J-10 -> [15]
A-2-3-4-5  -> [14]
K-Q-J-10-9 -> [13]
Q-J-10-9-8 -> [12]
...downward by ordinary high card
```

For suited straights:

```text
10-J-Q-K-A suited -> category royal-flush, tieBreakers []
A-2-3-4-5 suited  -> category straight-flush, tieBreakers [14]
K-Q-J-10-9 suited -> category straight-flush, tieBreakers [13]
...downward by ordinary high card
```

These synthetic tie breakers exist only inside the Pai Gow wrapper. The neutral comparator keeps standard wheel/Royal-collapse behavior.

### Local rules API

Keep under `src/lib/pai-gow-poker/rules.ts`:

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

Two-card Low hands can only be Pair or High Card. In a two-card hand, Joker always acts as Ace because no straight/flush can be completed.

### Joker evaluation algorithm

Do not build a configurable wildcard engine.

For a five-card hand containing Joker:

1. Detect Four Aces + Joker directly as Five Aces.
2. Enumerate the 52 standard cards as candidate Joker substitutions.
3. Skip an exact standard card already present.
4. Any Ace substitution is allowed because Joker may act as Ace.
5. A non-Ace substitution is allowed only when the resulting Pai Gow category is Straight, Flush, Straight Flush, or Royal Flush.
6. Normalize each accepted result to the exact Pai Gow ordering above.
7. Keep the highest accepted ranking.

There is one Joker and only 52 candidates, so bounded enumeration is smaller and safer than introducing wildcard-policy machinery.

## Player arrangement and foul validation

A player receives seven cards and chooses exactly two original deal indexes for Low. The other five cards form High.

Use indexes as arrangement state rather than duplicating/moving domain card arrays:

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

Validation:

- exactly seven dealt cards;
- exactly two Low indexes;
- distinct indexes in `0..6`;
- remaining five cards become High;
- High ranking must compare **strictly greater** than Low ranking.

Equal or lower High is a foul and cannot be confirmed.

## Dealer house way and Auto Arrange

Keep one deterministic function:

```text
src/lib/pai-gow-poker/house-way.ts
src/lib/pai-gow-poker/house-way.test.ts
```

```ts
export function arrangeHouseWay(
  cards: readonly PaiGowCard[],
): PaiGowArrangement;
```

The MVP deliberately does not reproduce a named casino's long house-way chart. It uses one stable policy:

1. Enumerate all 21 ways to choose two Low cards.
2. Discard fouled arrangements.
3. Prefer the strongest five-card High hand.
4. If High ties, prefer the strongest two-card Low hand.
5. If both rankings tie, prefer the lexicographically smaller original Low-index pair.

The player's **Auto Arrange** button calls the same function. It is convenience, not an AI subsystem.

## Pure round resolver

Do not calculate round outcome or commission inside `PaiGowPokerGame.confirm()`.

Keep the complete round economics next to the ranking helpers in `src/lib/pai-gow-poker/rules.ts`:

```ts
export function resolvePaiGowRound(
  player: PaiGowArrangement,
  dealer: PaiGowArrangement,
  wager: number,
): PaiGowRoundResult;
```

It owns:

```ts
const playerWonHigh =
  comparePaiGowRankings(player.highRanking, dealer.highRanking) > 0;
const playerWonLow =
  comparePaiGowRankings(player.lowRanking, dealer.lowRanking) > 0;
```

Dealer copies win because only strict positive comparisons count as player wins.

Outcome:

- `win`: player wins both;
- `push`: player wins exactly one;
- `loss`: player wins neither, including dealer copies/ties.

Economics:

```text
win  -> commission = wager / 20
        grossPayout = 2 * wager - commission
        netDelta = wager - commission

push -> commission = 0
        grossPayout = wager
        netDelta = 0

loss -> commission = 0
        grossPayout = 0
        netDelta = -wager
```

For wager `20`, focused resolver tests pin:

```text
win  -> +19 net, commission 1, gross 39
push ->   0 net, commission 0, gross 20
loss -> -20 net, commission 0, gross 0
```

Construct the player/dealer arrangements directly in unit tests. Do not hunt for RNG sequences and do not add `setHands`, deck injection, or any production test hook.

## Main wager and commission

One main wager only:

```ts
export const MIN_WAGER = 20;
export const MAX_WAGER = 500;
export const WAGER_OPTIONS = [20, 40, 100, 200, 500] as const;
export const COMMISSION_PERCENT = 5;
```

A wager must:

1. be a whole number;
2. pass `validateBet(wager, 20, 500)`;
3. be divisible by 20;
4. be affordable from current balance.

Twenty-chip increments make 5% commission an exact integer chip amount, avoiding a fractional/rounding policy.

No Fortune/Envy/progressive/Tiger/insurance side wager, commission-free variant, or banking.

## Result shape

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

Commission is nonzero only on a player win.

## Pure game state and immutable snapshots

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
                       |  |  +-- Reset
                       |  +----- Auto Arrange
                       +-------- click cards into/out of Low
```

Public API:

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

- initial wager is `20`;
- Deal validates affordability, deducts one wager, deals first seven cards to player and next seven to dealer, clears selection, enters `arranging`;
- `toggleLowCard` keeps unique indexes and never allows a third selected card;
- Auto Arrange adopts `arrangeHouseWay(playerCards).lowIndexes`;
- Reset clears Low selection only;
- Confirm rejects incomplete/fouled splits;
- Confirm builds the current player arrangement, house-ways the dealer, calls `resolvePaiGowRound(player, dealer, wager)`, credits only `result.grossPayout`, stores the completed result, and enters `complete`;
- New Round clears cards/result/selection and retains wager;
- `setBalance` only adopts a validated authoritative balance after settlement/recovery.

`Readonly<PaiGowPokerState>` is not treated as sufficient isolation. Match the Three-Card Showdown boundary: `getState()` returns a deep clone of mutable nested data, and `confirm()` returns a deep clone that does not alias the stored result.

Private clone helpers in `game.ts` are enough:

```text
clone card objects
clone lowIndexes arrays
clone ranking tieBreakers
clone arrangement high/low arrays
clone round result
```

No generic immutable-state utility is added.

Tests must mutation-probe the contract:

- mutate a returned `playerCards` card and splice/change returned `lowIndexes`; the next `getState()` is unchanged;
- mutate a returned `confirm()` result's card/index/ranking tieBreakers; the next `getState().result` is unchanged;
- mutate a returned `getState().result`; a subsequent `getState().result` is unchanged.

## Page and client

Add:

```text
src/pages/games/pai-gow-poker.astro
src/lib/pai-gow-poker/client.ts
src/lib/pai-gow-poker/client.init.test.ts
src/lib/pai-gow-poker/index.ts
```

Use the established public-game root contract:

```astro
<main
  id="pai-gow-poker-root"
  data-testid="pai-gow-poker-root"
  data-user-id={gameSession.clientUserId}
  data-guest-mode={gameSession.guestModeValue}
  data-initial-balance={gameSession.initialBalance}
>
```

The client composes:

```ts
const settlement = createPublicGameSettlementController({
  gameKey: 'pai-gow-poker',
  // game-local messages/callbacks
});
const game = new PaiGowPokerGame(settlement.startingBalance);
```

No game-specific wallet/recovery layer is added.

### Click/select arrangement UI

Pre-render seven player card buttons, each containing an existing `CardSlot`.

During `arranging`:

- all seven cards are face-up;
- selected indexes are moved into the Low container and get `aria-pressed="true"`;
- other cards remain in High/unassigned;
- after two Low selections, High naturally contains five cards;
- clicking a selected card moves it back;
- the same seven DOM button/slot nodes are reordered between containers; no card HTML is created during interaction.

Dealer uses five High slots + two Low slots: placeholders in betting, face-down while player arranges, revealed after Confirm.

Joker uses the existing string `CardData` renderer through a local adapter:

```ts
{ rank: '★', suit: '★' }
```

`getSuitSymbol` already falls back to the raw string, so `CardSlot` needs no change.

Controls:

```text
betting:   wager buttons + Deal
arranging: cards + Auto Arrange + Reset + Confirm
complete:  New Round
```

Confirm shows the current arrangement error instead of resolving a foul. New Round is disabled while authenticated settlement is blocked.

### Settlement

Confirm resolves locally first:

```ts
const result = game.confirm();
render();
await settlement.completeRound(result.netDelta, game.getState().balance);
render();
```

Guest completion stays in local bankroll storage. Authenticated completion sends exactly one sign-derived net round through the existing wallet controller. Existing shared tests continue to own Retry/Reset/exact-command recovery behavior.

## Game registration

Add the eleventh game:

```text
key:   pai-gow-poker
label: Pai Gow Poker
icon:  🃏
```

Update:

- `src/lib/game-stats/constants.ts`;
- fixed game-count/type-guard tests;
- `src/pages/index.astro` lobby card;
- `e2e/profile-statistics.spec.ts` canonical list.

`src/pages/games/index.astro` remains only its existing redirect to `/#games`; do not add a second lobby there.

No database migration is required; game keys are application-validated text.

## Deterministic acceptance fixture

`Math.random = () => 0` on the 53-card deck yields:

```text
Player: 3♥ 4♥ 5♥ 6♥ 7♥ 8♥ 9♥
Dealer: 10♥ J♥ Q♥ K♥ A♥ 2♦ 3♦
```

The selected High-first house way produces:

```text
Player High: 5♥ 6♥ 7♥ 8♥ 9♥
Player Low:  3♥ 4♥
Dealer High: 10♥ J♥ Q♥ K♥ A♥
Dealer Low:  2♦ 3♦
```

Player loses High, wins Low, so the representative round is a Push. At wager 20, balance moves `1000 -> 980 -> 1000`.

Use this fixture for the game lifecycle, Happy-DOM, and guest E2E spine. Win/loss payout arithmetic belongs to `resolvePaiGowRound` unit tests, not RNG-dependent `confirm()` tests.

Guest E2E covers Deal -> Auto Arrange -> Confirm -> Push -> New Round and proves no wallet request. One authenticated case proves exactly one `pai-gow-poker` settlement with `delta: 0`; it does not duplicate the generic settlement recovery matrix.

## Testing focus

Pure tests cover:

- 53-card uniqueness + deterministic shuffle;
- standard comparator seam: unsuited wheel below 6-high and Broadway straight flush above K-high straight flush;
- Five Aces, Royal, Joker restrictions, exact Pai Gow straight/SF ordering;
- two-card Joker-as-Ace behavior;
- incomplete/duplicate/out-of-range/fouled arrangement validation;
- all-21-split house-way selection, High-first/Low-second/stable-index tie breakers;
- `resolvePaiGowRound` win/push/loss arithmetic with constructed arrangements;
- wager increment/affordability;
- zero-RNG Deal, click selection, Auto Arrange, Reset, Push Confirm, New Round, balance adoption;
- immutable state/result snapshot mutation probes.

Happy-DOM covers node identity/movement, `aria-pressed`, dealer reveal timing, foul message, settlement-blocked New Round, and one representative Push confirm.

Playwright covers the deterministic guest Push, one authenticated `delta: 0` settlement, and profile statistics registration.

## Scope guardrails

Do not add:

- Fortune/Envy/progressive/Tiger/insurance or any side wager;
- banking or banker rotation;
- commission-free / Face Up Pai Gow variants;
- drag-and-drop or pointer gesture manager;
- generic card-arrangement component;
- generic wildcard/Joker engine;
- configurable/versioned house-way strategy;
- poker rules framework spanning Hold'em, Video Poker, and Three-Card Showdown;
- Hold'em card-model migration;
- base game class/client controller;
- AI/LLM coaching;
- ranked/daily mode, history, replay, persistence;
- test-only hand/deck injection beyond the existing `random` callback;
- new API, table, migration, settlement queue, automatic retry, or compatibility code.

## Scope gate

The only shared runtime edits allowed by this design are:

1. make `shuffleDeck` type-generic without changing its algorithm;
2. extract the ordinary five-card comparator already present in Hold'em.

Everything about Joker, Pai Gow ordering, split validity, house way, round resolution, commission, game lifecycle, immutable snapshots, and arrangement UI remains under `src/lib/pai-gow-poker/` plus normal route/lobby/game-registration integration.

If the shared comparator starts accepting Pai Gow/Joker/options, or implementation starts extracting generic arrangement/strategy/immutability layers, simplify before merge.
