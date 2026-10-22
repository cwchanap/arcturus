# HPA-176 — Six-seat Poker Sit & Go: design

**Status:** Proposed recovery spec for a Linear issue whose original description was overwritten on 2026-10-22 UTC. This is a new, deliberately minimal proposal, **not** a claim that the lost requirements were recovered.

**Linear:** https://linear.app/cwchanap/issue/HPA-176/poker-sit-and-go-tournament-against-the-ai-rivals  
**Implementation plan:** [2026-10-21-sit-and-go.md](../plans/2026-10-21-sit-and-go.md)

## Decision / experience

Add a casual six-seat, one-table Texas Hold'em **Sit & Go** option against five existing rule-based AI opponents. The player chooses **Cash Poker** (existing behavior) or **Sit & Go** on `/games/poker`; the second URL is `/games/poker?mode=sng`. The table and action controls remain the same.

- Each of six seats starts with **500 tournament chips**, independent of guest bankroll and signed-in account wallet; total chips are conserved at 3,000 across all active seats.
- No buy-in, account-wallet prize, cashout, rebuy, addons, late entry, multiplayer, season, ranked board, or persistence/resume. Refresh restarts an in-progress event. Show that limitation before starting.
- Elimination is permanent after the hand ends and all side-pot awards have been assigned. No eliminated seat may be dealt in, post blinds, take a turn, or rebuy. In particular, cash Poker's `dealNewHand()` path that restores a zero-chip human from the account balance must be skipped in SNG even if another terminal-state guard fails.
- Continue while the human is alive and at least one AI remains. When the human is the **last funded seat**, finish **1st**. If the human busts, stop immediately and show their finish place instead of simulating AI-only hands.
- Show a simple tournament header: players remaining, current blind level, hand count, next blind increase. After completion, display finish place and **New Tournament** / **Back to Cash Poker**.
- For a complete event, signed-in users send **one** zero-delta `game: 'poker'` settlement (one aggregate result, not one per hand), built using the **existing `buildPokerSettlementCommand`** helper. Guest play makes no server calls. This leaves a simple, existing settlement seam for HPA-172 to attach its future `sit-and-go-champion` feat; this ticket does **not** grant that achievement.
- The event result is displayed independently of settlement success. Retry uses the existing pending command/ID; a failed receipt never mutates tournament stacks.

## Existing code / reuse survey (current main)

- `src/pages/games/poker.astro` already renders exactly six stable seat IDs (`NUM_PLAYERS = 6`); `PokerGame` owns one human + five AIs, action transitions, card dealing, and display. Retain it; don't duplicate a Hold'em engine.
- `src/lib/poker/PokerGame.ts` currently seeds the human from the account/guest bankroll; auto-rebuys AI with `settings.startingChips`; synchronizes each human result through `settleHand()`; rotates blinds naively through every seat. These branches must remain **cash-only** in tournament mode.
- `src/lib/poker/player.ts` regards non-folded seats as active. Busted seats must be deliberately marked out of each new hand or the current turn, pot, and showdown functions will include them.
- `src/lib/poker/potCalculator.ts` and `handEvaluator.ts` already handle contested pots, side pots, ties and showdown. Reuse without rewriting poker rules. `PokerUIRenderer.ts`, `poker.css`, and `src/lib/i18n/messages/poker.ts` are existing presentation boundaries.
- `src/lib/wallet/settle.ts` already accepts a signed-in settlement with `delta: 0` and one positive round stat, and `SettlementGate` supports retry/reset. Reuse `buildPokerSettlementCommand(0, outcome)` in `PokerGame.ts`; do not duplicate the command shape. Both `adoptSettlementResult()` **and** `adoptAccountBalance()` can overwrite `players[0].chips` with the account balance (the latter is wired to at-table mission claims); neither may change tournament chips.
- `PokerGame.presentHandResult()` persists cash session statistics through `recordHand`/`saveSessionStats`; SNG hands must not write to that shared `poker_session_stats` store. The existing table-mission panel listens for the per-hand `POKER_HAND_SETTLED_EVENT`, but SNG has no per-hand wallet settlement. Suppress that event and don't mount the table-mission panel in SNG.
- `src/lib/mp-poker/` is private-room multiplayer with Durable Object semantics. Do not couple single-player tournament play to its room/identity/connection protocol or move normal Poker into it.

