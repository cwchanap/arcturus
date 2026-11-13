# HPA-725 — Poker rival table talk: design

**Status:** Implemented (PR for HPA-725)
**Linear:** https://linear.app/cwchanap/issue/HPA-725/poker-rival-table-talk-bubbles
**Implementation plan:** [2026-11-11-rival-table-talk.md](../plans/2026-11-11-rival-table-talk.md)

## Goal and player experience

Give the existing rule-based poker rivals short, personality-specific reactions at notable moments. One noninteractive bubble appears **inside a rival seat, over its decorative portrait**, for approximately 2.5 seconds and disappears automatically. It works in **cash Poker and local Sit & Go**. It is decorative: players can still read the actions, click cards/buttons, and see the turn timer.

This is a small poker-owned feature, not a dialogue system. No LLM inference, new portrait art, audio, server API, storage, schema or game-rule changes. Private-room multiplayer (`src/lib/mp-poker/`) is out of scope.

## Existing code and boundaries (current `main`)

- `src/lib/poker/PokerGame.ts` owns the seat array, per-hand state, AI configurations, and action lifecycle. `noteAction(playerId, action, amount)` records actions after bet mutations; **`showDecision` is the AI-only action funnel** and is the appropriate place to detect rival all-ins. Human actions bypass it.
- `presentHandResult(awards, tiers, showdown)` runs once the hand has been awarded. It already separates *contested* tiers from returned, uncalled bets, sees per-seat final stacks, renders the recap and knows the current `handBigBlind`. Both walkovers and real showdowns call it. `finishHand` then determines the tournament's terminal state.
- `handStartStacks` is captured before posting blinds; `aiConfigs` contains the four existing `AIPersonality` values. Seats have stable player IDs, even after a Sit & Go elimination.
- `src/lib/poker/handRecap.ts` already stores each successful `raise` in the hand's street events and exposes those events in the finished `HandRecap` returned by `recap.finish()`; there is no need to track raised rival IDs again.
- `PokerUIRenderer` owns DOM work; the page (`src/pages/games/poker.astro`) already renders `#poker-seat-{id}` for each rival. Seats are positioned in `src/styles/poker.css`; rival chip-delta floats occupy the **top-right outside edge** of each seat, so the talk bubble must not appear above the seat.
- The existing `pokerTranslator` and `POKER_MESSAGES` provide `en`, `zh-Hant`, `zh-Hans` and `ja` translations. `defineMessages` enforces matching key sets at compile time. Do not create a parallel localization mechanism.

## Events and their exact meanings

Only AI players (IDs 1–5 with a configured personality) can speak. A human action must never create a rival bubble.

| Event | Detection point | Condition |
| --- | --- | --- |
| `allIn` | `showDecision` (AI only) | The actual recorded `call` or `raise` leaves the rival `isAllIn` **after** the bet is placed. No trigger for a blind, illegal/unaffordable raise (the game converts these to calls or checks), check, fold or human action. |
| `bigPotWin` | `presentHandResult` | Rival wins a contested pot and nets **at least 20 × the current hand's big blind** (`chips - startStack >= 20 × bigBlind`). Exclude unmatched/uncalled returns and own matched chips; do not use gross pot size alone. |
| `bluffWin` | `presentHandResult` | Rival takes a **contested** pot without showdown after making at least one recorded `raise` in `recap.streets` during the hand (this action also represents a bet in the existing engine). A blind-only walkover or return of an uncalled bet is not a bluff event. It is a *playful aggression proxy*, not knowledge of hidden cards or proof the rival bluffed. |
| `badBeat` | `presentHandResult` | Rival reaches a **contested showdown**, has a two-pair-or-better `readHand` that uses a hole card, yet receives **no contested award**. Do not label a folded rival, split-pot winner, or side-pot winner a bad beat. |
| `sngOut` | `presentHandResult` | In `mode === 'sng'`, after all final awards, an AI who started this hand funded (`handStartStacks[id] > 0`) has `chips === 0`. Never trigger on the temporary zero balance of a mid-hand all-in or on cash auto-rebuys. |

