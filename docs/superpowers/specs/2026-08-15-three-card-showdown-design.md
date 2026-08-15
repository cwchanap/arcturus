# HPA-198 Three-Card Showdown Design

## Summary

Build HPA-198 as the next small single-player Arcturus game: a focused Ante → Fold/Play → result loop at `/games/three-card-showdown`.

The design stays deliberately small:

- Extract only Video Poker's neutral 52-card `Card`/deck helpers into `src/lib/cards.ts`, because Three-Card Showdown becomes the second clean consumer.
- Keep three-card ranking, dealer qualification, payout resolution, state, settlement mapping, and UI behavior inside `src/lib/three-card-showdown/`.
- Reuse the existing `validateBet`, public-game session, wallet settlement/recovery, `CardSlot`, and `setSlotState` seams unchanged.
- Add no database table, API route, server-authoritative card flow, generic poker evaluator, base game class, client controller, paytable engine, strategy layer, history, AI, ranked mode, side bet, or compatibility path.

HPA-198 is a better next slice than HPA-197 Pai Gow Poker because it adds one wager and one decision rather than seven-card arrangement, foul validation, and dealer house-way UI.

## Why this is actionable now

The HPA-167 architecture sequence is complete: private-room Poker isolation, wallet settlement simplification, BYOK AI cleanup, Video Poker, Blackjack Run consolidation, and Sic Bo have landed.

The other open roadmap children are either explicitly deferred (`HPA-174`, `HPA-177`) or a larger future game (`HPA-197`). HPA-198 is therefore the smallest unblocked slice that continues the single-player modular direction.

## Reuse decisions

### Share only the neutral card/deck primitive

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

Then update Video Poker to consume the shared file and delete `src/lib/video-poker/cards.ts` and its test.

`src/lib/video-poker/types.ts` must keep its existing card types importable because current Video Poker tests import `Card`, `Rank`, and `Suit` from that file. Preserve that module surface with a direct type re-export from `../cards`:

```ts
import type { Card } from '../cards';
export type { Card, Rank, Suit } from '../cards';
```

This is not a compatibility wrapper for the deleted `video-poker/cards.ts`; it is the existing public type surface of `video-poker/types.ts` pointing at the new neutral owner.

Do **not** refactor `src/lib/poker/**`. Texas Hold'em uses a different `{ value, suit, rank }` card shape and is coupled to its current engine. Blackjack also has its own string-rank representation. HPA-198 does not unify either one.

Do **not** share an evaluator. Video Poker's five-card Jacks-or-Better evaluator has different category ordering and payout semantics; Three-Card Showdown specifically ranks Straight above Flush.

### Reuse existing card presentation

Reuse:

- `src/components/CardSlot.astro`
- `src/lib/card-slot-utils.ts` / `setSlotState()`

The page owns six slots directly. Player cards are face-up after Deal. Dealer cards are facedown during `decision` and face-up at `complete` for both Fold and Play.

No generic card-row component is needed.

### Reuse wager validation, with one game-local affordability rule

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

The third rule guarantees that after Deal the equal Play wager is always affordable. It removes a second decision-state error path.

### Reuse public-game session and guest bankroll literally

Reuse:

- `createPublicGameSession()`
- `loadGuestBankroll()`
- `persistGuestBankroll()`
- `isGuestModeValue()`
- `shouldSyncAccountChips()`

Use game key `three-card-showdown` for guest storage and game statistics.

The Astro root contract is not optional. `isGuestModeValue()` recognizes only the literal string `true`, so copy the current Video Poker/Sic Bo session dataset shape onto the root:

```astro
<main
  id="three-card-showdown-root"
  data-testid="three-card-showdown-root"
  data-user-id={gameSession.clientUserId}
  data-guest-mode={gameSession.guestModeValue}
  data-initial-balance={gameSession.initialBalance}
>
```

