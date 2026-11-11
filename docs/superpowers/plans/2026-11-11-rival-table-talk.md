# HPA-725 — Poker rival table talk: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-725/poker-rival-table-talk-bubbles
**Design:** [2026-11-11-rival-table-talk-design.md](../specs/2026-11-11-rival-table-talk-design.md)
**Delivery contract:** **Exactly one PR for HPA-725.** This documentation-only draft becomes the **same implementation PR** once the design is approved. Do not open a separate coding PR or split the subtasks into multiple PRs.

## Scope and file map

This is a frontend-only poker feature; the existing six-seat game owns its state and the renderer owns its DOM.

| File | Work |
| --- | --- |
| `src/lib/poker/rivalTalk.ts` (new) | Typed event/personality/line map, pure line picker, small pure outcome predicates. |
| `src/lib/poker/rivalTalk.test.ts` (new) | Seeded line choices, event boundaries, priority and locale key coverage. |
| `src/lib/poker/PokerGame.ts` | Hand-local chatter budget and aggression set; action/end-of-hand hooks; distinct injected RNG for testability. |
| `src/lib/poker/PokerGame.test.ts` | Integration tests for genuine AI events, no human or duplicate triggers, reset and throttling. |
| `src/lib/poker/PokerUIRenderer.ts` | One active bubble, translation, timer cleanup, no pointer or accessibility interference. |
| `src/lib/poker/PokerUIRenderer.test.ts` | One-at-a-time DOM behavior, timer removal and interrupted hand cleanup. |
| `src/lib/i18n/messages/poker.ts` | Exactly 40 new short dialogue keys for each of `en`, `zh-Hant`, `zh-Hans` and `ja`. |
| `src/styles/poker.css` | Bubble appearance, bounded placement, mobile tweaks and reduced-motion styling. |

**No edit needed** to `poker.astro`: the renderer can append to existing `#poker-seat-{id}` containers. Do not touch `mp-poker`, D1, wallet, game rules, mission progression, AI strategy, account state, public assets or sound.

## Task 1 — Pure line and event helpers

**Files:** `rivalTalk.ts`, `rivalTalk.test.ts`

- [ ] Define `RivalTalkEvent` = `'bigPotWin' | 'bluffWin' | 'badBeat' | 'allIn' | 'sngOut'`, reuse the existing `AIPersonality` union, and map each of the 20 combinations to a pair of typed `{ emoji, messageKey }` values. Use explicit identifiers (e.g. `rivalTalkSharkAllInA`); no dynamic translation-key construction.
- [ ] Implement `pickRivalLine(personality, event, random)` with deterministic first/second choice. Keep this function free from DOM, timers and mutable module-global state.
- [ ] Keep outcome detection in small pure predicates or one compact `pickRivalOutcomeEvent` with only the data actually needed: showdown, contested chips received, current big blind, raised-this-hand flag, evaluated rank/hole-card use, mode, starting/final chips. Preserve the priority `sngOut` > `badBeat` > `bigPotWin` > `bluffWin` when multiple events apply to one rival.
- [ ] Unit-test both choices for each personality/event; the 20-BB inclusive boundary; contested award vs uncalled return; aggression required for a walkover; no bad-beat label for split/side-pot winner or board-only hands; and SNG after-award elimination rather than temporary all-in zero.

## Task 2 — Hook only the existing poker lifecycle

**Files:** `PokerGame.ts`, `PokerGame.test.ts`

- [ ] Add `raisedRivalIds: Set<number>` and `rivalBubblesThisHand` (0–2) on the game. Reset them and call `ui.clearRivalTalk()` during the existing new-hand reset beside `clearSeatActions()` and `recap.start()`. Do not reset counters on street transitions.
- [ ] Keep chatter randomness **independent of `aiRandom`**; use a small optional fifth constructor RNG argument or equivalent injectable local function, defaulting to `Math.random`. This must not change AI decision order or game outcomes.
- [ ] In `noteAction`, only for configured rivals: record a successful `raise` in the set, and try `allIn` after the actual `call`/`raise` placed the player all-in. Keep the existing recap and SFX path intact. Human and blind actions do not emit talk.
- [ ] Add a small `tryRivalTalk(playerId, event)`: if no active bubble, count <2 and `talkRandom() < 0.5`, select one of two lines and ask `ui.showRivalTalk` to render it; increment the count **only on success**. No queue, promise, delay loop or centralized event bus.
- [ ] In `presentHandResult`, after awards but before `finishHand`, derive the rival outcomes from existing `tiers`, `awards`, `handStartStacks`, `handBigBlind`, `readHand` and `raisedRivalIds`. Reuse `contestedTiers`/returned-chip accounting but explicitly make the all-uncalled case a **zero** contested win for chatter. Detect `sngOut` here, not in mid-hand bet handling and not by polling tournament UI.
- [ ] Check multiple eligible rivals in stable seat order, without emitting more than one active bubble. Do not change hand settlement, UI recap rendering, cash result sounds, Sit & Go placement or AI policy.
- [ ] Use existing game test helpers and fake timers to verify two bubbles maximum per hand, one on screen, 50% selection with seeded RNG, suppressed while active, next-hand reset, all-in after an actual wager, and representative cash/SNG outcome events. Preserve no-wallet behavior for SNG.

