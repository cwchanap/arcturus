# HPA-726 — Poker decision grade stamps: design

**Status:** Proposed for review; documentation-only draft now, implementation in this SAME PR.
**Linear:** https://linear.app/cwchanap/issue/HPA-726/poker-decision-grade-stamps-in-the-hand-recap
**Implementation plan:** [2026-11-13-poker-decision-grades.md](../plans/2026-11-13-poker-decision-grades.md)
**Delivery:** Exactly one PR for this ticket, including design review and implementation. No second implementation PR.

## Goal and visible behavior

Reward sound decisions even when a poker hand loses. In the existing recap drawer, each *manually chosen human* call, fold, or raise receives one compact icon-led grade: ⭐ **sharp**, 👍 **ok**, or ⚠️ **miss**. Checks are ungraded. A recap header displays `⭐ 2/3`, meaning two sharp decisions out of three graded actions; hide the tally when there are no graded actions. The grade reflects a deliberately approximate *visible-equity heuristic*, not a poker solver or training oracle.

Scope covers the current six-seat local cash Poker and Sit & Go because they use the same `PokerGame` and recap. Private-room poker (`src/lib/mp-poker/`), other card games, AI strategy, card rules, outcomes, wallet settlement, mission progression and persistence are unchanged. No new image assets or sounds are necessary.

## Verified current implementation boundaries