The client reads those attributes to decide guest versus authenticated behavior. Missing them would incorrectly send guest rounds through `/api/wallet/settle` and skip guest bankroll persistence.

### Reuse the existing wallet gate unchanged

Use:

- `newSettlementId(game)`
- `createSettlementGate()`
- `ensureSettlementRecoveryControls()`
- `SettleRoundCommand`
- `SettleRoundResult`

Every completed Fold or Play creates exactly one logical authenticated settlement. Retry reuses the exact pending command and settlement ID through the existing gate. Guest completion is local-only.

Keep command construction game-local:

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

`gameType` persistence needs no schema change. The operative runtime registry is `GAME_TYPES`: wallet settlement validation already rejects values that fail `isValidGameType()`.

Successful wallet adoption must match current Video Poker/Sic Bo behavior, including achievement forwarding:

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

Do not make this game silently drop achievements already granted by the shared settlement service.

## Alternatives considered

### A. Minimal shared cards + local Three-Card module — selected

This removes one real duplication now that there are two clean consumers while keeping game semantics isolated.

### B. Duplicate Video Poker's deck — rejected

The exact same 52-card model and Fisher-Yates helper would immediately exist twice. That is now a real shared primitive rather than hypothetical reuse.

### C. Reuse/refactor Texas Hold'em Poker internals — rejected

That would turn HPA-198 into an unrelated legacy Poker refactor and increase coupling.

### D. Build a configurable poker evaluator — rejected

Three-card ranking differs from five-card poker, notably Straight > Flush. A generic evaluator adds configuration for a problem the repository does not have.

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

For the canonical guest fixture with a 1,000-chip start and Ante 10:

```text
before Deal: 1000
Deal:        990
Play stake:  980
```

If the dealer wins, there is no payout and the final balance remains 980.

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

Gross payout includes returned stake: deduct wagers first, then credit gross payout.

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

## Domain APIs

`types.ts` owns only Three-Card domain types. `rules.ts` exposes:

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

The game owns deck/deal order and local balance math. Rules code has no bankroll, DOM, fetch, storage, or wallet dependency.

## Client/page design

`client.ts` owns only DOM rendering, guest persistence, and wallet composition.

Responsibilities:

- read the exact root dataset described above;
- initialize `ThreeCardShowdownGame` with guest-stored or account balance;
- render cards through `setSlotState()`;
- render dealer as facedown in `decision` and face-up in `complete`;
- wire Ante, Deal, Fold, Play, and New Round;
- persist guest balance after Fold or Play and make no wallet request;
- submit one authenticated settlement;
- adopt returned authoritative balance and dispatch `achievement-earned` when present;
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
- Player win: `Player wins · +<netDelta> net`
- Tie: `Tie · 0 net`
- Dealer win: `Dealer wins · <netDelta> net`

No animation, sound, odds, strategy hints, drag/drop, history, or bonus-paytable UI.

## Game registration

Add `three-card-showdown` as the tenth entry in `src/lib/game-stats/constants.ts`:

```ts
GAME_TYPE_LABELS['three-card-showdown'] = 'Three-Card Showdown';
GAME_TYPE_ICONS['three-card-showdown'] = '♠️';
```

Use the already-proven `♠️` icon.

Update the existing `game-stats.test.ts` constants test so it explicitly checks:

```ts
expect(GAME_TYPES).toContain('three-card-showdown');
expect(GAME_TYPES.length).toBe(10);
expect(isValidGameType('three-card-showdown')).toBe(true);
expect(GAME_TYPE_LABELS['three-card-showdown']).toBe('Three-Card Showdown');
expect(GAME_TYPE_ICONS['three-card-showdown']).toBe('♠️');
```

Update the fixed canonical game list in `e2e/profile-statistics.spec.ts` and add a normal lobby card in `src/pages/index.astro`.

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
- successful initial settlement or Retry adopts balance and forwards achievements;
- Reset clears the gate, restores the last server-synced balance, discards the failed completed round, and returns to `betting`.

