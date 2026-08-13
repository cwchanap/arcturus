# HPA-195 Video Poker Design

## Summary

Build Jacks or Better Video Poker as the first new game after the wallet and AI architecture cleanup. The implementation should prove that a new single-player game can remain understandable inside one product module while reusing the stable cross-game seams that already exist.

The selected design is intentionally narrow:

- Keep Video Poker rules and state in `src/lib/video-poker/`, matching the repository's current per-domain layout.
- Keep the 52-card deck and Jacks-or-Better evaluator local to Video Poker.
- Reuse `src/lib/bet-validation.ts` for wager limits.
- Reuse `src/lib/public-game-session.ts` for guest/authenticated session metadata and guest bankroll persistence.
- Reuse the public `src/lib/wallet` gate/transport/recovery APIs for authenticated settlement.
- Reuse `src/components/CardSlot.astro` plus `src/lib/card-slot-utils.ts` for card-face rendering; only hold-toggle styling/interaction is Video-Poker-specific.
- Add one Astro route, one lobby entry, focused unit tests, one guest Playwright flow, and one authenticated settlement-failure Playwright flow.

No database migration, generic game framework, compatibility layer, AI feature, ranked mode, settlement outbox, or new recovery subsystem is part of this ticket.

## Why HPA-195 is next

The parent roadmap, HPA-167, explicitly places Video Poker after HPA-542, HPA-545, and HPA-185. Those prerequisites are complete. HPA-195 is High priority and its only blocking relation is HPA-545, which is Done.

HPA-553 remains the later consolidation step before another ranked/daily mode and is not required for this casual single-player game.

## Reuse decisions

### Wallet

`src/lib/wallet/index.ts` already exports the stable wallet-client boundary:

- `newSettlementId(game)`
- `createSettlementGate()`
- `ensureSettlementRecoveryControls()`
- `SettleRoundCommand`
- `SettleRoundResult`

Video Poker creates exactly one settlement command after Draw and submits it through one settlement gate. The gate owns the one pending command, blocking state, exact-command Retry, and Reset of pending gate state.

Do not add a game-specific endpoint, queue, automatic retry loop, persisted pending state, or crash-recovery policy.

#### Keep the command builder game-local

HPA-545 deliberately chose this boundary: the wallet owns transport/idempotency/failure policy while **each game builds its own domain command because rounds/wins/losses/biggest-win are game semantics**. Its accepted repository shape explicitly keeps `src/lib/baccarat/settlement.ts` game-local even though Baccarat, Keno, and Slots currently share a simple single-round mapping.

Therefore HPA-195 keeps:

```ts
buildVideoPokerSettlementCommand(settlementId, result)
```

inside `video-poker/client.ts` (or a local settlement file if implementation size later justifies it).

Do **not** add `buildSingleRoundSettlementCommand()` or `canStartRound()` to `wallet` in this ticket. That would reverse HPA-545's explicit boundary during an unrelated new-game slice. The existing one-line Retry/adopt passthrough helpers are also unnecessary: Video Poker should call `gate.retry()` and `game.setBalance()` directly.

### Guest/public session

`src/lib/public-game-session.ts` already owns:

- `createPublicGameSession()`
- `loadGuestBankroll()`
- `persistGuestBankroll()`
- `isGuestModeValue()`
- `shouldSyncAccountChips()`

The route derives session metadata once and passes only the existing opaque client/session values through `data-*` attributes.

### Wager validation

`src/lib/bet-validation.ts` returns `string | null` for generic min/max validation. Video Poker additionally requires whole-chip wagers and a current-balance check.

Those ordinary user-input rules have one source of truth in the pure game:

```ts
getWagerError(wager: number): string | null
```

The client uses that value to render a message and disable Deal. `setWager()` and `deal()` also consult the same method as invariant checks, so the affordability rule is not copied into multiple client helpers.