## Tournament rules

### Fixed setup and blind levels

```ts
export type PokerMode = 'cash' | 'sng';
export const SNG_START_STACK = 500;
export const SNG_BLINDS = [
  { small: 5, big: 10 },
  { small: 10, big: 20 },
  { small: 20, big: 40 },
  { small: 40, big: 80 },
  { small: 80, big: 160 },
] as const;
export const SNG_HANDS_PER_LEVEL = 5;
```

First hand is level 0. Increment the completed-hand counter **only once at final pot award**; a new level applies on hand numbers 6, 11, 16, 21, then stays at 80/160. Blinds never change mid-hand; use a snapshot for legal minimum bet, posted blinds, and toolbar. No user-configurable stacks/blinds in SNG. Reuse stored AI difficulty/personality, but **force built-in rule-based AI** in SNG (no BYOK requirement/API cost). Existing cash settings remain untouched.

### Seats / dealer / action order

- Preserve the six `Player.id` ↔ array-index assumptions in `PokerGame`; do **not** splice eliminated players out of the array.
- At the start of each hand compute funded seats (`chips > 0`), reset hand fields for all seats, and mark eliminated seats folded and unable to act. Deal cards only to funded seats. A zero-stack seat is not an all-in contender from a previous hand.
- Move the button to the next funded seat clockwise; determine blinds from **funded** seat order, skipping gaps.
- **3–6 handed:** next funded seat after button is small blind, next after that big blind, first preflop actor is next funded seat after big blind; postflop starts left of button.
- **Heads-up:** button posts small blind and acts **first preflop**; other seat posts big blind; big blind acts first postflop. Correct even when surviving indices aren't adjacent.
- Mark an all-in funded player eligible to win its side pot until showdown. Do not mark it eliminated until **after** final awards. When all surviving players are all-in, run out the board and award pots without waiting for an impossible action.

### Elimination and finish order

At each completed hand, compare pre-hand funded stacks with post-award chips:

1. Find seats that newly reached zero. Add them to finish order once, **after** all award tiers resolve.
2. If multiple seats bust in that hand, the smaller **start-of-hand** stack finishes lower; equal start stacks share a placing (display `tied Nth`). Player's place can always be calculated from the number of still-funded seats plus simultaneous eliminations ahead of them.
3. The human's elimination immediately terminates the SNG; a surviving human alone is 1st. Repeated next-hand/timeout/auto-deal callbacks cannot start more hands after termination.
4. In a tie, never split tournament chips except through existing hand/showdown pot rules. The tournament rank tie is only a final-place display issue.

A small, pure `src/lib/poker/sitAndGo.ts` owns constants, eligible-seat/dealer/blind selection, level calculation, and final-place derivation. `PokerGame` remains the stateful hand engine and passes hand results into these pure helpers. Do not add a parallel PokerGame subclass, generalized tournament framework, event store, or new D1 schema.

### Wallet and progression boundary

- `settleHand()`, guest bankroll storage, balance adoption, account-balance availability gate, auto-rebuy and pending settings reset remain unchanged in **cash mode**. SNG hand transitions skip all these paths. `adoptAccountBalance()` must return `false` in SNG (including when idle) so mission claims cannot corrupt the local tournament stack. `dealNewHand()` must never restore a busted human from `getEffectiveServerBalance()` in SNG.
- On terminal SNG state, submit at most one `SettleRoundCommand` for authenticated play, using the existing Poker settlement builder:

```ts
const command = buildPokerSettlementCommand(
  0,
  finishPlace === 1 ? 'win' : 'loss',
);
// => game: 'poker', delta: 0, stats: { rounds: 1, wins: 0|1,
//    losses: 0|1, biggestWin: 0 }
```

The existing builder omits optional `netProfit`; with `delta: 0`, the wallet repository's fallback net-profit semantics also record zero. Do not create a second command factory or change wallet validation for this ticket.

This deliberately counts **one tournament result as one Poker stats round** (not every tournament hand). The wallet stays unchanged. SNG must not call `recordHand`/`saveSessionStats` for individual hands, so switching back to Cash Poker does not inherit tournament deltas. `POKER_HAND_SETTLED_EVENT` must not fire for SNG hand completions; leave table-mission tokens unmounted/hidden in SNG. Mission progress (including `handsPlayed`) advances once through the terminal settlement, not once per hand. If this aggregate distinction proves confusing, revisit presentation in a later ticket, rather than create a stats subsystem here. The result callback may dispatch earned achievements but must never assign account `balance` to the SNG player's chips. The existing receipt and retry gate provide idempotency *within a single live page*. No promise of resume or recovery after page reload.

HPA-172 later adds an optional allowable `feats` field to this **same terminal command**, with a `sit-and-go-champion` feat when `finishPlace === 1`; HPA-176 must not alter `ACHIEVEMENT_IDS`, `wallet/settle.ts`, or achievement evaluation to anticipate that work.

## UI / interaction

- `/games/poker` stays cash by default; use a plain mode link `?mode=sng`, plus a reverse link to cash. Mode selection is URL-based; don't switch modes mid-hand.
- SNG header and seat badges explicitly use *tournament chips*, not account bankroll. Disable/hide cash session-net, rebuy, **table-mission panel and initialization**, account-pending round controls and stack/blind settings in this mode (except terminal receipt retry if it fails). Do not re-render or persist cash session stats as SNG hands finish.
- `Deal New Hand` remains manual; disable cash auto-deal in SNG to ensure players see eliminations and changed blinds. Terminal action becomes `New Tournament` (recreate state) instead of dealing into a finished event.
- Add strings for English and Traditional Chinese via existing `pokerTranslator`; render card/seat UI through existing `PokerUIRenderer`, not ad-hoc duplicated templates. Use text/emoji/existing art only.

## Not included

Server authority, anti-cheat, tournament save/load, buy-in/prize economy, new game type, weekly leaderboard, seasonal competition, online rooms, lobby scheduling, user-controlled rules, extra sound/image art, compatibility migrations, or generalized round/poker abstractions.

## Acceptance criteria

- [ ] Cash poker tests and wallet/guest flows behave exactly as before.
- [ ] Both guests and signed-in users can start and finish SNG at zero account cost, with fixed six seats and no rebuy.
- [ ] Eliminated seats cannot act/deal/blind; correct dealer, SB/BB and turn order with nonadjacent survivors and heads-up.
- [ ] Blind escalation happens at the defined completed-hand boundaries, never during a hand.
- [ ] Existing fold-out/showdown/side-pot/tie rules still hold and total tournament stacks remain 3,000 after every completed hand.
- [ ] Human bust immediately produces the correct finishing place; winning produces 1st; no extra deal/duplicate receipt after termination.
- [ ] One zero-delta terminal settlement created by `buildPokerSettlementCommand` for signed-in play (including Retry with same ID); guests never hit wallet endpoints.
- [ ] SNG never adopts an account balance into local stacks (neither terminal receipt nor mission claim); a busted human cannot be restored from a positive account balance.
- [ ] SNG hands never write shared cash session stats, mount per-hand table missions, or emit per-hand settled events; cash mode preserves all three behaviors.
- [ ] Tournament UI names the mode/remaining players/blinds/place and uses localized strings; no new assets.
- [ ] Pure state and PokerGame integration unit tests plus a representative Playwright scenario; existing test/lint/build gates pass.
