# HPA-725 — Poker rival table talk: design

**Status:** Proposed (documentation-only draft PR; implementation follows on this same PR)
**Linear:** https://linear.app/cwchanap/issue/HPA-725/poker-rival-table-talk-bubbles
**Implementation plan:** [2026-11-11-rival-table-talk.md](../plans/2026-11-11-rival-table-talk.md)

## Goal and player experience

Give the existing rule-based poker rivals short, personality-specific reactions at notable moments. One noninteractive bubble appears above an AI seat for approximately 2.5 seconds and disappears automatically. It works in **cash Poker and local Sit & Go**. It is decorative: players can still read the actions, click cards/buttons, and see the turn timer.

This is a small poker-owned feature, not a dialogue system. No LLM inference, new portrait art, audio, server API, storage, schema or game-rule changes. Private-room multiplayer (`src/lib/mp-poker/`) is out of scope.

## Existing code and boundaries (current `main`)

- `src/lib/poker/PokerGame.ts` owns the seat array, per-hand state, AI configurations, and action lifecycle. `noteAction(playerId, action, amount)` records both AI and human actions after bet mutations; `showDecision` passes AI moves through it.
- `presentHandResult(awards, tiers, showdown)` runs once the hand has been awarded. It already separates *contested* tiers from returned, uncalled bets, sees per-seat final stacks, renders the recap and knows the current `handBigBlind`. Both walkovers and real showdowns call it. `finishHand` then determines the tournament's terminal state.
- `handStartStacks` is captured before posting blinds; `aiConfigs` contains the four existing `AIPersonality` values. Seats have stable player IDs, even after a Sit & Go elimination.
- `PokerUIRenderer` owns DOM work; the page (`src/pages/games/poker.astro`) already renders `#poker-seat-{id}` for each rival. Seats are positioned in `src/styles/poker.css`; existing mobile breakpoints and reduced-motion CSS apply.
- The existing `pokerTranslator` and `POKER_MESSAGES` provide `en`, `zh-Hant`, `zh-Hans` and `ja` translations. Do not create a parallel localization mechanism.

## Events and their exact meanings

Only AI players (IDs 1–5 with a configured personality) can speak. A human action must never create a rival bubble.

| Event | Detection point | Condition |
| --- | --- | --- |
| `allIn` | `noteAction` | Rival's recorded `call` or `raise` actually leaves that player `isAllIn` after the bet is placed; no trigger for a blind, failed raise, check, fold or human action. |
| `bigPotWin` | `presentHandResult` | Rival receives contested pot winnings of **at least 20 × the current hand's big blind**. Exclude unmatched/uncalled returns; do not use total pot size alone. |
| `bluffWin` | `presentHandResult` | Rival takes a pot **without showdown** after having made at least one actual `raise` during that hand (this action also represents a bet in the existing engine). A blind-only walkover is not a bluff event. It is a *playful aggression proxy*, not knowledge of hidden cards or proof the rival bluffed. |
| `badBeat` | `presentHandResult` | Rival reaches a **contested showdown**, has a two-pair-or-better `readHand` that uses a hole card, yet receives **no contested award**. Do not label a folded rival, split-pot winner, or side-pot winner a bad beat. |
| `sngOut` | `presentHandResult` | In `mode === 'sng'`, after all final awards, an AI who started this hand funded (`handStartStacks[id] > 0`) has `chips === 0`. Never trigger on the temporary zero balance of a mid-hand all-in or on cash auto-rebuys. |

The existing `HAND_RANKINGS`/`readHand` helpers are sufficient; do not evaluate poker hands again or change the payout logic. For talk eligibility, **a pot consisting entirely of uncalled returns contributes zero contested winnings** even though the existing result-banner fallback may show an amount.

Maintain one hand-local `Set<number>` of rival IDs that actually raised, populated in `noteAction` and cleared when a new hand is dealt. Resolve end-of-hand candidates after awards from the existing `tiers` and stacks; no new event bus or notification pipeline. If several end-of-hand events apply to the same rival, use the more expressive one first: `sngOut` > `badBeat` > `bigPotWin` > `bluffWin`. Different rivals can be eligible, but only one bubble can be active.