## Task 3 — One text bubble owned by the renderer

**Files:** `PokerUIRenderer.ts`, `PokerUIRenderer.test.ts`, `poker.css`

- [ ] Add `showRivalTalk(playerId, line): boolean` and `clearRivalTalk(): void`. Find the existing `#poker-seat-{id}`; reject missing seats or an active bubble. Create one element, set translated emoji-led `textContent` and `aria-hidden="true"`, then append to the seat. No `innerHTML`, click listener, live region, extra page markup or generic overlay manager.
- [ ] Store one bubble reference and one timeout. At **2,500 ms**, remove the bubble and clear the reference. On early cleanup, `clearTimeout` first; a stale callback must not remove a later bubble.
- [ ] Add isolated `.poker-rival-talk` CSS near the existing seat/portrait styles: absolute above seat, a compact felt/gold treatment, max width bounded to viewport, wrapped words, visible z-index, `pointer-events: none`, and simple fade. Check the existing `data-folded`/`data-eliminated` opacity effects and make talk readable without changing normal seat appearance.
- [ ] Check the existing ≤600px mobile seat grid and adjust only this bubble's position/width as needed. No horizontal scroll, overlay on the human turn timer/action controls, or interference with chip-delta badges.
- [ ] Under `prefers-reduced-motion: reduce`, suppress the animation but keep the static bubble for its same timeout. Do not copy the existing rule that hides animated chip-delta elements, because talk must still be visible.
- [ ] Renderer tests: one bubble at a time, translation text, aria-hidden, click-through style, 2.5-second expiration, clearing on new hand, stale timer cancellation. Reuse the existing DOM mocks or happy-dom; do not introduce a test framework.

## Task 4 — Four-locale dialogue, concise and characterful

**Files:** `src/lib/i18n/messages/poker.ts`, `rivalTalk.test.ts`

- [ ] Supply two distinct, compact lines for each combination of **Shark (tight-aggressive), Maniac (loose-aggressive), Rock (tight-passive), Station (loose-passive)** and **big-pot win, aggression walkover, bad beat, all-in, SNG elimination**.
- [ ] Add all **40 keys per locale** in the same key ordering in `en`, `zh-Hant`, `zh-Hans` and `ja`. English lines have at most four short words; Chinese/Japanese convey the same personality in minimal text. The emoji comes from `rivalTalk.ts`; the translation contains only the words.
- [ ] Use the existing `pokerTranslator` and make missing keys a compile-time/test failure. Check the 160 strings for placeholders, width and accidental copy/paste mismatches.
- [ ] Keep language playful; `bluffWin` reactions must not imply that the program secretly inspected a folded opponent's cards.

## Task 5 — Validate and finish within this PR

- [ ] Run focused tests: `bun test src/lib/poker/rivalTalk.test.ts src/lib/poker/PokerGame.test.ts src/lib/poker/PokerUIRenderer.test.ts`.
- [ ] Run `bun run lint`, `bun run format:check`, `bun run test` and `bun run build`. Fix any new diagnostics on this branch; no unrelated dependency upgrades.
- [ ] Manually smoke-test cash/SNG tables with a narrow phone viewport and desktop width. Check at least: action in progress, showdown, multiple side-pot winners, eliminated SNG seat, rapid next-hand dealing, and reduced-motion settings. Ensure controls and the turn timer remain visible.
- [ ] Review the diff for accidental domain, wallet, AI, multiplayer or localization-regression changes. Confirm there is **one PR for HPA-725**, update its description with evidence, and mark it ready for review only after implementation/test evidence exists.

## Definition of done

- [ ] Every eligible event/personality combination has two selectable, correctly translated lines in all four locales.
- [ ] Correct event boundaries, especially **real contested winnings**, **no unproven bluff assertion**, and **after-award SNG elimination**.
- [ ] Approximately half of events show a bubble; **at most one simultaneously and two per hand**. New hands and timers leave no stale bubbles.
- [ ] No blocked clicks, obscured timer, mobile overflow, reduced-motion movement or extra screen-reader announcements.
- [ ] Poker rule engine, AI decision randomness, cash wallet settlement, Sit & Go rankings, and existing tests remain unchanged.

**Review checkpoint:** The initial draft is design/plan only; this checklist records **future** implementation/verification work. Do not claim tests passed until code has been added and run.
