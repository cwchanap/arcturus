# HPA-725 — Poker rival table talk: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-725/poker-rival-table-talk-bubbles
**Design:** [2026-11-11-rival-table-talk-design.md](../specs/2026-11-11-rival-table-talk-design.md)
**Delivery contract:** **Exactly one PR for HPA-725.** This documentation-only draft becomes the **same implementation PR** once the design is approved. Do not open a separate coding PR or split the subtasks into multiple PRs.

## Scope and file map

This is a frontend-only poker feature; the existing six-seat game owns its state and the renderer owns its DOM.

| File | Work |
| --- | --- |
| `src/lib/poker/rivalTalk.ts` (new) | Exhaustive, typed personality/event line table, pure A/B picker and one globally prioritized end-of-hand candidate selector. |
| `src/lib/poker/rivalTalk.test.ts` (new) | A/B selection boundary and focused outcome/priority edge cases; rely on compile-time exhaustiveness for all keys. |
| `src/lib/poker/PokerGame.ts` | One hand-local display count; action hook in the AI-only funnel; outcome derived from finished recap; separate talk RNG. |
| `src/lib/poker/PokerGame.test.ts` | Seeded 50% throttle, action/end-of-hand behavior, replacement, quota, new-deal reset and cash/SNG regressions. |
| `src/lib/poker/PokerUIRenderer.ts` | One active bubble inside the rival seat, translated text, timer cleanup and replacement support. |
| `src/lib/poker/PokerUIRenderer.test.ts` | One-at-a-time DOM behavior, text/ARIA attributes, timer removal and stale callback safety. |
| `src/lib/i18n/messages/poker.ts` | Exactly 40 new short dialogue keys in each of `en`, `zh-Hant`, `zh-Hans` and `ja`; authored with Task 1. |
| `src/styles/poker.css` | Fixed portrait-overlay position within the rival seat, wrapping, click-through and reduced-motion appearance. |

**No edit needed** to `poker.astro`: the renderer can append to existing `#poker-seat-{id}` containers. Do not touch `mp-poker`, D1, wallet, game rules, mission progression, AI strategy, account state, public assets or sound.

## Task 1 — Localized copy + exhaustively typed pure helpers

**Files:** `src/lib/i18n/messages/poker.ts`, `rivalTalk.ts`, `rivalTalk.test.ts`

- [ ] **Add the keys first**, or in the same edit as the line table, so references can type-check. Supply **40 distinct dialogue keys per locale** (two options × four personalities × five events) in `en`, `zh-Hant`, `zh-Hans` and `ja`. Use short, characterful lines (≤4 English words); emoji stays in `rivalTalk.ts`, not in translations. Avoid claims of secretly knowing bluffs.
- [ ] Define `RivalTalkEvent` = `'bigPotWin' | 'bluffWin' | 'badBeat' | 'allIn' | 'sngOut'`, reuse `AIPersonality`, and type the table as `Record<AIPersonality, Record<RivalTalkEvent, readonly [RivalLine, RivalLine]>>` with `RivalLine.messageKey: MessageKey<typeof POKER_MESSAGES>`. Use explicit keys (e.g. `rivalTalkSharkAllInA`); never construct translation keys from strings.
- [ ] Implement pure `pickRivalLine(personality, event, random)` and `pickHandOutcomeTalk({ rivals, showdown, mode, bigBlind })`, which returns a **single** `{ playerId, event } | null` for all eligible rivals. **Each rival input includes `id: number` (its seat/player ID)** along with only the needed data: `personality`, contested winnings, a raise flag, `readout`, folded state, start stack and final chips. Prioritize events **globally**: `sngOut` > `badBeat` > `bigPotWin` > `bluffWin`, then lowest seat ID on ties. No probability roll inside this selector.
- [ ] Test the seeded **A/B boundary** for `pickRivalLine` and add one inexpensive assertion that each pair has **distinct message keys** (tuple typing checks length and existence, not uniqueness). The exhaustive 20-pair mapping and four-locale key parity are already checked by TypeScript/`defineMessages` (explicit Astro check in Task 4). Test real event boundaries separately: the inclusive 20-BB cutoff, all-uncalled return → zero contested award, raised walkover versus blind-only, no bad beat for a split/side-pot winner or board-only hand, final SNG bust after awards, and global priority + seat tie-break. Keep the module independent of DOM, timers and poker rule changes.

## Task 2 — Hook the existing AI action and completed-hand lifecycle

**Files:** `PokerGame.ts`, `PokerGame.test.ts`

