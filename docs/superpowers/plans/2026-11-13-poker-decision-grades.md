# HPA-726 — Poker decision grade stamps: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-726/poker-decision-grade-stamps-in-the-hand-recap
**Design:** [2026-11-13-poker-decision-grades-design.md](../specs/2026-11-13-poker-decision-grades-design.md)
**PR contract:** **ONE PR only** for HPA-726. This branch and draft PR start with the spec/plan; add implementation and tests to the SAME PR after design review. Do not open a second implementation PR. No new art/SFX task is needed.

## File map

| Path | Minimal change |
| --- | --- |
| `src/lib/poker/decisionGrade.ts` (new) | Pure typed grade function with one threshold constants block; heuristic disclaimer. |
| `src/lib/poker/decisionGrade.test.ts` (new) | Boundary matrix for call, fold, raise and free-fold; check excluded by input type. |
| `src/lib/poker/handRecap.ts` | Optional `RecapDecision` metadata on each human `RecapEvent`; `potOdds: number | null` when checking is free; no new recorder or tally state. |
| `src/lib/poker/handRecap.test.ts` | Normal/graded events, finish retaining metadata, existing last-hand/reset behavior. |
| `src/lib/poker/PokerGame.ts` | Shared visible-context builder, pre-mutation equity plus HUD contestable-pot odds snapshots, timer-forced action exclusion. |
| `src/lib/poker/PokerGame.test.ts` | Human action integration, no AI grades, timer click path, preserved AI redaction/rules. |
| `src/lib/poker/PokerUIRenderer.ts` | Stamp eligible actions, compute `sharp / graded` tally, translated accessible details. |
| `src/lib/poker/PokerUIRenderer.test.ts` | Stamp and tally DOM behavior; minimal test mock `ownerDocument`/`replaceChildren` corrections and ARIA assertions. |
| `src/pages/games/poker.astro` | One compact `#recap-grade-tally` element in the existing recap header. |
| `src/lib/i18n/messages/poker.ts` | Four-locale grade names/tally/equity copy; reuse existing `potOdds` key. |
| `src/styles/poker.css` | Scoped compact stamp, fold-opacity fix so grade is not dimmed, and phone-width header wrapping. |
| `e2e/poker-turn-flow.spec.ts` | One non-seeded browser smoke asserting a manually chosen human fold has one stamp (any grade); timer exclusion stays in the existing fake-timer unit integration harness. |

No edits to `src/lib/mp-poker`, AI scoring/rules, multiplayer, D1, wallet, asset files, sound, or mission state. Keep the existing recorder/renderer split.

## Task 1 — Pure grade policy with explicit edges

**Files:** `decisionGrade.ts`, `decisionGrade.test.ts`.

- [ ] Export `DecisionGrade` and pure `gradeDecision({ action, equity, potOdds, callAmount }): DecisionGrade`. Type `action` as `Exclude<RecapAction, 'check'>` from `handRecap`, so checks cannot be graded at compile time (they do **not** enter the function; no runtime `null` path). In `fold`, test `callAmount === 0` **first** and return `'miss'`; use the threshold table in the spec for the rest.
- [ ] Put `CALL_SHARP_MARGIN = 0.05`, `CALL_OK_MARGIN = 0.05`, `FOLD_MISS_MARGIN = 0.10`, `RAISE_SHARP = 0.55` and `RAISE_OK = 0.35` together. No need to expose settings. Document once: `estimateVisibleEquity` is an approximation, not solved equity.
- [ ] Explicitly make folding at/between odds and odds+10 points `ok`, including the ticket's previously unspecified 5–10-point gap; only `> 10` above odds is `miss`. Unit-test strict versus inclusive boundaries with safe example fractions.
- [ ] Matrix-test a sharp/ok/miss call; sharp/ok/miss fold; a free fold with `callAmount: 0` and grader-only `potOdds: 1` fallback; and three raise tiers. Tests and typing must show a `check` is handled by its caller, not this grader. A free-card sentinel is **never saved to `RecapDecision.potOdds` or displayed**. Chip-call sizing does not change the policy beyond `callAmount === 0`; the supplied odds are already calculated by the HUD-equivalent caller.

## Task 2 — Recap metadata and one shared visible context

**Files:** `handRecap.ts`, `handRecap.test.ts`, `PokerGame.ts`, `PokerGame.test.ts`.

- [ ] Add optional `RecapDecision { grade: DecisionGrade, equity: number, potOdds: number | null }` on `RecapEvent` (`null` when no bet needs calling). Keep the recorder as the only storage owner; copy the optional metadata into the street event and let `finish` preserve it, including `null`. Do not precompute grades at recap render time.
- [ ] Extract `PokerGame.buildVisibleGameContext(player)` from existing `processAITurn` inline context (currently around its `sanitizedPlayers` local). Preserve the AI's exact context fields and player position. Keep every opponent's `hand` empty in the context, including when the subject is the human; never mutate the real `this.players`.
- [ ] Add a focused PokerGame test for shared context redaction and preserved AI behavior. Do not alter `estimateVisibleEquity` or `getPlayerPosition`.

