# HPA-197 Focused Pai Gow Poker Design

## Summary

Build one self-contained single-player Pai Gow Poker game at `/games/pai-gow-poker`.

Keep the implementation small and concrete:

- reuse `src/lib/cards.ts` for the standard 52-card primitive;
- keep the Joker and every Pai Gow-specific rule local;
- extract only the ordinary five-card comparison logic already private in Texas Hold'em;
- make only the existing Fisher-Yates `shuffleDeck` signature type-generic so the local 53-card union can be shuffled;
- reuse `validateBet`, `CardSlot`, `setSlotState`, `createPublicGameSession`, and `createPublicGameSettlementController` unchanged;
- keep one main wager only.

Do not add a generic poker engine, wildcard engine, arrangement framework, configurable house-way platform, base game class, test-only hand injection hook, or new settlement layer.

## Why this is the next slice

HPA-198 is complete. HPA-174 and HPA-177 remain explicitly deferred, while HPA-167 is the roadmap umbrella. HPA-197 is the next concrete unblocked child.

HPA-545 already provides the wallet settlement boundary. HPA-198 also established useful local patterns that Pai Gow should copy directly:

- pure round economics outside the game class;
- deep-cloned state/result snapshots;
- pre-rendered card slots with game-local client composition.

## Shared seam 1: ordinary five-card poker comparison

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

This module owns ordinary poker only:

- straight flush > four of a kind > full house > flush > straight > three of a kind > two pair > pair > high card;
- Broadway is straight-high `14`;
- A-2-3-4-5 is the standard 5-high wheel;
- Royal Flush is not a separate category;
- suits never break ties.

The extraction is a behavior-preserving rewrite, not a blind mechanical move. Before deleting the old numeric `HandRank` / private comparator, add a Hold'em characterization through `determineShowdownWinners` proving a Broadway straight flush beats a lower straight flush. Then pin the neutral module itself with:

```text
ordinary unsuited wheel < ordinary unsuited 6-high straight
Broadway straight flush > K-high straight flush
```

For the second case both rankings remain `straight-flush`; tie breakers are `[14]` and `[13]`.

Texas Hold'em keeps its existing `{ value, suit, rank }` card type, 7-card combination search, player/community mapping, heuristics, outs, and winner selection. Video Poker and Three-Card Showdown keep their own evaluators.

## Shared seam 2: type-generic Fisher-Yates signature

`src/lib/cards.ts` already contains the correct Fisher-Yates implementation. Do not create a separate task or runtime abstraction for this change.

When the Pai Gow deck becomes a real consumer, change only:

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

as standard-52-card APIs. No Joker or configurable-deck knowledge enters `cards.ts`.

## Pai Gow-local cards

Do not widen shared `Card`.

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

Implementation stays trivial:

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

## Pai Gow hand rules

Use the conventional semi-wild Joker rule:

- Joker is Ace by default.
- It may instead complete a straight, flush, straight flush, or Royal Flush.
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

Pai Gow straight order is local and intentionally differs from ordinary poker:

```text
Straight:
A-K-Q-J-10 -> [15]
A-2-3-4-5  -> [14]
K-Q-J-10-9 -> [13]
then downward by ordinary high card

Suited:
A-K-Q-J-10 -> royal-flush
A-2-3-4-5  -> straight-flush [14]
K-Q-J-10-9 -> straight-flush [13]
then downward
```

No suit ordering breaks ties.

### Local ranking API

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

Two-card Low can only be Pair or High Card. Joker always acts as Ace in Low.

### Cross-size comparison contract

`comparePaiGowRankings` must work for all three actual consumers:

- High vs dealer High (5 vs 5);
- Low vs dealer Low (2 vs 2);
- High vs Low during arrangement validation (5 vs 2).

Algorithm:

1. compare category strength;
2. compare tie breakers element-by-element over `min(left.length, right.length)`;
3. if the shared prefix ties, the longer tie-breaker array ranks higher;
4. equal lengths with equal values are a true tie.