- [ ] Add only `rivalTalkShown` (a 0–2 per-hand count) to game state. At new-hand setup beside `clearSeatActions()`/`recap.start()`, reset the count and call `ui.clearRivalTalk()`. **No `raisedRivalIds`:** the recorder already holds every actual raise and resets itself on a new hand.
- [ ] Inject a fifth, optional constructor argument `talkRandom: () => number = Math.random`, separate from `aiRandom` and `deckRandom`, so decorative dialogue cannot alter AI/deck RNG behavior. Follow the existing constructor test seam.
- [ ] Hook the **AI-only `showDecision`** (not general `noteAction`) after its existing decision display and recap recording. If `action` is `call`/`raise` and the current rival is `isAllIn`, consider `allIn`. Do not generate talk from human handlers, blinds, illegal raises converted to other actions, or a check/fold.
- [ ] Add a small `tryRivalTalk(id, event, { replace = false })`: first check the **successful display** count (<2), then for betting events call **`ui.hasActiveRivalTalk()`** and reject an already-active bubble **before consuming any RNG**. Only for eligible attempts, make one appearance roll (`talkRandom() < 0.5`); **return immediately on failure, without drawing a variant**. After a successful appearance roll, call `pickRivalLine(..., talkRandom)` for the second draw. At hand end, if quota and appearance both pass, **clear an active prior bubble before showing the outcome**; otherwise leave it untouched. Never enqueue events or duplicate active-bubble state in `PokerGame`; the renderer owns it.
- [ ] In `presentHandResult`, **after `recap.finish()`**, read `recap?.streets` to derive who raised (`events.some(e => e.playerId === id && e.action === 'raise')`). Build the pure selector inputs from existing `tiers`, `awards`, `handStartStacks`, `handBigBlind`, `readHand` and finalized chips. Reuse `contestedTiers` and `contestedAward`, but explicitly use **0** if all tiers are uncontested, rather than the display fallback. Detect `sngOut` only here, after final awards. Pass the **single globally prioritized** candidate to `tryRivalTalk(..., { replace: true })`, for exactly one probability roll per hand outcome.
- [ ] Do not change hand settlement, recap UI, cash result sounds, Sit & Go placement, or AI strategy. Test seeded 49%/50% attempts, **a failed appearance consuming exactly one RNG draw**, **an active betting bubble consuming none**, full 2-bubble quota, end-of-hand replacement without breaking quota, early next-deal reset, and representative cash/SNG cases. Existing SNG no-wallet behavior stays unchanged.

## Task 3 — One compact bubble over the portrait, owned by the renderer

**Files:** `PokerUIRenderer.ts`, `PokerUIRenderer.test.ts`, `poker.css`

- [ ] Add `showRivalTalk(playerId, line): boolean`, `clearRivalTalk(): void`, and **`hasActiveRivalTalk(): boolean`**. The query simply checks the renderer's active bubble element reference; it is used before the game consumes RNG, without extra game state. Use existing `#poker-seat-{id}` as the positioned parent and append a single **direct-child** bubble outside the portrait itself. Set translated emoji-led `textContent` and `aria-hidden="true"`; reject missing seat/active bubble. No `innerHTML`, click listener, live region, extra page markup or generic overlay manager.
- [ ] Store one bubble reference and one timeout. At **2,500 ms**, remove it and clear the reference. On early cleanup or deliberate outcome replacement, cancel the timeout first. A stale callback must not remove a newer bubble.
- [ ] Define `.poker-rival-talk` **inside the seat, over the decorative portrait**: `position: absolute`, `top: 4px`, `inset-inline: 4px`, bounded width/height, wrapping, `pointer-events: none`, high enough z-index and a minimal fade. Do **not** position above the seat, where it collides with the `top: -12px; right: -8px` chip-delta float or adjacent seats. Keep action/chip readouts readable. The subject is not folded at emission; do not add faded-seat styling rules.
- [ ] Test the existing ≤600px mobile grid explicitly: **seats 1 and 5 switch to `flex-direction: row` with 39px portraits**. A full-width `inset-inline: 4px` bubble could cover nearby rival labels/cards, so use a **seat-specific width limit or inline-start alignment under `@media (max-width: 600px)` if needed**. Keep it over the portrait portion of its seat and clear of actions, chips and adjacent seats. No viewport math or generic responsive overlay module.
- [ ] Under `prefers-reduced-motion: reduce`, suppress animation but **keep the bubble visible** for the JS timeout, unlike the existing hidden chip-delta floats.
- [ ] Renderer **JS-only tests**: one active bubble, text content, `aria-hidden`, 2.5-second expiration, clearing/replacement and stale timer cancellation. The mock DOM has **no CSS engine**: verify `pointer-events`, placement and reduced motion in the browser smoke check, not with fake computed-style assertions.

## Task 4 — Validate and finish within this PR

- [ ] Run focused tests: `bun test src/lib/poker/rivalTalk.test.ts src/lib/poker/PokerGame.test.ts src/lib/poker/PokerUIRenderer.test.ts`.
- [ ] Run **`bunx --bun astro check` first** (CI uses this; it enforces `defineMessages` locale parity and the exhaustive typed line table), then `bun run lint`, `bun run format:check`, `bun run test` and `bun run build`. Fix new diagnostics on this branch; no unrelated dependency upgrades.
- [ ] Manually smoke-test cash/SNG tables with desktop and **≤600px** phone width, particularly side seats **1/5's 39px portraits**. Confirm compact bubble text wraps **inside** its seat; action/chip badges and turn timer remain visible; chip-delta floats do not collide; clicks pass through; reduced motion leaves a static bubble until removal. Check action-in-progress, showdown replacement, multiple side-pot winners, Sit & Go elimination and rapid next-hand dealing.
- [ ] Review the diff for accidental domain, wallet, AI, multiplayer or localization-regression changes. Confirm there is **one PR for HPA-725**, update its description with evidence, and mark it ready for review only after implementation/test evidence exists.

## Definition of done

- [ ] The exhaustive typed table provides two lines for each personality/event, correctly translated in all four locales; `astro check` succeeds.
- [ ] Correct event boundaries, especially **real contested winnings**, **no unproven bluff assertion**, and **after-award SNG elimination**.
- [ ] Approximately half of eligible events show a bubble; **at most one simultaneously and two per hand**. End-of-hand reactions can replace an active all-in bubble within quota; new hands and timers leave no stale bubbles.
- [ ] No blocked clicks, obscured timer, mobile overflow, reduced-motion movement or extra screen-reader announcements.
- [ ] Poker rule engine, AI decision randomness, cash wallet settlement, Sit & Go rankings, and existing tests remain unchanged.

**Review checkpoint:** The initial draft is design/plan only; this checklist records **future** implementation/verification work. Do not claim tests passed until code has been added and run.
