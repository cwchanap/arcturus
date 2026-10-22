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
- **All SNG play is local, even for signed-in users:** no per-hand or terminal wallet settlements, no Poker account-stat updates, no mission progression event, and no rewards in HPA-176. This keeps tournaments from contaminating existing cash-Poker statistics in D1. The future HPA-172 ticket will determine whether/how a distinct tournament result and `sit-and-go-champion` achievement are recorded.
- Keep existing auto-deal/5-second result hold, but stop queued deals at terminal status. **New Tournament** is an ordinary link back to `/games/poker?mode=sng` (full reload); don't add an in-place reset routine.

## Existing code / reuse survey (current main)

- `src/pages/games/poker.astro` already renders exactly six stable seat IDs (`NUM_PLAYERS = 6`); `PokerGame` owns one human + five AIs, action transitions, card dealing, and display. Retain it; don't duplicate a Hold'em engine.
- `src/lib/poker/PokerGame.ts` currently seeds the human from the account/guest bankroll; auto-rebuys AI with `settings.startingChips`; synchronizes each human result through `settleHand()`; rotates blinds naively through every seat. These branches must remain **cash-only** in tournament mode.
- `src/lib/poker/player.ts` regards non-folded seats as active. Busted seats must be deliberately marked out of each new hand or the current turn, pot, and showdown functions will include them.
- `src/lib/poker/potCalculator.ts` and `handEvaluator.ts` already handle contested pots, side pots, ties and showdown. Reuse without rewriting poker rules. `PokerUIRenderer.ts`, `poker.css`, and `src/lib/i18n/messages/poker.ts` are existing presentation boundaries.
- `PokerGame.presentHandResult()` persists cash session statistics through `recordHand`/`saveSessionStats`; tournament hands must skip these writes, the shared `poker_session_stats` display, and per-hand `POKER_HAND_SETTLED_EVENT` emissions.
- Reuse existing guest-mode/local-play branches rather than adding many SNG-only guards: define `private get playsLocally() { return this.isGuestMode || this.mode === 'sng'; }` for account-balance start gates, per-hand settlement, settlement-gate blocking, per-hand event dispatch, account-balance adoption, and LLM settings/decision/overlay checks. Preserve actual `isGuestMode` for **cash-only** guest bankroll loading, persistence and rebuy (`isGuestMode && mode === 'cash'`). A guest SNG must never alter their saved cash bankroll.
- Render `#poker-missions` only for `!gameSession.isGuest && !isSng` in `poker.astro`; `initPokerTableMissions` and its `onBalance` handler then aren't wired for SNG. The `adoptAccountBalance()` guard still protects direct callers.
- `src/lib/mp-poker/` is multiplayer with Durable Object semantics. Do not couple single-player tournament play to its room/identity/connection protocol or move normal Poker into it.

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

First hand is level 0. The existing `PokerGame.handNumber` increments once per dealt hand. Derive `level = min(4, floor((handNumber - 1) / 5))`, with levels on hands 1, 6, 11, 16 and 21. No second completed-hand counter. Snapshot posted blinds, minimum bet and UI labels for the duration of that hand. SNG ignores cash stack/blind settings, retains configured AI personalities/difficulties but **forces built-in rule-based AI** with no BYOK cost. Accept the current `MAX_BET` cap.

### Seats / dealer / action order

- Preserve the six `Player.id` ↔ array-index assumptions in `PokerGame`; do **not** splice eliminated players out of the array.
- At the start of each hand compute funded seats (`chips > 0`), reset hand fields for all seats, and mark eliminated seats folded and unable to act. Deal cards only to funded seats. A zero-stack seat is not an all-in contender from a previous hand.
- Rotate the button to the next **funded** seat clockwise; for three or more, SB and BB are the next two funded seats. In heads-up, button **is** SB, other seat BB. The same next-funded rotation may replace cash's naive modulo rotation because playable cash seats are restored/rebought before rotating.
- Reuse `getNextPlayerIndex(players, bigBlindIndex)` for preflop actor order and `getNextPlayerIndex(players, dealerIndex)` postflop. It filters `canPlayerAct`, which is correct for betting turns but **not** for dealer/blind selection; keep funded-seat selection distinct.
- All-in participants retain side-pot eligibility until final awards. Do not mark them eliminated mid-hand. Busted seats from **previous** hands are folded and receive no new cards.
- **Shared engine fix:** the current `nextPhase()` calls `getNextPlayerIndex()` even when no one can act, whose fallback selects the dealer (potentially folded/all-in). The human can be stuck with disabled controls, or a folded AI can make phantom bets. After dealing a **new, unbet street**, if `getPlayersWhoCanAct(players).length < 2`, schedule the next street/showdown through existing turn transitions rather than offering an impossible turn. `processAITurn()` must not ask `!canPlayerAct(currentPlayer)` for a decision; reconcile/advance safely. Also handle no legal preflop actor after blinds. **Do not** skip an outstanding preflop decision to call/fold an all-in raise; only shortcut when the betting round is resolved. Test human-dealer and folded-AI-dealer all-in runouts, no phantom bets, correct side-pot awards and no deadlocks. This fixes cash Poker too.