Normal user interaction should not depend on throw/catch for an unaffordable wager. Throws remain appropriate for programmer-invalid phase/index actions such as `toggleHold(7)`, Draw twice, or Deal during an unfinished hand.

### Card rules versus card rendering

#### Deck and evaluator stay local

Poker's `DeckManager` is game-internal, hardcodes its own shuffle behavior, and uses a different `{ value, suit, rank }` card shape. Importing it would couple Video Poker to Texas Hold'em internals.

Poker also contains a private `rankFiveCardHand()` in `src/lib/poker/handEvaluator.ts`. It correctly recognizes five-card poker categories including the wheel, but it is unexported, returns tie-break/kicker data Video Poker does not need, and does not encode the Jacks-or-Better paying-pair boundary. Reusing it would require exposing another game's private evaluator and then layering Video Poker-specific semantics on top.

That duplication is therefore deliberate: Video Poker owns its small `Card`, deck/shuffle, and `evaluateHand()` implementation.

#### Card rendering is shared

The visual rendering concern is already a stable shared seam:

- `src/components/CardSlot.astro` provides pre-rendered placeholder/card/back markup.
- `src/lib/card-slot-utils.ts` provides tested `setSlotState()` rendering with shared suit glyph and red/black styling.

Video Poker should use those instead of writing card text directly into hold buttons.

Each card position is a relative wrapper containing:

1. one `CardSlot.astro` instance; and
2. one transparent/overlay hold-toggle `<button>` with `data-card-index`, `aria-pressed`, and a visible held border/state on the wrapper.

The client calls `setSlotState(slot, 'card', { rank, suit })`. It sets a `data-card-id="<rank>-<suit>"` attribute on the hold button so browser tests can assert held-card identity without coupling to rendered text.

This reuses the existing card renderer while keeping hold interaction as the only new presentation concern.

## Alternatives considered

### A. Local Video Poker domain + existing shared UI/wallet/session seams — selected

Keep rules/state local. Reuse stable cross-game primitives for session, wallet failure policy, wager validation, and card rendering.

**Why:** smallest implementation that proves the modular-monolith direction while avoiding both another text-card renderer and a new game framework.

### B. Extract a shared card rules/domain package first — rejected

Move Poker card types/deck/evaluator into a new shared domain and migrate Poker before implementing Video Poker.

**Why rejected:** this turns HPA-195 into a cross-game refactor. Shared card **rendering** already exists and should be reused; shared card **game rules/types** are not yet a clean public contract.

### C. Generalize single-round settlement command construction into `wallet` — rejected for HPA-195

Several current games have the same simple mapping from one net delta to `{ rounds: 1, wins, losses, biggestWin }`.

**Why rejected here:** HPA-545 explicitly kept command construction game-local because statistics semantics belong to the game. HPA-195 should not reverse that decision while adding a new game. It should, however, avoid additional one-line Retry/adopt wrappers that have no domain value.

### D. Put game rules directly in the Astro page — rejected

This would repeat the page-centric structure the architecture roadmap is moving away from and would mix rules, settlement, and DOM behavior.

## Game rules

Implement one conventional 9/6 Jacks or Better paytable with a 1–5 chip wager.

| Hand | Payout |
| --- | ---: |
| Royal Flush | 250x for wagers 1–4; 4,000 total on a 5-chip wager |
| Straight Flush | 50x |
| Four of a Kind | 25x |
| Full House | 9x |
| Flush | 6x |
| Straight | 4x |
| Three of a Kind | 3x |
| Two Pair | 2x |
| Jacks or Better | 1x |
| Nothing | 0x |

The five-chip Royal Flush exception is the only wager-specific payout rule.

A round works as follows:

1. Player chooses a wager from 1 through 5 chips.
2. `Deal` validates the current wager through `getWagerError()`, deducts it locally, creates/shuffles one 52-card deck, and deals five unique cards.
3. Player may toggle any subset of the five cards as held.
4. `Draw` replaces every unheld card from the same remaining deck exactly once.
5. The final hand is evaluated, gross payout is credited locally, and the result is frozen.
6. Guest mode persists the resulting local bankroll. Authenticated mode submits one wallet settlement using the hand's net delta.
7. Primary action lifecycle is `Deal` → `Draw` → `New Round`.
8. Authenticated `New Round` stays disabled while wallet settlement is pending or failed.

No draw animation, sound, hand history, double-up game, or multi-hand play is required.

## Module shape

```text
src/lib/video-poker/
  types.ts
  cards.ts
  evaluator.ts
  paytable.ts
  game.ts
  client.ts
  index.ts
```

Tests live beside the files they cover.

### `types.ts`

Own Video Poker domain types only:

- `Suit`
- `Rank`
- `Card`
- `HandCategory`
- `PayingHandCategory`
- `RoundPhase`
- `HandEvaluation`
- `VideoPokerRoundResult`
- `VideoPokerState`

No DOM, wallet, or Astro types belong here.

### `cards.ts`

Own only this game's deck mechanics:

```ts
createDeck(): Card[]
shuffleDeck(deck, random = Math.random): Card[]
createShuffledDeck(random = Math.random): Card[]
```

Use Fisher-Yates with an injectable random function for tests. Do not add an RNG service/interface.

### `evaluator.ts`

Expose:

```ts
export function evaluateHand(cards: readonly Card[]): HandEvaluation;
```

Requirements:

- exactly five cards;
- nine paying categories plus `nothing`;
- A-2-3-4-5 straight;
- suited A-2-3-4-5 is Straight Flush, not Royal Flush;
- Jacks, Queens, Kings, and Aces qualify as `jacks-or-better`; tens and lower do not;
- explicit category precedence.

No tie-breaking API is needed.

### `paytable.ts`

Own the one local paytable and wager choices:

```ts
MIN_WAGER = 1
MAX_WAGER = 5
WAGER_OPTIONS = [1, 2, 3, 4, 5]
calculatePayout(category, wager): number
```

`calculatePayout()` returns 0 for `nothing` and throws `RangeError` only for programmer-invalid paytable calls with non-integer/out-of-range wagers. Do not add a generic paytable engine.

### `game.ts`

`VideoPokerGame` owns pure state and rule transitions. It may depend on `validateBet`, local card helpers, evaluator, and paytable, but not DOM/fetch/localStorage/wallet/Astro.

Public surface:

```ts
export class VideoPokerGame {
  constructor(initialBalance: number, random?: () => number);
  getState(): Readonly<VideoPokerState>;
  getWagerError(wager: number): string | null;
  setWager(wager: number): void;
  deal(): void;
  toggleHold(index: number): void;
  draw(): VideoPokerRoundResult;
  resetRound(): void;
  setBalance(balance: number): void;
}
```

`getWagerError()` combines:

- whole-chip requirement;
- `validateBet(wager, 1, 5)`;
- `wager <= current balance`.

`setWager()` and `deal()` call that same method as an invariant guard. The browser checks it before invoking them, so ordinary affordability failures render as values rather than throw/catch control flow.

State phases:

- `ready` — wager can change; Deal is allowed only when `getWagerError(state.wager) === null`.
- `holding` — hold toggles and Draw only.
- `complete` — result stays visible until guest completion or authenticated settlement permits New Round.

### `client.ts`

Own browser composition only:

- read root session metadata;
- restore/persist guest bankroll;
- instantiate one `VideoPokerGame`;
- instantiate one settlement gate;
- render balance, wager state, result/status, hold state, and primary action;
- render card faces with shared `setSlotState()`;
- build the game-local wallet settlement command;
- submit via `gate.settle()`;
- retry via `gate.retry()` directly;
- adopt successful authoritative balance via `game.setBalance(result.balance)` directly;
- dispatch existing `achievement-earned` event;
- create settlement recovery controls with an explicit `attachTo` host;
- show/hide recovery on failure/success.

