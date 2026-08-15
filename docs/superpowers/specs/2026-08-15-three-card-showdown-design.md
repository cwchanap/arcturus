# HPA-198 Three-Card Showdown Design

## Summary

Build HPA-198 as the next small single-player Arcturus game: a focused Ante → Fold/Play → result loop at `/games/three-card-showdown`.

Keep the game itself deliberately local, but stop copying the public-game wallet/session/recovery block that Video Poker and Sic Bo already duplicate.

The selected shape is:

- Extract only the neutral 52-card `Card`/deck helpers from Video Poker into `src/lib/cards.ts`.
- Extract one narrow **public-game net-round settlement controller** into `src/lib/wallet/` and migrate Video Poker + Sic Bo to it before adding Three-Card Showdown.
- Keep Three-Card Showdown ranking, dealer qualification, payout resolution, state transitions, phase/UI logic, and result copy in `src/lib/three-card-showdown/`.
- Reuse `validateBet`, `CardSlot`, and `setSlotState` unchanged.
- Add no schema migration, API route, server-authoritative cards, generic poker evaluator, base game class, paytable engine, strategy layer, AI, ranked mode, history, replay, side bet, or compatibility layer.

This remains a hobby-project modular monolith. The shared settlement seam is justified by existing duplicate code and observed drift, not by a hypothetical future framework.

## Why HPA-198 is next

The HPA-167 cleanup sequence is complete: private-room Poker isolation, wallet settlement simplification, BYOK AI cleanup, Video Poker, Blackjack Run consolidation, and Sic Bo have landed.

The remaining open roadmap children are either explicitly deferred (`HPA-174`, `HPA-177`) or larger future games (`HPA-197` Pai Gow Poker). HPA-198 is the smallest unblocked slice that continues the single-player modular direction.

## Shared extraction 1: neutral cards only

Video Poker already owns the exact standard-card concept HPA-198 needs:

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

Move the existing implementation and tests to:

```text
src/lib/cards.ts
src/lib/cards.test.ts
```

`src/lib/cards.ts` becomes the canonical import path. Update Video Poker's internal imports directly; do not leave `Card`/`Rank`/`Suit` re-exported from `video-poker/types.ts` and do not keep a `video-poker/cards.ts` compatibility wrapper.

`video-poker/types.ts` may import `Card` for its own state/result interfaces, but callers that need card primitives import from `../cards`.

Do **not** touch `src/lib/poker/**` or Blackjack card representations. Texas Hold'em uses `{ value, suit, rank }`, while Blackjack uses its own string-rank model. Neither is a consumer of this exact primitive.

Do **not** share an evaluator. Five-card Jacks-or-Better and Three-Card Showdown have different category order and tie-break semantics; notably Three-Card ranks Straight above Flush.

### Deterministic shuffle pin

Preserve Fisher-Yates with injectable `random`. Add one explicit test that `random = () => 0` makes the first six cards:

```text
3♥ 4♥ 5♥ 6♥ 7♥ 8♥
```

That fixture is used by the game and browser acceptance tests.

## Shared extraction 2: public-game net-round settlement

### Why extraction is justified now

Video Poker and Sic Bo already contain effectively the same block for:

- root dataset → guest bankroll → settlement gate → last server balance;
- one sign-derived round settlement command;
- syncing `#chip-balance` and `[data-chip-balance]`;
- creating Retry/Reset controls;
- settlement status visibility;
- authoritative balance adoption;
- achievement event forwarding;
- retry button behavior;
- reset-to-last-server-balance behavior.

This is no longer hypothetical reuse. Video Poker needed a shared-header/recovery correction in commit `1a7aaf1`, and Sic Bo later needed the same shared-header correction separately in `e6ba2f9`. HPA-198 would otherwise create a third copy.

### Scope of the shared seam

Add one focused file:

```text
src/lib/wallet/public-game-settlement.ts
src/lib/wallet/public-game-settlement.test.ts
```

It is for simple public single-player games whose completed round is fully described by one `netDelta` and whose statistics semantics are:

```ts
rounds = 1
wins = netDelta > 0 ? 1 : 0
losses = netDelta < 0 ? 1 : 0
biggestWin = Math.max(netDelta, 0)
```

It does **not** replace Ranked Blackjack, Craps settlement semantics, Slots' async spin controller, or any other flow unless a later change proves the same interface fits naturally.

### Pure command helper

Expose:

```ts
export function buildRoundSettlementCommand(
  game: GameType,
  settlementId: string,
  netDelta: number,
): SettleRoundCommand;
```

Use it for Video Poker, Sic Bo, and Three-Card Showdown. Do not sweep Baccarat/Keno/Slots in this ticket even if some mappings happen to match; they are outside HPA-198's immediate duplication problem.

### Focused controller

Expose a small browser-only controller:

```ts
export type PublicGameSettlementMessages = {
  failed: string;
  retrying: string;
  retryFailed: string;
};

export function createPublicGameSettlementController(options: {
  gameKey: GameType;
  root: HTMLElement;
  recoveryHost: HTMLElement | null;
  resetLabel: string;
  messages: PublicGameSettlementMessages;
  render: () => void;
  onAdoptBalance: (balance: number) => void;
  onResetRound: () => void;
}): {
  readonly isGuestMode: boolean;
  readonly clientUserId: string;
  readonly startingBalance: number;
  readonly isBlocked: boolean;
  readonly statusMessage: string | null;
  syncBalance(balance: number): void;
  completeRound(netDelta: number, localBalance: number): Promise<void>;
};
```

The controller owns only the stable public-session/wallet mechanics:

1. Read `data-user-id`, `data-guest-mode`, and `data-initial-balance` from the root.
2. Resolve guest bankroll through the existing public-game-session helpers.
3. Own one `createSettlementGate()` and the last authoritative server balance.
4. Create the existing Retry/Reset controls with IDs derived from `gameKey`.
5. `syncBalance(balance)` updates both `#chip-balance` and every `[data-chip-balance]` element.
6. `completeRound(netDelta, localBalance)` persists guest balance locally or submits one `buildRoundSettlementCommand(...)` for authenticated play.
7. Successful settlement/retry adopts the returned balance and dispatches `achievement-earned` when needed.
8. Failed settlement exposes `statusMessage`, keeps recovery visible, and leaves the gate blocked.
9. Retry disables both recovery buttons while in flight and reuses the exact pending command.
10. Reset clears the gate, calls `onAdoptBalance(lastServerBalance)`, calls `onResetRound()`, hides recovery, and renders.

The controller does **not** know about game phases, cards/dice, wager selection, action buttons, result copy, paytables, rules, or game-specific error messages outside the three supplied settlement strings.

This is a wallet/public-session boundary, not a generic game client controller.

### Migration scope

Before implementing Three-Card Showdown, migrate only:

```text
src/lib/video-poker/client.ts
src/lib/sic-bo/client.ts
```

Their existing game-specific render/interaction code remains local. Remove their duplicated settlement builders and recovery/session blocks.

Move the shared settlement/recovery assertions into `public-game-settlement.test.ts`. Keep focused Video Poker/Sic Bo client tests for their own game interactions and one light integration assertion that completion delegates through the shared controller; do not keep two full copies of the same gate/retry/reset test matrix.

## Three-Card Showdown rules

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
- A-2-3 is the lowest straight and compares with straight-high `3`.
- K-A-2 is not a straight.
- Suits never break ties.

### Tie breakers

`evaluateThreeCardHand(cards)` returns a category plus ordered numeric tie breakers:

- Straight Flush / Straight: `[straightHigh]`
- Three of a Kind: `[tripRank]`
- Flush / High Card: ranks descending
- Pair: `[pairRank, kickerRank]`

`compareThreeCardHands(left, right)` compares category strength then tie breakers lexicographically, returning `-1 | 0 | 1`.

### Dealer qualification

Dealer qualifies with Queen-high or better:

- every Pair-or-better hand qualifies;
- High Card qualifies when `tieBreakers[0] >= 12`.

No strategy object or rules version is needed.

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

Gross payout includes returned stake: wagers are deducted first, then gross payout is credited.

## Pure game state

Constants:

```ts
export const MIN_ANTE = 1;
export const MAX_ANTE = 100;
export const ANTE_OPTIONS = [1, 5, 10, 25, 50, 100] as const;
```

The initial Ante is explicitly:

```ts
ante: ANTE_OPTIONS[0] // 1
```

`getAnteError(ante)` requires:

1. whole number;
2. `validateBet(ante, MIN_ANTE, MAX_ANTE)`;
3. `ante * 2 <= balance`.

`setAnte(ante)` is a pure-domain invariant and throws when `getAnteError(ante)` is non-null.

State flow:

```text
betting --Deal--> decision --Fold/Play--> complete --New Round--> betting
```

Deal deducts one Ante and deals player cards first, then dealer cards. The `2 * ante <= balance` rule guarantees Play is always affordable once decision state is entered.

Fold loses one Ante only. Play deducts the second equal wager, resolves the comparison, then credits gross payout. New Round clears cards/result and retains the selected Ante.

## Client/page design

The real Astro page must carry the same public-game root contract as Video Poker/Sic Bo:

```astro
<main
  id="three-card-showdown-root"
  data-testid="three-card-showdown-root"
  data-user-id={gameSession.clientUserId}
  data-guest-mode={gameSession.guestModeValue}
  data-initial-balance={gameSession.initialBalance}
>
```

The client creates `createPublicGameSettlementController(...)`, constructs `ThreeCardShowdownGame` from `controller.startingBalance`, and keeps all Three-Card rendering/phase logic local.

### Ante buttons

