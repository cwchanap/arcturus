# HPA-195 Video Poker Design

## Summary

Build Jacks or Better Video Poker as the first new game after the wallet and AI architecture cleanup. The implementation should prove that a new single-player game can stay understandable inside one product module while reusing only the stable seams that already exist.

The selected design is intentionally narrow:

- Keep Video Poker in `src/lib/video-poker/`, matching the repository's current per-domain layout.
- Keep the 52-card deck and hand evaluator local to Video Poker. Do not extract Poker or Blackjack card internals into a new shared card domain yet.
- Reuse `src/lib/bet-validation.ts` for wager limits.
- Reuse `src/lib/public-game-session.ts` for guest/authenticated session metadata and guest bankroll persistence.
- Reuse only the public `src/lib/wallet` API for authenticated settlement.
- Reuse `src/lib/card-format.ts` only for display glyphs/colors.
- Add one Astro route, one lobby entry, focused unit tests, and one representative Playwright flow.

No database migration, generic game framework, compatibility layer, AI feature, ranked mode, or recovery subsystem is part of this ticket.

## Why HPA-195 is next

The parent roadmap, HPA-167, explicitly places Video Poker after HPA-542, HPA-545, and HPA-185. Those three prerequisites are complete. HPA-195 is High priority and its only blocking relation is HPA-545, which is Done.

HPA-553 remains Medium priority and is intentionally sequenced later, before another ranked/daily mode rather than before another casual single-player game.

## Current seams to reuse

### Wallet

`src/lib/wallet/index.ts` already exports:

- `newSettlementId(game)`
- `createSettlementGate()`
- `ensureSettlementRecoveryControls()`
- `SettleRoundCommand`
- `SettleRoundResult`

Video Poker should build exactly one settlement command after a completed hand. It must not add a game-specific endpoint, outbox, queue, automatic retry loop, or persisted pending state.

### Guest/public session

`src/lib/public-game-session.ts` already owns:

- `createPublicGameSession()`
- `loadGuestBankroll()`
- `persistGuestBankroll()`
- `isGuestModeValue()`
- `shouldSyncAccountChips()`

The route should derive session metadata once and pass only opaque client metadata through `data-*` attributes, as Keno and other public games already do.

### Wager validation

`src/lib/bet-validation.ts` already provides `validateBet(amount, minBet, maxBet)`.

Video Poker should add only its game-specific wager constants and the separate balance check required to reject wagers larger than the current bankroll.

### Card code

Poker currently owns `src/lib/poker/DeckManager.ts` and `src/lib/poker/types.ts`. Those are not stable shared APIs and importing them would make Video Poker depend on another game's internals.

The repository does have `src/lib/card-format.ts`, which is already a small cross-game formatting helper. Video Poker may reuse its suit glyph/color helpers for rendering, but should own its card type, deck creation, shuffle, and evaluator.

This is deliberate YAGNI: if a later active game needs the same deck/evaluator primitives, that second concrete consumer can justify an extraction.

## Alternatives considered

### A. Local Video Poker module using existing stable seams — selected

Create a small pure game module and a thin browser client. Keep cards/evaluation local and reuse only wallet, public-session, wager validation, and card formatting.

**Why:** smallest change that validates the modular-monolith direction without coupling to old game internals or inventing a framework.

### B. Extract a new shared cards package first — rejected for HPA-195

Move Poker card types/deck logic into a new shared module and migrate Poker before implementing Video Poker.

**Trade-off:** could reduce future duplication, but it expands HPA-195 into a cross-game refactor and forces a public card abstraction before a second clean consumer proves the shape.

### C. Put Video Poker logic directly in the Astro page — rejected

This is the fastest initial implementation, but it repeats the page-centric structure the architecture roadmap is trying to move away from. It would also mix rules, balance changes, settlement, and DOM behavior in one file.

## Game rules

Implement one conventional 9/6 Jacks or Better paytable with a 1–5 chip wager.

| Hand | Payout per chip |
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

The 5-chip Royal Flush exception is the only wager-specific payout rule.

A round works as follows:

1. Player chooses a wager from 1 through 5 chips.
2. `Deal` validates the wager and current balance, deducts the wager locally, creates and shuffles one 52-card deck, and deals five unique cards.
3. Player may toggle any subset of the five cards as held.
4. `Draw` replaces every unheld card from the same remaining deck exactly once.
5. The final five-card hand is evaluated, gross payout is credited locally, and the round result is frozen.
6. Guest mode persists the resulting local bankroll. Authenticated mode submits one wallet settlement using the round's net delta.
7. A new round cannot begin while authenticated settlement is pending or failed.

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

No DOM types, wallet types, or Astro-specific data belong here.

### `cards.ts`

Own only the mechanics required by this game:

- `createDeck(): Card[]`
- `shuffleDeck(deck, random = Math.random): Card[]`
- `createShuffledDeck(random = Math.random): Card[]`

Use Fisher-Yates. The injectable random function exists only to make unit tests deterministic; there is no RNG service or interface.

### `evaluator.ts`

Expose one pure function:

```ts
export function evaluateHand(cards: readonly Card[]): HandEvaluation;
```

Requirements:

- Accept exactly five cards.
- Recognize the nine paying categories plus `nothing`.
- Treat A-2-3-4-5 as a straight.
- Distinguish Jacks-or-better pairs from pairs of tens or lower.
- Resolve category precedence explicitly so straight flushes, full houses, and similar overlap cannot be misclassified.

No tie-breaking API is needed because Video Poker never compares two hands.

### `paytable.ts`

Own the one local paytable and wager choices:

- `MIN_WAGER = 1`
- `MAX_WAGER = 5`
- `WAGER_OPTIONS = [1, 2, 3, 4, 5]`
- display rows for the Astro page
- `calculatePayout(category, wager): number`

The paytable is a plain data object plus the one Royal Flush five-chip exception. Do not introduce a generic paytable engine.

### `game.ts`

`VideoPokerGame` is the pure state owner. It may depend on `validateBet`, `cards.ts`, `evaluator.ts`, and `paytable.ts`, but not on DOM, fetch, localStorage, wallet, or Astro.

Public behavior:

```ts
export class VideoPokerGame {
  constructor(initialBalance: number, random?: () => number);
  getState(): Readonly<VideoPokerState>;
  setWager(wager: number): void;
  deal(): void;
  toggleHold(index: number): void;
  draw(): VideoPokerRoundResult;
  resetRound(): void;
  setBalance(balance: number): void;
}
```

State phases:

- `ready` — wager can change; Deal is allowed when balance covers the wager.
- `holding` — five cards are visible; only hold toggles and Draw are allowed.
- `complete` — result is frozen until settlement is complete/reset and the next round begins.

Keep one remaining-deck array inside the game object between Deal and Draw. There is no generic state machine abstraction.

### `client.ts`

Own browser composition only:

- Read `data-*` session metadata from `#video-poker-root`.
- Restore/persist guest bankroll through `public-game-session`.
- Instantiate `VideoPokerGame`.
- Render five cards, held state, wager, balance, result, paytable status, and button states.
- Reuse `getSuitGlyph()` / `isRedSuit()` from `card-format.ts` for card display.
- Build one wallet command from a completed result.
- Use one `createSettlementGate()` for authenticated settlement.
- Dispatch the existing `achievement-earned` browser event when settlement returns achievements.
- Use `ensureSettlementRecoveryControls()` for manual Retry/Reset after settlement failure.

The client must not implement hand ranking or payout rules.

### `index.ts`

Export the small public surface needed by the page/tests:

- `VideoPokerGame`
- `evaluateHand`
- `calculatePayout`
- `WAGER_OPTIONS`
- paytable display rows
- `initVideoPokerClient`

Do not export internal deck helpers unless tests or a concrete external consumer need them.

## Route and UI

Create `src/pages/games/video-poker.astro`.

The page should:

- Call `createPublicGameSession(Astro.locals.user)` server-side.
- Render title, balance, 1–5 chip wager controls, five card buttons/slots, Deal/Draw action, result/status text, and a compact paytable panel.
- Pass `clientUserId`, guest mode, and initial balance through root `data-*` attributes.
- Import and call `initVideoPokerClient()` in the page script.
- Contain no hand evaluation, payout calculation, or wallet request code.

Use the existing Art Deco layout/components/styles rather than adding a UI subsystem.