The client must not implement hand ranking, payout rules, or another retry state machine.

## Route and UI

Create `src/pages/games/video-poker.astro`.

The page:

- calls `createPublicGameSession(Astro.locals.user)`;
- renders `data-testid="video-poker-root"` on the root and `data-testid="chip-balance"` on the balance, matching Keno/Slots conventions;
- imports and renders five `CardSlot.astro` components;
- gives each slot a separate hold-toggle overlay button;
- renders 1–5 wager controls;
- renders `Deal`/`Draw`/`New Round`, status, result, compact paytable, and a `#video-poker-recovery-host`;
- bootstraps only `initVideoPokerClient()` for behavior;
- contains no hand evaluation, payout calculation, or wallet request code.

Use existing Art Deco classes and components. Do not add a renderer/settings subsystem.

Add Video Poker to the home-page `games` array in `src/pages/index.astro`; do not mark it Featured.

## Settlement contract

A completed hand produces one game-owned command:

```ts
{
  settlementId: newSettlementId('video-poker'),
  game: 'video-poker',
  delta: result.netDelta,
  stats: {
    rounds: 1,
    wins: result.netDelta > 0 ? 1 : 0,
    losses: result.netDelta < 0 ? 1 : 0,
    biggestWin: Math.max(result.netDelta, 0),
  },
}
```

A 1x Jacks-or-Better payout is break-even (`netDelta === 0`) and records neither win nor loss; `rounds` still increments.

Register `video-poker` in `src/lib/game-stats/constants.ts`. No database schema change is required because game type storage is textual.

## Settlement recovery contract

The recovery surface is part of the required authenticated flow, not optional polish.

The client must call:

```ts
const recovery = ensureSettlementRecoveryControls({
  attachTo: document.getElementById('video-poker-recovery-host'),
  containerId: 'video-poker-settlement-recovery',
  retryId: 'video-poker-retry-settlement',
  resetId: 'video-poker-reset-settlement',
  containerClass: 'hidden mt-4 flex flex-wrap justify-center gap-3',
  retryLabel: 'Retry settlement',
  resetLabel: 'Reset hand',
  retryClass: 'deco-btn px-4 py-2 rounded-lg',
  resetClass: 'deco-btn px-4 py-2 rounded-lg',
});
```

Then define small client-local `showSettlementRecovery(message)` and `hideSettlementRecovery()` functions.

On initial authenticated settlement failure:

- gate retains the exact command;
- recovery controls become visible;
- `New Round` stays disabled.

Retry:

- calls `gate.retry()` directly;
- does not mint another ID or rebuild the command;
- on success adopts `result.balance`, hides recovery, and re-enables New Round.

Reset:

- calls `gate.reset()`;
- restores the last server-confirmed balance;
- clears the completed local hand through `game.resetRound()`;
- hides recovery.

Guest mode never calls `/api/wallet/settle`.

## Failure and empty-balance behavior

### Ordinary wager input

When the player clicks a wager option:

1. call `game.getWagerError(clickedWager)`;
2. if it returns a message, render that message and do not call `setWager()`;
3. otherwise update the wager.

Deal is disabled whenever the current wager has an error or authenticated settlement blocks a new action.

### Programmer-invalid game actions

Out-of-phase calls, invalid hold indexes, and a second Draw throw synchronously in the pure game. Event handlers may still catch those invariant failures at the outer action boundary to prevent an uncaught DOM event, but ordinary wager validation does not use exceptions as its normal path.

### Balance below minimum wager

When `state.phase === 'ready'` and `state.balance < MIN_WAGER`, Deal stays disabled and status explicitly says the player does not have enough chips to deal. For a guest, append a short sign-in hint; do not add a new guest-bankroll reset system in this ticket.

## Testing

### Pure unit tests

`cards.test.ts`:

- exactly 52 unique cards;
- four suits × thirteen ranks;
- deterministic Fisher-Yates;
- Deal/Draw cannot duplicate a card.

`evaluator.test.ts`:

- every paying category plus nothing;
- pair of tens is nothing;
- pair of aces is Jacks or Better;
- wheel straight;
- suited wheel is Straight Flush, not Royal Flush.

`paytable.test.ts`:

- frozen 9/6 payouts;
- five-chip Royal Flush pays 4,000;
- invalid paytable wager throws.

`game.test.ts`:

- Deal/hold/Draw/reset lifecycle;
- unique final hand;
- `getWagerError()` for fractional, out-of-range, over-balance, and valid wagers;
- set/deal consult the same rule;
- programmer-invalid phase/index calls throw without mutating valid state;
- payout/net-delta/balance math.

`client.test.ts`:

- Video Poker settlement command maps net delta to the expected game-owned stats shape;
- card-slot rendering adapter converts numeric rank to `CardData` and uses shared `setSlotState()` rather than a bespoke text renderer, if a small adapter is needed.

### Playwright: guest flow

One guest flow:

1. open `/games/video-poker` unauthenticated;
2. confirm 1,000 guest chips;
3. select wager, Deal;
4. hold a strict subset;
5. record held `data-card-id` values;
6. Draw;
7. confirm held `data-card-id` values are unchanged, result is visible, action is `New Round`;
8. start New Round;
9. confirm no wallet request occurred.

### Playwright: authenticated settlement failure

One isolated authenticated flow modeled on the repository's existing wallet-failure E2E pattern:

1. create an isolated authenticated user and open Video Poker;
2. intercept `**/api/wallet/settle`;
3. first request returns 503 and its body is captured;
4. Deal and Draw to trigger settlement;
5. assert Retry and Reset are visible and `New Round` is disabled;
6. click Retry;
7. second request returns 200 with an authoritative balance;
8. assert the second request body exactly equals the first body, proving settlement-ID/command reuse;
9. assert recovery hides and New Round becomes enabled.

This is the only extra authenticated browser test. Do not add reload/crash/outbox scenarios.

## Closed `GAME_TYPES` consumers

Adding `video-poker` widens the canonical game list used by player statistics/profile parsing/rendering. Current fixtures derive from `GAME_TYPES`, so do not edit them pre-emptively. Task validation must run those consumers immediately after registration and change a fixture only if the suite proves a hard-coded seven-game assumption remains.

## Validation

Focused validation before implementation-task completion:

```bash
bun test src/lib/video-poker src/lib/game-stats \
  src/lib/profile-statistics-payload.test.ts \
  src/lib/profile-statistics-renderer.test.ts \
  src/lib/profile-statistics-client.test.ts
bunx playwright test e2e/video-poker.spec.ts
bun run lint
bun run format:check
bun run build
```

Before merge also run `bun run test` and the ordinary Playwright suite.

## Explicit non-goals

- shared card **rules/domain** extraction;
- Poker/Blackjack refactors;
- generic wallet settlement-command builder added during this game ticket;
- AI hold advice;
- ranked or Daily Challenge Video Poker;
- alternate paytables/variants, multi-hand, double-up, jackpots, progressive payouts;
- persisted hand history;
- sound/settings/animation systems;
- new API endpoints;
- server-authoritative deals or anti-cheat;
- settlement outboxes, automatic retry, crash recovery, cross-tab coordination, compatibility migration;
- generic game base classes, plug-in registries, state-machine libraries, repository interfaces, generic paytable engines.

## Definition of done

HPA-195 is done when Video Poker is a playable guest/authenticated game whose rules are pure and locally testable, card presentation uses the existing shared CardSlot system, authenticated balance mutation uses only the existing wallet boundary with visible manual recovery, ordinary wager errors are values rather than UI throw/catch control flow, and no new platform abstraction is introduced beyond the game module itself.