Ante selection mirrors Video Poker's validated wager selection. Never call throwing `setAnte()` directly from an unchecked click handler:

```ts
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
```

This behavior is tested with an unaffordable Ante.

### Card presentation

Reuse six existing `CardSlot` instances and `setSlotState()`:

```text
Dealer: betting=placeholder, decision=facedown, complete=card
Player: betting=placeholder, decision=card, complete=card
```

No generic card-row component is needed.

### Actions

```text
betting  -> Deal
decision -> Fold + Play
complete -> New Round
```

Fold and Play both call the pure game first, render the completed state, then pass `result.netDelta` and the local final balance to `controller.completeRound(...)`.

New Round is disabled while authenticated settlement is blocked.

Result copy remains game-local:

- Fold: `Fold · -<ante> net`
- Dealer not qualified: `Dealer does not qualify · +<ante> net`
- Player win: `Player wins · +<netDelta> net`
- Tie: `Tie · 0 net`
- Dealer win: `Dealer wins · <netDelta> net`

## Game registration

Add `three-card-showdown` as the tenth `GAME_TYPES` entry with label `Three-Card Showdown` and icon `♠️`.

The meaningful test tripwires are:

```ts
expect(GAME_TYPES).toContain('three-card-showdown');
expect(GAME_TYPES.length).toBe(10);
expect(isValidGameType('three-card-showdown')).toBe(true);
```

Do not add redundant exact label/icon assertions solely to pin display copy; the typed `Record<GameType, string>` maps and build already require entries.

Update `e2e/profile-statistics.spec.ts`'s fixed canonical list and add a normal lobby card in `src/pages/index.astro`.

No schema migration is required because `gameType` is application-validated text.

## Verification strategy

### Shared cards

Move the existing Video Poker cards implementation/tests rather than recreating them. Add the constant-zero first-six-card pin, update Video Poker imports directly, then run shared-card + all Video Poker tests.

### Shared public-game settlement

Add one focused shared suite covering:

- root dataset and guest bankroll resolution;
- `buildRoundSettlementCommand()` for win/loss/push;
- `syncBalance()` updating both balance surfaces;
- guest completion persists locally and performs no wallet request;
- authenticated success adopts balance and forwards achievements;
- failure blocks, Retry reuses the exact command and disables both controls in flight;
- Reset restores last server balance and calls the game reset callback.

Migrate Video Poker/Sic Bo and run their unit suites plus their representative E2E flows before proceeding.

### Three-Card rules/game

Unit tests cover category order, straight edge cases, tie-breaks, Q-high qualification, four Play outcomes, two-Ante affordability, default Ante = 1, Deal accounting, Fold, Play, reset, and invalid transitions.

### Page/client contract

The deterministic guest browser flow belongs in the same implementation slice as the real `.astro` page and client so it validates actual IDs/dataset wiring rather than a hand-built DOM fixture.

With `Math.random = () => 0` and Ante 10:

```text
before Deal: 1000
Deal: player 3♥4♥5♥, dealer facedown, balance 990
Play: dealer 6♥7♥8♥ revealed, Dealer wins · -20 net, balance 980
wallet requests: 0
```

Rules unit tests—not this browser flow—carry Q-high/J-high qualification coverage.

### Remaining composition/acceptance

Happy-DOM tests cover guest Fold/Play composition, dealer reveal, guest persistence/no wallet call, and the unaffordable-Ante click guard.

One authenticated browser flow covers 503 → blocked New Round → Retry with exact same command → authoritative balance adoption. The shared controller suite owns detailed recovery/achievement behavior so each game does not duplicate that matrix.

## Delivery sequence

Six independently reviewable slices:

1. Move neutral cards to `src/lib/cards.ts`; update Video Poker imports directly.
2. Add the focused public-game net-round settlement controller; migrate Video Poker and Sic Bo; keep both green.
3. Add Three-Card pure rules.
4. Add Three-Card pure game state, including default Ante and validated `setAnte` contract.
5. Add registry + real Astro page + client + lobby and the deterministic guest E2E in the same slice.
6. Add remaining Happy-DOM/authenticated/profile coverage and run full validation.

## Scope guardrails

The final diff must satisfy all of these:

```text
no schema/migration files changed
no new API route exists
src/lib/poker/** is untouched
Blackjack card representation is untouched
no generic poker evaluator/base game/paytable engine exists
src/lib/cards.ts is the sole canonical Card/Rank/Suit path for the new clean card model
public-game settlement controller owns wallet/session/recovery only, not game phases or rendering policy
Video Poker + Sic Bo no longer contain copied net-round settlement/recovery blocks
no third verbatim settlement/session/recovery block is introduced in Three-Card Showdown
no side bet/bonus/AI/ranked/history/replay code exists
```

If the shared controller starts learning game rules/phases, or the implementation starts sweeping unrelated wallet clients, simplify before merge.