- `src/lib/poker/handRecap.ts` stores `RecapEvent { playerId, action, amount, allIn }` under each street via `HandRecapRecorder.act`. The recorder finishes into `HandRecap` and remembers only the last finished hand.
- `PokerGame.noteAction` records every real human and AI action **after** the action has mutated the relevant player's stack/bet. The four human button handlers live in `attachEventListeners`, and the AI path calls `showDecision`.
- `PokerGame.processAITurn` already constructs an AI `GameContext` with opponent hole cards stripped. `getPlayerPosition` holds the existing position policy. `estimateVisibleEquity` (`aiEquity.ts`) consumes this context and returns `equity`, `potOdds` and `callAmount`. Reuse its **equity** only for the grade: its uncapped, full-pot `potOdds` is not the odds the human sees in short-stack decisions. The HUD uses `getRaiseBounds().call` capped by remaining chips, `contestablePot` and `calculatePotOdds` (`PokerGame.ts`'s `renderBetSummary` path).
- `PokerGame.actOnTimeout` invokes `btn-check.click()` or `btn-fold.click()`. The same DOM handlers handle both deliberate and timer-forced actions: they must be distinguishable or forced folds will be falsely graded.
- `PokerUIRenderer.renderHandRecap` builds the drawer's DOM with `createElement`/`textContent` and currently assigns an action `title`. The header is in `src/pages/games/poker.astro` (`#recap-hand`, `#recap-delta`); styles live in `src/styles/poker.css`. `POKER_MESSAGES` supports `en`, `zh-Hant`, `zh-Hans` and `ja`.

## Decision policy

Define a small pure `gradeDecision({ action, equity, potOdds, callAmount }): DecisionGrade` in new `src/lib/poker/decisionGrade.ts`, where `DecisionGrade = 'sharp' | 'ok' | 'miss'` and `action: Exclude<RecapAction, 'check'>`. Checks never enter the grader: the input type enforces that requirement at compile time instead of returning `null` at runtime. `equity` is the 0–1 fraction from `estimateVisibleEquity`. When a call is actually due (`callCap > 0`), `potOdds` is the 0–1 fraction from the **HUD's short-stack-aware formula**. When checking is free, there is **no pot-odds percentage to display**; keep a `null` sentinel in the recap, distinct from the grader's numeric argument. Put the numeric thresholds together in one constants object; no configuration file, persistence or tolerance subsystem.

| Action | Sharp ⭐ | OK 👍 | Miss ⚠️ |
| --- | --- | --- | --- |
| `check` | — | — | Never passed to `gradeDecision` (ungraded by design) |
| `call` | `equity >= potOdds + 0.05` | `potOdds - 0.05 <= equity < potOdds + 0.05` | `equity < potOdds - 0.05` |
| `fold` facing a bet | `equity < potOdds` | `potOdds <= equity <= potOdds + 0.10` | `equity > potOdds + 0.10` |
| `fold` when checking is free | — | — | Always miss when `callAmount === 0` |
| `raise` | `equity >= 0.55` | `0.35 <= equity < 0.55` | `equity < 0.35` |

**Source of displayed odds (review correction):** At the instant a *valid* human fold/call/raise is chosen, use the same inputs and formula as `PokerGame.updateActionButtons` / `PokerUIRenderer.renderBetSummary`, before mutating the action or pot:

```ts
const human = this.players[0];
const call = this.getRaiseBounds().call;
const callCap = Math.min(call, human.chips);
const equity = estimateVisibleEquity(this.buildVisibleGameContext(human)).equity;
const potOdds = callCap > 0
  ? calculatePotOdds(callCap, contestablePot(this.players, human, callCap))
  : null;
// Numeric fallback is ONLY for this pure grader. A free fold is handled first;
// a raise never consults pot odds. Never store or display this fallback.
const grade = gradeDecision({ action, equity, potOdds: potOdds ?? 1, callAmount: callCap });
```

Do **not** use `estimateVisibleEquity(...).potOdds`: that uses the uncapped call and full pot and can disagree with the HUD during short-stack all-ins. For example, a short-stack fold with equity ~0.458 can be `ok` at uncapped odds ~0.455 but `miss` at the HUD's ~0.313 odds; the latter is the correct recap result. Test this mismatch explicitly. `calculatePotOdds(0, ...)` returns a **free-card sentinel `1.0`**, not a meaningful probability: call it **only for `callCap > 0`**. Store `RecapDecision.potOdds = null` for a free fold or an open-raise, and pass the numeric `potOdds ?? 1` only to the pure grader: its free-fold branch runs before comparing odds and its raise branch ignores them. `PokerUIRenderer.renderBetSummary` already uses `checkFree` instead of percentages for this situation; the recap must follow that distinction.

**Ticket ambiguity resolved:** HPA-726 says a fold is OK “within 5%” but only a miss when equity beats odds by **more than 10%**, leaving a 5–10 percentage-point interval unclassified. Treat that interval as **OK** (not a false negative from a heuristic estimate), and test both cutoffs. Exact equality at the pot-odds boundary is OK. Handle a free fold **before comparing equity with odds**: `calculatePotOdds(0, pot)` returns `1.0` and would otherwise incorrectly mark a free fold sharp.

There is no grading of rival actions, no adjustment of the AI estimator, and no game-rule recommendation injected into live gameplay.

## Recording the snapshot at the right time

Add optional metadata to the existing event, not a separate log or event stream:

```ts
type DecisionGrade = 'sharp' | 'ok' | 'miss';
type RecapDecision = { grade: DecisionGrade; equity: number; potOdds: number | null }; // null: no bet to call

// In RecapEvent:
decision?: RecapDecision;
```

Only manually chosen human calls/folds/raises carry `decision`. A check, rival action, or action forced by the timer still has a normal recap event but no `decision`. Do not add a separate grade count to `HandRecap`: the renderer derives it from existing events.

Replace the duplicated inline AI context construction with one small PokerGame method such as `buildVisibleGameContext(player: Player): GameContext`. Preserve exactly the current `minimumBet`, street, phase, board, pot, position and per-player context shape, with every other seat's hidden hand replaced by `[]`. The AI calls this same method, preserving its input and decision behavior. For a human decision, it reveals only the human's own cards.

For each valid manual action, estimate equity and snapshot **HUD-equivalent, short-stack-capped pot odds (or `null` for a free decision)** synchronously **before** `foldPlayer` / `placeBet` / any pot or bet update. In the `btn-fold` handler, add the existing `btn-raise`-style guard for `bettingRound === null`, `human.folded`, or `human.isAllIn` before calling the snapshot helper, so synthetic out-of-turn clicks never get graded. Pass the resulting lightweight metadata into `noteAction` with the existing action. Never recompute from post-action stack/pot. Since the human's `RecapEvent` is still emitted through `noteAction`, its all-in/action ordering and sound effects are unchanged.

Use one narrow synchronous `timeoutAction` flag around the existing programmatic button click (`try/finally`) and suppress metadata while it is set. Do not build a generic action-origin framework or change the button/turn-timer flow. The timeout's fold/check must remain visible in recap, just ungraded.

## Drawer UI and localization

Compact layout sketch (guidance; the Linear ticket has no attached mockup):

```text
Hand recap  #27         ⭐ 2/3     −40  ×

PREFLOP                         A♠  K♠
[You]  ↑ 20  ⭐      [Rival]  ✓
FLOP                            7♣ 9♥ Q♠
[You]  ✓           [Rival]  ↑ 50
[You]  ✓ 50  👍
```

The existing fold/check/call/raise icon and amount remain intact. Append a second, small `poker-recap-grade` icon to the **same human event** when `event.decision` exists. Never stamp AI rows, a check or a timed-out human action. Make each stamp distinguishable by glyph plus localized accessible name (not by colour alone). The emoji stamp needs **`role="img"` plus a localized `aria-label`** (rather than an unrecognized `aria-label` on a generic span); retain the rest of the existing action's accessible text. Keep the action row's existing `title` and append localized grade/equity detail there. If `decision.potOdds !== null`, reuse the translated `potOdds` key with the HUD-equivalent rounded odds. If `decision.potOdds === null`, display **equity only for an open raise**, or **equity plus existing `checkFree`** for a free fold—never `Pot odds 100%`. Round percentages for display only. The stamp label conveys the grade and relevant detail to assistive technology. **On iOS/touch, a native `title` is not a visible tooltip:** sighted mobile users see the grade glyph; do not promise tap/long-press details. No new tooltip controller, visible numeric span or prose block.

Add `#recap-grade-tally` alongside existing hand number and delta in the header; derive `sharpCount / gradedCount` from recap events. Grade icon and tally must not cover the existing action icon, numbers, drawer close button, or chip delta. **The folded action row currently has parent `opacity: 0.55`**; move the faded treatment to its existing avatar/action-icon/amount children, not the row, so its grade remains crisp and legible. The header currently has no flex wrapping and the delta uses `margin-left: auto`: add **`#recap-panel > header`-scoped wrapping/min-width rules** for the new tally at 320–390px rather than altering every drawer header. Keep CSS scoped to the recap so other drawers are untouched. Check at 320–390px as well as desktop. Use typed keys in `src/lib/i18n/messages/poker.ts` for the three grade names, accessible tally label and an equity label in all four existing locales; **reuse** the existing `potOdds` message key for the odds half. No dynamic string keys.

## Tests, constraints and deliberate non-goals

- Pure table tests cover all **eligible** decisions and boundaries (call/fold/raise), the 5–10-point fold gap, equality, and the **free-fold before pot-odds** guard with a numeric fallback; compile-time typing excludes `check`.
- PokerGame tests confirm pre-action snapshots, **HUD-equivalent odds for a short-stack call/fold where uncapped and contestable-pot odds differ**, `potOdds: null` for open raises/free folds, the extra fold-action guard, shared visible context without rivals' hole cards, manual-call/fold/raise metadata, absence for checks/rivals/timeout decisions, and unmodified AI/turn behavior.
- Recorder and renderer tests verify optional metadata (`null` odds included) survives a finished hand, stamps only on eligible rows, header `⭐ 2/3` and empty tally handling, **`role="img"` with localized labels**, free-fold `checkFree` and open-raise equity-only details (no `100%` odds), and unchanged result/delta. Existing `PokerUIRenderer.test.ts` mocks need a usable `ownerDocument` and `replaceChildren(...nodes)` to exercise this renderer method.
- Playwright browser smoke verifies that a manual human fold row has **exactly one** `.poker-recap-grade` regardless of its actual grade (the deck is not seeded). Use the existing `PokerGame.test.ts` fake-timer integration harness for timeout-forced action exclusion rather than a flaky 20-second browser wait. Manual visual verification covers grade glyph placement and no clipping on iOS Safari at phone width (not a `title` tooltip), plus macOS Safari/Chrome and Windows Edge; compare against the sketch above because no Linear UI mockup is attached.

No server changes, migrations, statistics, historical grades, analytics, player profiles, coaching text, strict input validation for trusted in-process fractions, or settings toggle. This is presentation feedback only: any ungraded existing recap remains valid, and old recap instances require no migration.