This makes legal cross-size cases explicit:

```text
High K-Q-7-5-3 > Low K-Q
High 9-9-K-7-3 > Low 9-9
```

Do not use the Three-Card comparator loop unchanged; reading beyond the shorter array would produce `NaN` and silently reverse these cases.

### Joker evaluation

Do not add wildcard-policy machinery.

For a five-card hand containing Joker:

1. detect Four Aces + Joker directly as Five Aces;
2. enumerate the 52 standard cards as substitutions;
3. skip an exact standard card already present;
4. an Ace substitution is always allowed;
5. a non-Ace substitution is allowed only if the resulting hand is Straight, Flush, Straight Flush, or Royal Flush;
6. normalize to the local Pai Gow ordering;
7. keep the highest allowed ranking.

One Joker and 52 candidates is bounded and easy to verify.

## Arrangement and foul validation

A player gets seven cards and chooses exactly two original indexes for Low. The other five become High.

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

- exactly seven cards;
- exactly two distinct Low indexes in `0..6`;
- the remaining five cards are High;
- High must compare **equal to or higher than** Low.

Therefore only `comparePaiGowRankings(high, low) < 0` is a foul. Equality is legal at the arrangement boundary.

Dealer-copy semantics are separate: during player-vs-dealer resolution a sub-hand is won only by a strict positive comparison.

## Deterministic house way and Auto Arrange

Keep one pure function:

```ts
export function arrangeHouseWay(
  cards: readonly PaiGowCard[],
): PaiGowArrangement;
```

Still enumerate all 21 Low pairs and discard fouls. Do not implement a casino-specific rule chart.

The original High-first objective is replaced because it strands weak Low hands on common Full House and Two Pair holdings.

Use this small heuristic:

1. enumerate all valid arrangements;
2. determine whether any arrangement can preserve the strongest available High whose category is one of:
   - `straight`
   - `flush`
   - `straight-flush`
   - `royal-flush`;
3. if such a protected made High exists, restrict candidates to arrangements with that exact best protected High ranking;
4. from the remaining candidates, choose strongest Low;
5. then strongest High;
6. then lexicographically smaller Low indexes.

If there is no protected made High, skip step 2/3 and simply choose strongest Low, then High, then indexes.

Pin at least:

```text
A A A K K 7 3 -> High AAA73, Low KK
9 9 5 5 K 7 3 -> High 99K73, Low 55
A K Q 9 7 5 3 -> High A9753, Low KQ
3♥ 4♥ 5♥ 6♥ 7♥ 8♥ 9♥ -> High 5♥..9♥, Low 3♥4♥
```

This is deliberately a small, replaceable heuristic. Do not grow it into a table for quads, five aces, pair tiers, or venue-specific exceptions in HPA-197.

## Pure round resolver

Keep outcome and payout math out of the game class:

```ts
export function resolvePaiGowRound(
  player: PaiGowArrangement,
  dealer: PaiGowArrangement,
  wager: number,
): PaiGowRoundResult;
```

Sub-hand wins use strict positive comparisons:

```ts
const wonHigh =
  comparePaiGowRankings(player.highRanking, dealer.highRanking) > 0;
const wonLow =
  comparePaiGowRankings(player.lowRanking, dealer.lowRanking) > 0;
```

Outcome:

- win both -> `win`;
- win exactly one -> `push`;
- win neither -> `loss`.

Dealer copies therefore count against the player without changing arrangement legality.

## Wager and commission

Keep the control simple but do not let chip arithmetic force a 20-chip minimum.

```ts
export const MIN_WAGER = 5;
export const MAX_WAGER = 100;
export const WAGER_OPTIONS = [5, 10, 20, 50, 100] as const;
```

A wager must:

1. be a whole number;
2. pass `validateBet(wager, 5, 100)`;
3. be affordable.

No divisibility rule.

On a win:

```ts
const commission = Math.ceil(wager * 0.05);
const grossPayout = wager * 2 - commission;
const netDelta = wager - commission;
```

Push:

```text
commission = 0
grossPayout = wager
netDelta = 0
```

Loss:

```text
commission = 0
grossPayout = 0
netDelta = -wager
```

The minimum is 5 rather than 1 because `Math.ceil(5%)` on a 1-chip wager would consume the entire profit of a win. Wager 20 remains the deterministic acceptance fixture and yields commission 1 / net `+19` on a win.

No side bets, banking, or commission-free variant.

## Game state and immutable snapshots

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

`PaiGowPokerGame`:

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

Lifecycle:

```text
betting -> Deal -> arranging -> Confirm -> complete -> New Round -> betting
                         |-> Auto Arrange
                         |-> Reset
                         |-> toggle Low card
```

Behavior:

- initial wager is 5;
- Deal deducts one wager, deals first seven cards to player and next seven to dealer, clears selection, enters arranging;
- `toggleLowCard` keeps unique sorted indexes and never accepts a third selected card;
- Auto Arrange adopts `arrangeHouseWay(playerCards).lowIndexes`;
- Reset clears Low selection only;
- Confirm validates the player split, arranges dealer once, calls `resolvePaiGowRound`, credits gross payout, stores a cloned result, enters complete;
- New Round clears cards/selection/result but retains wager;
- `setBalance` adopts the authoritative wallet balance.

`confirm()` must not compare sub-hands or calculate commission itself.

### Snapshot contract

`getState()` returns independent copies of:

- player/dealer card objects;
- Low index array;
- result;
- player/dealer arrangements;
- High/Low arrays inside arrangements;
- ranking objects and `tieBreakers` arrays.

`confirm()` also returns a deep clone, not the internal stored result.

Tests must mutate returned cards, Low indexes, and result ranking tie breakers and prove the next `getState()` is unchanged. Keep clone helpers private to `game.ts`; do not add a shared immutable-state utility.

## Client and page

Add:

```text
src/pages/games/pai-gow-poker.astro
src/lib/pai-gow-poker/client.ts
src/lib/pai-gow-poker/client.init.test.ts
src/lib/pai-gow-poker/index.ts
```

Use the established public-game root data attributes and compose `createPublicGameSettlementController` unchanged.

### Stable selection UI

Pre-render seven player card buttons in one stable row. Do **not** reparent them during render.

Each button keeps its DOM position and uses:

```text
aria-pressed="true|false"
data-low="true|false"
```

to represent whether the card belongs to Low. High is the five unselected cards.

This preserves keyboard focus between the first and second Low selection and removes the need for a node-identity/movement contract.

Dealer High/Low slots remain separate because the dealer arrangement is only revealed after Confirm.

Joker display is a local adapter:

```ts
{ rank: '★', suit: '★' }
```

`getSuitSymbol` already falls back to the raw string; no `CardSlot` or formatter change is needed.

### Arrangement feedback

The player must see what the current split means while arranging.

Keep a local label map in `client.ts`:

```ts
const CATEGORY_LABELS: Record<PaiGowCategory, string> = {
  'five-aces': 'Five Aces',
  'royal-flush': 'Royal Flush',
  'straight-flush': 'Straight Flush',
  'four-of-kind': 'Four of a Kind',
  'full-house': 'Full House',
  flush: 'Flush',
  straight: 'Straight',
  'three-of-kind': 'Three of a Kind',
  'two-pair': 'Two Pair',
  pair: 'Pair',
  'high-card': 'High Card',
};
```

Do not add a `label` field to the domain ranking.

When exactly two Low cards are selected:

- if the arrangement is valid, status includes `High: <name> · Low: <name>`;
- if it is foul, status shows the arrangement error;
- with fewer than two selected, status prompts the player to choose two Low cards.

## Settlement

After local Confirm:

```ts
const result = game.confirm();
render();
await settlement.completeRound(result.netDelta, game.getState().balance);
render();
```

Guest play remains local. Authenticated play produces exactly one sign-derived settlement. Push sends `delta: 0`; shared wallet tests continue to own retry/reset/exact-command behavior.

No additional gate, queue, retry policy, or persistence.

## Registration

Add the eleventh game:

```text
key:   pai-gow-poker
label: Pai Gow Poker
icon:  ☯️
```

Use a distinct icon rather than Blackjack's `🃏`.

Update:

- `src/lib/game-stats/constants.ts` and fixed count/type guard tests;
- `src/pages/index.astro` lobby card;
- `e2e/profile-statistics.spec.ts` canonical list.

`src/pages/games/index.astro` remains only a redirect and is not a lobby integration point.

No database migration is required.

## Deterministic acceptance fixture

`Math.random = () => 0` on the 53-card deck yields:

```text
Player: 3♥ 4♥ 5♥ 6♥ 7♥ 8♥ 9♥
Dealer: 10♥ J♥ Q♥ K♥ A♥ 2♦ 3♦
```

House way:

```text
Player High: 5♥ 6♥ 7♥ 8♥ 9♥
Player Low:  3♥ 4♥
Dealer High: 10♥ J♥ Q♥ K♥ A♥
Dealer Low:  2♦ 3♦
```

Player loses High and wins Low -> Push.

At wager 20:

```text
1000 -> 980 after Deal -> 1000 after Confirm
```

Guest E2E covers Deal -> Auto Arrange -> Confirm -> Push -> New Round and proves no wallet request. One authenticated case proves one `pai-gow-poker` settlement with `delta: 0`.

## Testing focus

Pure tests cover:

- neutral Hold'em Royal-vs-lower-SF characterization before extraction;
- neutral wheel-low and Royal-collapse comparator behavior;
- 53-card uniqueness + deterministic shuffle;
- Five Aces, Joker restrictions, exact Pai Gow straight ordering;
- cross-size comparison using `KQ753 > KQ` and pair-9 High > pair-9 Low;
- incomplete/duplicate/out-of-range/fouled arrangement validation;
- Full House / Two Pair / no-pair / protected-straight house-way fixtures;
- resolver win/push/loss including wager-20 `+19 / 0 / -20`;
- wager bounds/affordability without divisibility rules;
- Deal, selection, Auto Arrange, Reset, Confirm, New Round, balance adoption;
- immutable snapshot mutation probes.

Happy-DOM covers stable focused card buttons, `aria-pressed`, `data-low`, live High/Low category copy, dealer reveal timing, foul message, and settlement-blocked New Round.

Playwright covers deterministic guest Push, one authenticated delta-0 settlement, and profile statistics registration.

## Validation

Final implementation validation runs:

```bash
bun run test
bun run lint
bun run format:check
bun run build
bunx playwright test e2e/pai-gow-poker.spec.ts e2e/profile-statistics.spec.ts --workers=1
bunx tsc --noEmit
```

The repository has historical TypeScript debt and no package `typecheck` script. Capture the current-main `tsc --noEmit` output before implementation and reject any **new touched-path errors** introduced by HPA-197; do not turn this game ticket into a cleanup of unrelated existing errors.

## Scope gate

The only shared runtime edits are:

1. extract the ordinary five-card comparator already private in Hold'em;
2. make the existing Fisher-Yates shuffle signature type-generic when Pai Gow consumes it.

Everything else stays in `src/lib/pai-gow-poker/` plus normal route/lobby/game-registration integration.

Reject any implementation that adds:

- side bets or banking;
- commission-free variants;
- drag/reparenting infrastructure;
- generic card-arrangement or wildcard engines;
- configurable/versioned house-way rules;
- Hold'em card-model migration;
- base game/client classes;
- AI/ranked/history/replay;
- new API/schema/settlement queues;
- automatic retry policy;
- compatibility adapters or production hand/deck test hooks.