Add Video Poker to the home-page `games` list in `src/pages/index.astro`. It does not need to be marked Featured in this ticket.

## Settlement contract

A completed hand produces one command:

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

A 1x Jacks-or-Better payout is break-even (`netDelta === 0`) and therefore records neither a win nor a loss. `rounds` still increments.

Register `video-poker` in `src/lib/game-stats/constants.ts` so the wallet command is accepted as a `GameType` and normal statistics/mission integration can reuse the existing pipeline.

No database schema change is required because game type storage is textual and the wallet receipt already stores the game identifier without a database enum.

## Failure behavior

### Invalid wager

Reject non-finite, out-of-range, or over-balance wagers before dealing. Keep the current round in `ready` and show the validation message.

### Empty/invalid game action

`toggleHold` outside `holding`, invalid card indexes, a second Draw, or Deal during an unfinished round should fail synchronously in the pure game layer. The client surfaces the message and leaves the previous valid state intact.

### Wallet settlement failure

Do not auto-retry.

- Keep the settlement command in the existing gate.
- Block a new authenticated round.
- Show Retry and Reset.
- Retry resubmits the exact same command/settlement ID.
- Reset discards the failed local round state and restores the last server-confirmed balance.

Guest mode never calls `/api/wallet/settle`.

## Testing

### Pure unit tests

`cards.test.ts`:

- deck has exactly 52 unique cards
- four suits × thirteen ranks
- deterministic Fisher-Yates with injected random
- Deal/Draw from one deck cannot duplicate a card

`evaluator.test.ts`:

- Royal Flush
- Straight Flush
- Four of a Kind
- Full House
- Flush
- Straight
- Three of a Kind
- Two Pair
- Jacks or Better
- pair of tens is `nothing`
- A-2-3-4-5 is a Straight

`paytable.test.ts`:

- standard per-chip payouts
- 5-chip Royal Flush pays 4,000
- invalid wager/category combinations are rejected or return the defined non-paying result

`game.test.ts`:

- Deal deducts the wager and creates five unique cards
- held cards survive Draw
- unheld cards are replaced without duplicates
- Draw happens exactly once
- wager changes are rejected outside `ready`
- over-balance wager/deal is rejected
- payout and net delta update balance correctly
- reset clears the hand/result without changing the confirmed balance

`client.test.ts`:

- settlement command maps net delta to wallet stats correctly
- guest mode never needs the settlement gate to begin another round
- authenticated mode blocks a new round while the gate is pending
- retry/reset wiring delegates to the shared gate rather than reimplementing retry policy

### Playwright

Create `e2e/video-poker.spec.ts` with one representative guest flow:

1. Open `/games/video-poker` as a guest.
2. Confirm 1,000 guest chips.
3. Choose a wager.
4. Deal five cards.
5. Hold a strict subset of cards.
6. Draw once.
7. Confirm held card text is unchanged, a result is shown, balance is rendered, and Draw cannot be repeated for the same hand.
8. Confirm no `/api/wallet/settle` request was made.

The test should control `Math.random` through `page.addInitScript()` so it asserts behavior rather than depending on luck.

## Validation

Before implementation is considered complete:

```bash
bun test src/lib/video-poker src/lib/game-stats
bunx playwright test e2e/video-poker.spec.ts
bun run lint
bun run format:check
bun run build
```

Run the full `bun run test` and broader Playwright suite before merge if the focused checks pass.

## Explicit non-goals

- shared card-domain extraction
- Poker/Blackjack refactors
- AI hold advice
- ranked or Daily Challenge Video Poker
- Deuces Wild, Bonus Poker, multi-hand, double-up, jackpots, or progressive payouts
- persisted round history
- sound/settings/animation systems
- new API endpoints
- server-authoritative deals or anti-cheat
- browser settlement outboxes, automatic retry, crash recovery, cross-tab coordination, or compatibility migration
- generic game base classes, plug-in registries, state-machine libraries, repository interfaces, or generic paytable engines

## Definition of done

HPA-195 is done when Video Poker is a playable guest/authenticated game whose rules are pure and locally testable, whose page is thin, whose authenticated balance mutation goes only through the wallet public API, and whose implementation introduces no new platform abstraction beyond the game module itself.