The existing `HAND_RANKINGS`/`readHand` helpers are sufficient; do not evaluate poker hands again or change the payout logic. For talk eligibility, **a pot consisting entirely of uncalled returns contributes zero contested winnings** even though the existing result-banner fallback may show an amount.

Derive `raised` from the just-finished recap: `recap.streets.some(street => street.events.some(e => e.playerId === id && e.action === 'raise'))`. The existing AI action funnel already converts invalid raises before recording them. For each completed hand, a small **pure `pickHandOutcomeTalk({ rivals, showdown, mode, bigBlind })`** evaluates all rivals from finalized awards, the recap and stacks. **Each rival input includes `id: number`** alongside personality, contested winnings, raise flag, hand readout, folded status, starting stack and final chips. The selector returns **one** `{ playerId, event } | null` using global priority `sngOut` > `badBeat` > `bigPotWin` > `bluffWin`, with lowest seat ID as a deterministic tiebreak. Make just one probability roll for that candidate, not one per eligible seat. No duplicated aggression state, new event bus or notification pipeline.

## Line selection and throttle

Create `src/lib/poker/rivalTalk.ts` with the five-event union, a fully typed `Record<AIPersonality, Record<RivalTalkEvent, readonly [RivalLine, RivalLine]>>` mapping, a pure `pickRivalLine(personality, event, random)` returning `{ emoji, messageKey }`, and the small pure end-of-hand candidate selector. The message key uses `MessageKey<typeof POKER_MESSAGES>`. The exhaustive table has exactly two options per personality/event pair: **4 × 5 × 2 = 40 keys per locale**, 160 localized strings total.

- Keep `emoji` separate from the translated text and concatenate via `textContent` in the renderer. The line is emoji-led, playful, at most four short words in English; use similarly compact expressions in Chinese and Japanese. Do not generate lines with AI.
- Use translation keys consistent with `POKER_MESSAGES`, e.g. `rivalTalkSharkBigPotWinA` / `rivalTalkSharkBigPotWinB`. Type-check the keys against the translator. All four personalities must have both options for all five events, in all four locales.
- Each AI all-in action is considered once; each hand produces at most one end-of-hand candidate. With **two successful bubbles already shown in the hand**, drop further events. For betting-time events, query `ui.hasActiveRivalTalk()` **before any RNG draw** and drop if already visible. Otherwise draw once for appearance (`talkRandom() < 0.5`); **only when this passes**, draw again for the A/B line variant using `pickRivalLine`. Failed appearance rolls consume exactly one draw. Only a **successfully rendered** bubble consumes one of the two hand slots.
- During betting, drop an all-in event if a bubble is already active (no queue). For an **end-of-hand** candidate that passes its 50% roll and still has quota, **replace** an active action bubble: clear its node/timer, then render the outcome line. If the roll fails or quota is exhausted, leave the old bubble alone. This preserves the showdown payoff without violating one at a time/two per hand.
- A new deal resets only the hand-local display count and any stale bubble. The recap already resets itself for each hand; no parallel raised-ID set or its reset is needed. No old timer may dismiss a newer bubble.
- Keep talk RNG independent from AI strategy RNG; changes in decorative chatter must not change opponents' decisions. A small optional injected RNG is sufficient for deterministic tests—no seeded random subsystem.

The throttle needs only a count and a small helper in `PokerGame`, plus a **separate fifth-argument talk RNG** (default `Math.random`), not an additional set of action history. The renderer is the sole owner of active DOM state and exposes `hasActiveRivalTalk(): boolean` (based on the existing bubble element reference, not a duplicated game flag). Avoid new state machines, controllers or services solely for chatter.

## Presentation and lifecycle