### Elimination and finish order

At each completed hand, compare pre-hand funded stacks with awarded stacks. No full finish-order list is required because play stops when the human busts:

1. Find newly busted seats **after** all side-pot awards, not when they become all-in.
2. The human's place is `fundedSeatsAfterHand + 1 + newlyBustedOpponentsWithLargerStartOfHandStack`. If several busted players started with equal stacks they tie their placing.
3. Human reaches zero → finish; human is the only funded seat → 1st. A terminal guard blocks queued and manual future deals.
4. Hand/showdown tie rules determine pot splits; tournament rank ties do not change chips.

A small pure `src/lib/poker/sitAndGo.ts` owns constants, next-funded seat/blind selection, level calculation from `handNumber`, and human place. `PokerGame` stays stateful. No duplicate PokerGame subclass, framework, DB state or new schema.

### Cash wallet, session, and progression isolation

- All SNG hands run in `playsLocally` regardless of authentication. Skip `settleHand` account synchronization, settlement gate blocking, wallet-balance availability gating, and the `POKER_HAND_SETTLED_EVENT`. **No terminal zero-delta receipt.** Cash mode keeps existing settlements and recovery semantics unchanged.
- Keep cash-only guest bankroll reads/writes (including constructor, beforeunload, `persistGuestBankroll` and guest rebuy) behind `isGuestMode && mode === 'cash'`. A signed-in or guest SNG never adopts server balance; `adoptAccountBalance()` returns false in local mode.
- In `dealNewHand`, skip both wallet-funded busted-human restoration and AI auto-rebuy for SNG. Also ignore pending cash chip resets. On terminal state no further deal may start, even after a delayed timer.
- Skip SNG `recordHand`, `saveSessionStats`, shared cash localStorage and table-mission token updates. There are zero SNG wallet calls and no SNG changes to missions or D1 Poker aggregate statistics.
- HPA-172 owns the future achievement and any distinct account-side result event. That ticket must review the stats/missions distinction rather than silently reusing existing cash `handsPlayed` and `winRate` aggregates.

## UI / interaction

- `/games/poker` stays cash by default; use a plain mode link `?mode=sng`, plus a reverse link to cash. Mode selection is URL-based; don't switch modes mid-hand.
- SNG header and seat badges explicitly use *tournament chips*; hide cash session-net, rebuy, table-mission panel and initialization, account-pending round controls, cash stack/blind settings and LLM option.
- Keep existing auto-deal preference, turn timer and 5-second hand-result hold. Terminal state prevents further deals (manual or auto). **New Tournament** is a plain `<a href="/games/poker?mode=sng">` link; **Cash Poker** links to `/games/poker` rather than in-place state resets.
- Add strings for English and Traditional Chinese via existing `pokerTranslator`; render cards/seats through existing `PokerUIRenderer`. Use existing art only.

## Not included

Server authority, anti-cheat, tournament save/load, buy-in/prize economy, new game type, weekly leaderboard, seasonal competition, online rooms, lobby scheduling, user-controlled rules, extra sound/image art, compatibility migrations, or generalized round/poker abstractions.

## Acceptance criteria

- [ ] Cash Poker tests, guest bankroll, account settlement and session-stat/missions flows behave as before, except the shared all-in runout fix.
- [ ] Both guest and signed-in users start six 500-chip stacks independent of account balance, with no wallet calls or guest bankroll changes; busted human cannot be revived from positive wallet balance.
- [ ] Correct funded-seat dealer/SB/BB rotation and turn order with nonadjacent survivors and heads-up; eliminated seats never deal, blind, or act.
- [ ] Blind levels increase at hand 1/6/11/16/21, never within a hand.
- [ ] All-in board runout never stalls or lets folded/all-in AI act; preflop outstanding call/fold rights remain intact. Existing side pots and ties resolve correctly.
- [ ] A seeded simulated tournament terminates with correct placement, conserves all 3,000 chips after every hand, catches dead/stalled turns and illegal folded-seat bets, and produces no wallet calls, settled-hand events, or cash session-stat writes.
- [ ] Human bust immediately yields correct finish place and blocks next hand; winner is 1st. New Tournament reloads without stale state.
- [ ] Localized tournament UI and representative browser smoke test; focused regressions and existing test/lint/build gates pass. No new assets or schema.