## Task 3 — Grade only deliberate human actions, before mutation

**Files:** `PokerGame.ts`, `PokerGame.test.ts`.

- [ ] Introduce a private `snapshotHumanDecision(action: Exclude<RecapAction, 'check'>): RecapDecision | undefined`, invoked **only** by validated manual fold/call/raise handlers. Compute the two fractions from their intended sources **before mutation** (the grader must never use `estimateVisibleEquity(...).potOdds`):

  ```ts
  const human = this.players[0];
  const call = this.getRaiseBounds().call;
  const callCap = Math.min(call, human.chips);
  const equity = estimateVisibleEquity(this.buildVisibleGameContext(human)).equity;
  const potOdds = callCap > 0
    ? calculatePotOdds(callCap, contestablePot(this.players, human, callCap))
    : null;
  // Grader-only fallback: free folds return 'miss' before comparing odds;
  // raises ignore odds. Never persist or show 1.0 as free-card odds.
  const grade = gradeDecision({ action, equity, potOdds: potOdds ?? 1, callAmount: callCap });
  ```

  This is the **same cap and contestable-pot formula as the live HUD** **when there is a bet to call**, including short-stack/all-in decisions. When `callCap === 0` the HUD says `checkFree` rather than **pot odds 100%**: store `potOdds: null`, use the numeric `?? 1` fallback **only** for the pure grader (its free-fold guard runs first and raises ignore odds). Return no metadata when `timeoutAction` is true; do not invoke for checks. Do not cache/persist estimated equity or alter AI estimation.
- [ ] Extend existing `noteAction(playerId, action, amount = 0, decision?)` to pass optional metadata to `this.recap.act`. Rival `showDecision` continues calling `noteAction` without metadata, so AI actions stay ungraded.
- [ ] In valid `btn-fold`, `btn-call` and `btn-raise` handlers, obtain the snapshot **before** `foldPlayer` / `placeBet` and before `this.pot = calculatePot`; pass it through existing `noteAction` after the action. **Extend the existing fold-click guard** (`PokerGame.ts:1844`) to reject `bettingRound === null`, `human.folded`, and `human.isAllIn` like the existing raise guard, before computing a snapshot; keep all existing legal-fold behavior, amounts, all-in, sounds and settlement unchanged. Do not compute for invalid/disabled button attempts.
- [ ] `actOnTimeout` currently clicks those buttons, so wrap only its programmatic click with a synchronous `timeoutAction` flag and `try/finally` reset. The click handler checks the flag before estimating; the timer path still records the actual check/fold but without grade metadata. Do not infer origin from timestamps or change timer semantics.
- [ ] Test a manual fold facing a bet (correct pre-fold snapshot), a **free fold** (`miss`, `potOdds: null`), a call, a **zero-call open raise** (`potOdds: null`), and an affordable raise facing a bet, plus check absence, an AI action without metadata, timeout-forced fold/check without metadata, a synthetic fold after the round ends/after folding/all-in (no snapshot), and normal all-in/settlement/turn regressions. Include a deterministic **short-stack call/fold** where `estimateVisibleEquity`'s uncapped/full-pot odds differ from the displayed `callCap`/`contestablePot` odds and the grade agrees with the HUD (e.g. ~46% equity and ~31% displayed odds). Reuse the existing PokerGame DOM/timer test harness.

## Task 4 — Accessible compact recap, four locales, mobile CSS

**Files:** `PokerUIRenderer.ts`, `PokerUIRenderer.test.ts`, `poker.astro`, `messages/poker.ts`, `poker.css`.