## Line selection and throttle

Create `src/lib/poker/rivalTalk.ts` with the five-event union, a small typed mapping for four personalities, and a **pure** `pickRivalLine(personality, event, random)` returning `{ emoji, messageKey }` (or `null` if no line exists). Exactly two distinct lines exist for each personality/event pair: **4 × 5 × 2 = 40 keys per locale**, 160 localized strings total.

- Keep `emoji` separate from the translated text and concatenate via `textContent` in the renderer. The line is emoji-led, playful, at most four short words in English; use similarly compact expressions in Chinese and Japanese. Do not generate lines with AI.
- Use translation keys consistent with `POKER_MESSAGES`, e.g. `rivalTalkSharkBigPotWinA` / `rivalTalkSharkBigPotWinB`. Type-check the keys against the translator. All four personalities must have both options for all five events, in all four locales.
- Each eligible event is considered once. If there is already a bubble, or two have appeared in this hand, drop the event (do **not** enqueue). Otherwise use a separate RNG draw: show with `random() < 0.5`, then use `pickRivalLine` with the next draw to choose A or B. Only a **successfully rendered** bubble counts against the two-per-hand budget.
- A new deal resets the hand-local count, raised-ID set, and any stale bubble. No timers survive an old bubble and accidentally dismiss a newer one.
- Keep talk RNG independent from AI strategy RNG; changes in decorative chatter must not change opponents' decisions. A small optional injected RNG is sufficient for deterministic tests—no seeded random subsystem.

The throttle can be a handful of state and a helper in `PokerGame`; the renderer only tracks whether a DOM bubble is active. Avoid new state machines, controllers or services solely for chatter.

## Presentation and lifecycle

Add a small `PokerUIRenderer.showRivalTalk(playerId, line): boolean` and `clearRivalTalk(): void`; the renderer translates `line.messageKey` and renders one bubble inside the existing rival seat. If the seat is unavailable or one bubble is already active, return `false` without consuming a quota.

- Create a text-only element with `aria-hidden="true"` and `pointer-events: none`. No live region, modal/focus change, screen-reader announcement, extra button or turn-timer interaction. Use `textContent`, not `innerHTML`.
- Bubble stays about **2,500 ms**; CSS animates a subtle appearance and fade at the end. One timeout removes it. `clearRivalTalk` cancels that timeout and removes the prior node.
- Keep the existing portrait, action badge and amount deltas legible. Position above the seat, with bounded width and wrapping; use the existing mobile layout at ≤600px. Do not clip the bubble offscreen or let it cover action buttons/timer. Treat greyed/folded/eliminated seats carefully so their text remains readable.
- Honor `prefers-reduced-motion` by removing fade/translation animation, **not** by hiding the bubble; it still disappears on schedule. The existing global-in-room reduced-motion CSS already disables animation and transition.
- `PokerGame` clears the prior bubble at the start of each new hand. No cleanup needs to be added to account settlement, wallet or tournament scoring.

## Tests and acceptance

1. Table-driven unit tests cover all **20 personality/event pairs** and both seeded line choices, and verify all **40** keys are available in all four locales.
2. Pure event tests cover each trigger and counterexample: genuine raised walkover versus blinds-only; the 20-BB boundary; uncalled return; tie/side-pot payout; weak hand or board-only two pair; rival showdown loss; human actions; final Sit & Go bust versus a mid-hand all-in.
3. Deterministic throttle tests cover 49%/50% draws, one bubble on screen, two successfully shown per hand, drop-while-active behavior, new-hand reset and stale timer cleanup. The renderer's DOM test checks `aria-hidden`, `pointer-events` via CSS, removal at 2.5s, and reduced-motion behavior.
4. Browser smoke checks in **cash and Sit & Go**, desktop and narrow phone viewport: speech never prevents action controls, obscures the timer or overruns the table. Existing poker gameplay, AI decisions, hand recap, side pots, cash settlement and Sit & Go rankings stay unchanged.

**Out of scope:** generated art/SFX, LLM dialogue, portrait mood variants, player chat, private-room Poker, stored dialogue history, analytics, wallet/mission updates, new dependencies or compatibility layers.