No timer, auto-retry, pending-command persistence, outbox, background sync, or cross-tab coordination.

## Testing

### Shared cards / Video Poker regression

Move Video Poker's deck tests to `src/lib/cards.test.ts` and cover:

- 52 unique cards;
- all ranks/suits;
- deterministic injectable shuffle;
- source deck is not mutated.

Keep `Card`, `Rank`, and `Suit` importable from `src/lib/video-poker/types.ts`, then run all Video Poker tests after the move.

### Rules and game state

Cover:

- every category and exact category order;
- Straight > Flush;
- A-K-Q highest, A-2-3 lowest, K-A-2 not straight;
- pair/high-card/flush tie breakers and suit-insensitive ties;
- Q-high qualifies / J-high does not;
- all four Play payout outcomes;
- Ante bounds/integer/two-unit affordability;
- Deal deducts one Ante and produces six unique cards;
- Fold loses one Ante only;
- Play deducts the second Ante and resolves exactly once;
- New Round retains Ante but clears cards/result;
- authoritative `setBalance()` and invalid transitions.

### Client composition

Keep `client.test.ts` to settlement-command mapping.

`client.init.test.ts` covers composition only:

- exact root dataset drives guest mode;
- Deal renders player cards and facedown dealer cards;
- guest Play persists final balance and makes no wallet request;
- guest Fold produces `Fold · -10 net`, leaves a 1,000 start at 990, persists 990, makes no wallet request, and reveals dealer cards at `complete`;
- settlement blocks New Round;
- Retry reuses the exact command, adopts authoritative balance, and dispatches one `achievement-earned` event when `newAchievements` is returned;
- Reset restores last server balance.

Do not duplicate wallet-gate internal tests.

### E2E

Use two representative flows.

**Guest deterministic flow:** before Deal, assert the root has `data-testid="three-card-showdown-root"` and `data-guest-mode="true"`, and balance is 1,000. Set `Math.random = () => 0`, select Ante 10, and Deal. Fisher-Yates with constant zero is pinned to player `3♥ 4♥ 5♥` and dealer `6♥ 7♥ 8♥`. After Deal, assert balance 990, player cards face-up, and dealer cards facedown. Click Play, then assert `Dealer wins · -20 net`, final balance 980, dealer reveal, and zero `/api/wallet/settle` requests. New Round returns to betting.

**Authenticated recovery flow:** complete one Play, make the first `/api/wallet/settle` return 503, assert recovery and blocked New Round, Retry, assert the second request body exactly equals the first, then adopt the returned balance. Happy-DOM coverage owns achievement-event forwarding; the browser recovery test does not duplicate it.

Run the new E2E beside Video Poker and profile-statistics E2E, then the full serial suite.

## Explicit non-goals

- Pair Plus, Ante Bonus, Hand Bonus, or any side bet
- server-authoritative dealing or anti-cheat
- ranked/rewarded mode
- AI advice or strategy
- hand history/replay
- generic poker evaluator
- base game/client controller/paytable framework
- Texas Hold'em/Blackjack card refactor
- database migration or new API
- automatic retry/background settlement
- backward-compatibility infrastructure

## Acceptance criteria

- Player can choose Ante, Deal, Fold or Play, see dealer reveal and result, then start a new round.
- Three-card ordering, comparison, qualification, and payouts are pure and thoroughly tested.
- Deal cannot create a state where Play is unaffordable.
- Guest mode is driven by the exact root dataset, stays local, and persists both Fold and Play outcomes.
- Authenticated Fold/Play sends one net wallet settlement; Retry reuses it unchanged.
- Successful settlement adoption forwards any `newAchievements` through the existing `achievement-earned` event.
- Shared cards have exactly the intended clean consumers; `src/lib/poker/**` remains untouched.
- `three-card-showdown` is the tenth registered game and appears in profile statistics and the lobby.
- No side bet, new persistence, API, generic framework, or compatibility machinery is added.