- [ ] Add localized message keys for `sharp`, `ok`, `miss`, a grade-tally accessible label and an **estimated equity** label to `en`, `zh-Hant`, `zh-Hans`, `ja`. **Reuse existing `potOdds`** message key for odds copy, so all locales match the HUD. Use the existing typed `pokerTranslator`; never construct keys with runtime concatenation.
- [ ] In `renderHandRecap`, for each `event.decision` append a small stamp to the **same** item after the action icon/amount. Stamp text is ⭐ / 👍 / ⚠️; use **`role="img"` and a localized `aria-label`** on the stamp to prevent VoiceOver announcing the emoji name or ignoring a generic span label. Add localized grade/equity details to the action `title` and the stamp's accessible label. When `decision.potOdds !== null`, append existing `potOdds` translation with the rounded number. When `decision.potOdds === null`, show **equity-only for open raises** and **equity plus `checkFree` for free folds**; never display the numeric grader fallback as 100% odds. **Do not implement an iOS long-press/title tooltip**: `title` is not visible to sighted mobile users; the glyph itself is the mobile UI. Use `createElement` and `textContent` rather than HTML interpolation.
- [ ] Derive the grade tally at render from `recap.streets.flatMap(...events)` filtered to manual grade metadata: numerator `sharp`, denominator all `decision` entries. Show `⭐ 0/N` when N is positive but no sharp actions; hide/clear it when N is zero so reopening another recap never shows stale text. Rival, timeout and check events do not change the denominator.
- [ ] Add just one element to `#recap-panel > header` in `poker.astro` for the tally. **Scope `flex-wrap` and appropriate `min-width`/flex sizing to `#recap-panel > header`**: the current `.poker-drawer > header` cannot wrap and `#recap-delta` uses `margin-left: auto`. Check 320–390px (a 320px viewport gives the drawer about 294px width), keeping the close button reachable. Existing action rows already wrap. The current `.poker-recap-action[data-action='fold'] { opacity: 0.55 }` fades the **entire group**; move this opacity onto the **non-grade** `.poker-recap-avatar`, `.poker-recap-icon` and `.poker-recap-amount` children instead, so folded grade stamps are fully opaque. Do not add an `opacity: 1` child override; it cannot cancel parent opacity.
- [ ] Extend the renderer DOM tests: one human stamped call/fold/raise, ungraded check/AI/timer row, mixed tally (e.g. 2/3), all-miss tally, no-grades hidden state, stamp **`role="img"` and localized label/title**, **free fold using `checkFree` (no 100% odds)**, **open raise equity-only (no 100% odds)**, and new recap overwriting the previous header. Verify a Sit & Go hand uses the same renderer. The existing `PokerUIRenderer.test.ts` mock has **no `ownerDocument`** on `#poker-recap` (real renderer exits early at line ~617) and its `replaceChildren` currently ignores supplied nodes: minimally fix both in the local test mock so renderer assertions actually inspect rendered DOM nodes, not empty results.

## Task 5 — Verification and acceptance in the SAME PR

**Automated gates (run after implementation, not claimed by the docs-only draft):**

- [ ] `bun test src/lib/poker/decisionGrade.test.ts src/lib/poker/handRecap.test.ts src/lib/poker/PokerGame.test.ts src/lib/poker/PokerUIRenderer.test.ts`.
- [ ] `bun run lint`, `bun run test`, `bunx astro check`, `bun run build`.
- [ ] Add/run the focused Playwright Poker smoke (`bun run test:e2e -- e2e/poker-turn-flow.spec.ts`, using the project's usual test DB preparation). Since the deck is **not seeded** in this test, assert that a manual human fold action in the recap has **exactly one** `.poker-recap-grade`, not a particular grade glyph. Test timeout grading exclusion in the existing `PokerGame.test.ts` fake-timer integration harness; do **not** add a flaky 20-second browser wait.
- [ ] Review PR diff for no unrelated code, data access, AI decision, settlement or visual asset changes.

**End-to-end acceptance (applicable browser platforms only):**

- [ ] **iOS Safari** at phone width (~375px; also inspect 320px CSS viewport): deal a hand, deliberately fold/call/raise where legal, open recap, verify each manual non-check action has one **visible, fully opaque grade glyph even on a folded row**, no horizontal clipping, an intelligible VoiceOver label, and a usable close button. **Do not test a native title tooltip or long-press:** this UI intentionally presents the glyph on touch and the full text via accessibility labels. Compare visible placement against the sketch in the design spec.
- [ ] **macOS Safari/Chrome:** complete one hand with at least two human decisions, open/reopen recap and verify row stamps, sharp/graded tally, localized `title`/accessible explanation, keyboard navigation and unchanged game flow. Verify **free-fold text says check is free rather than 100% pot odds**, **open raises show equity-only**, and forced timeout fold/check stays ungraded via the integration test.
- [ ] **Windows Edge/Chrome:** repeat deal → human action → end hand → recap and inspect icon alignment/header tally at desktop width, plus narrow responsive viewport; no action buttons, chip delta or close icon are obscured.
- [ ] Visual acceptance reference: the sketch in the design spec; **no mockup is currently attached to HPA-726**. If a Linear mockup is added before implementation, compare the finished UI against it.
- [ ] Android/Linux require no manual acceptance; rely on CI as applicable.

**Definition of done:** Every *manual* human call/fold/raise in the finished recap has the correct stamp and an accessible/desktop-`title` detail that matches **HUD** pot odds when a call is due, or uses equity-only/`checkFree` when checking is free (never `Pot odds 100%`); checks, AI actions and timer-forced actions have none; tally counts only stamped decisions; existing game logic and settlement remain unchanged; code/tests/docs all arrive in this one PR.

## Review guardrails

This is feedback for a hobby game, not authoritative coaching. Do not add poker solver Monte Carlo runs, post-hoc grade recomputation, persistent profile/history schema, event bus, generic action-source model, feature flags, paid AI commentary, or a new UI overlay framework. Prefer a few focused local helpers, no architecture ceremony, and a single incremental PR that stays easy to review.