Add `PokerUIRenderer.showRivalTalk(playerId, line): boolean`, `clearRivalTalk(): void`, and `hasActiveRivalTalk(): boolean`; the renderer translates `line.messageKey` and renders one bubble as a **direct child of the existing rival seat**. If the seat is unavailable or a bubble is active, return `false` without consuming a quota; `PokerGame` explicitly clears an active bubble first only when a selected end-of-hand reaction is replacing it.

- Create a text-only element with `aria-hidden="true"` and `pointer-events: none`. No live region, modal/focus change, screen-reader announcement, extra button or turn-timer interaction. Use `textContent`, not `innerHTML`.
- Bubble stays **2,500 ms** (`RIVAL_TALK_MS`, which also drives the CSS `animationDuration`); CSS animates a subtle appearance and fade at the end. One timeout removes it. `clearRivalTalk` cancels that timeout and removes the prior node.
- **Fixed placement:** overlay the seat's decorative portrait, **not the space above the seat**. `#poker-seat-{id}` is already `position: relative`; append the bubble directly inside it (outside `.poker-portrait`) below the top-right chip-delta float (`top: 34px` on desktop, `28px` on `≤900px`, `24px` on `≤600px` top seats) with bounded horizontal inset (`inset-inline: 4px`) and natural text wrapping without mid-line clipping. At ≤600px, seats 1 and 5 switch to **row-oriented flex layout** with 39px portraits; keep their bubble top-left (`top: 4px; left: 4px; right: auto; max-inline-size: calc(100% - 62px)`) over the portrait area without reflowing `.poker-rival` and clear of the top-right chip-delta float, cards, and action/chip readout.
- Only live rivals can speak: the all-in actor, uncontested winner, showdown loser or just-eliminated all-in rival is not folded at the event point. **Do not add a folded-seat styling subsystem.** Mount the talk element outside `.poker-portrait` so the existing eliminated-portrait dimming does not also dim the text.
- Honor `prefers-reduced-motion` by removing fade/translation animation, **not** by hiding the bubble; it still disappears on schedule. The existing global-in-room reduced-motion CSS already disables animation and transition.
- `PokerGame` clears the prior bubble at the start of each new hand. No cleanup needs to be added to account settlement, wallet or tournament scoring.

## Tests and acceptance

1. **Astro type-check** enforces all locale keys, all 20 personality/event combinations and two line variants per combination; one seeded runtime test verifies the A/B boundary. No redundant runtime sweep of the exhaustively typed table or hand-rolled locale-key tests.
2. Pure event tests cover each trigger and counterexample: genuine raised walkover versus blinds-only; the inclusive 20-BB boundary; uncalled return; tie/side-pot payout; weak hand or board-only two pair; rival showdown loss; final Sit & Go bust versus a mid-hand all-in; and **global** end-of-hand priority with seat tiebreak.
3. Deterministic throttle tests cover 49%/50% draws, **only one RNG draw on an appearance miss**, no draw while a betting bubble is already active, one bubble on screen, two successful bubbles per hand, outcome replacement **at showdown**, new-hand reset and stale timer cleanup. The renderer's JS tests cover `textContent`, `aria-hidden`, removal at 2.5s and stale-timer cancellation; **CSS pointer-events and reduced-motion are manual/browser checks**, not assertions against a mock DOM without a CSS engine.
4. Browser smoke checks in **cash and Sit & Go**, desktop and narrow phone viewport (especially the 39px-portrait side seats): speech wraps within the seat, never prevents actions or obscures timer/chips, and remains static but visible under reduced motion. Existing poker gameplay, AI decisions, hand recap, side pots, cash settlement and Sit & Go rankings stay unchanged.

**Out of scope:** generated art/SFX, LLM dialogue, portrait mood variants, player chat, private-room Poker, stored dialogue history, analytics, wallet/mission updates, new dependencies or compatibility layers.
