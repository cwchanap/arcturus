# HPA-726 — Poker decision grade stamps: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-726/poker-decision-grade-stamps-in-the-hand-recap
**Design:** [2026-11-13-poker-decision-grades-design.md](../specs/2026-11-13-poker-decision-grades-design.md)
**PR contract:** **ONE PR only** for HPA-726. This branch and draft PR start with the spec/plan; add implementation and tests to the SAME PR after design review. Do not open a second implementation PR. No new art/SFX task is needed.

## File map

| Path | Minimal change |
| --- | --- |
| `src/lib/poker/decisionGrade.ts` (new) | Pure typed grade function with one threshold constants block; heuristic disclaimer. |
| `src/lib/poker/decisionGrade.test.ts` (new) | Boundary matrix for call, fold, raise and free-fold; check excluded by input type. |
| `src/lib/poker/handRecap.ts` | Optional `RecapDecision` metadata on each human `RecapEvent`; no new recorder or tally state. |
| `src/lib/poker/handRecap.test.ts` | Normal/graded events, finish retaining metadata, existing last-hand/reset behavior. |
| `src/lib/poker/PokerGame.ts` | Shared visible-context builder, pre-mutation equity plus HUD contestable-pot odds snapshots, timer-forced action exclusion. |
| `src/lib/poker/PokerGame.test.ts` | Human action integration, no AI grades, timer click path, preserved AI redaction/rules. |
| `src/lib/poker/PokerUIRenderer.ts` | Stamp eligible actions, compute `sharp / graded` tally, translated accessible details. |
| `src/lib/poker/PokerUIRenderer.test.ts` | Stamp and tally DOM behavior with local tests/mock document. |
| `src/pages/games/poker.astro` | One compact `#recap-grade-tally` element in the existing recap header. |
| `src/lib/i18n/messages/poker.ts` | Four-locale grade names/tally/equity copy; reuse existing `potOdds` key. |
| `src/styles/poker.css` | Scoped compact stamp and phone-width header layout. |
| `e2e/poker-turn-flow.spec.ts` | One non-seeded browser smoke asserting a manually chosen human fold has one stamp (any grade); timer exclusion stays in the existing fake-timer unit integration harness. |

No edits to `src/lib/mp-poker`, AI scoring/rules, multiplayer, D1, wallet, asset files, sound, or mission state. Keep the existing recorder/renderer split.

## Task 1 — Pure grade policy with explicit edges

**Files:** `decisionGrade.ts`, `decisionGrade.test.ts`.

- [ ] Export `DecisionGrade` and pure `gradeDecision({ action, equity, potOdds, callAmount }): DecisionGrade`. Type `action` as `Exclude<RecapAction, 'check'>` from `handRecap`, so checks cannot be graded at compile time (they do **not** enter the function; no runtime `null` path). In `fold`, test `callAmount === 0` **first** and return `'miss'`; use the threshold table in the spec for the rest.
- [ ] Put `CALL_SHARP_MARGIN = 0.05`, `CALL_OK_MARGIN = 0.05`, `FOLD_MISS_MARGIN = 0.10`, `RAISE_SHARP = 0.55` and `RAISE_OK = 0.35` together. No need to expose settings. Document once: `estimateVisibleEquity` is an approximation, not solved equity.
- [ ] Explicitly make folding at/between odds and odds+10 points `ok`, including the ticket's previously unspecified 5–10-point gap; only `> 10` above odds is `miss`. Unit-test strict versus inclusive boundaries with safe example fractions.
- [ ] Matrix-test a sharp/ok/miss call; sharp/ok/miss fold; free-check fold despite `potOdds = 1.0`; and three raise tiers. Tests and typing must show a `check` is handled by its caller, not this grader. Chip-call sizing does not change the policy beyond `callAmount === 0`; the supplied odds are already calculated by the HUD-equivalent caller.

## Task 2 — Recap metadata and one shared visible context

**Files:** `handRecap.ts`, `handRecap.test.ts`, `PokerGame.ts`, `PokerGame.test.ts`.

- [ ] Add optional `RecapDecision { grade, equity, potOdds }` on `RecapEvent`. Keep the recorder as the only storage owner; copy the optional metadata into the street event and let `finish` preserve it. Do not precompute grades at recap render time.
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
  const potOdds = calculatePotOdds(callCap, contestablePot(this.players, human, callCap));
  const grade = gradeDecision({ action, equity, potOdds, callAmount: callCap });
  ```

  This is the **same cap and contestable-pot formula as the live HUD**, including short-stack/all-in calls; `callCap === 0` preserves the free-fold guard. Return no metadata when `timeoutAction` is true; do not invoke for checks. Do not cache/persist estimated equity or alter AI estimation.
- [ ] Extend existing `noteAction(playerId, action, amount = 0, decision?)` to pass optional metadata to `this.recap.act`. Rival `showDecision` continues calling `noteAction` without metadata, so AI actions stay ungraded.
- [ ] In valid `btn-fold`, `btn-call` and `btn-raise` handlers, obtain the snapshot **before** `foldPlayer` / `placeBet` and before `this.pot = calculatePot`; pass it through existing `noteAction` after the action. Keep amount, all-in, sound and settlement paths exactly as before. Do not compute for invalid/disabled button attempts.
- [ ] `actOnTimeout` currently clicks those buttons, so wrap only its programmatic click with a synchronous `timeoutAction` flag and `try/finally` reset. The click handler checks the flag before estimating; the timer path still records the actual check/fold but without grade metadata. Do not infer origin from timestamps or change timer semantics.
- [ ] Test a manual fold facing a bet (correct pre-fold snapshot), a free fold (`miss`), a call and an affordable raise, plus check absence, an AI action without metadata, timeout-forced fold/check without metadata, and normal all-in/settlement/turn regressions. Include a deterministic **short-stack call/fold** where `estimateVisibleEquity`'s uncapped/full-pot odds differ from the displayed `callCap`/`contestablePot` odds and the grade agrees with the HUD (e.g. ~46% equity and ~31% displayed odds). Reuse the existing PokerGame DOM/timer test harness.

## Task 4 — Accessible compact recap, four locales, mobile CSS

**Files:** `PokerUIRenderer.ts`, `PokerUIRenderer.test.ts`, `poker.astro`, `messages/poker.ts`, `poker.css`.

- [ ] Add localized message keys for `sharp`, `ok`, `miss`, a grade-tally accessible label and an **estimated equity** label to `en`, `zh-Hant`, `zh-Hans`, `ja`. **Reuse existing `potOdds`** message key for odds copy, so all locales match the HUD. Use the existing typed `pokerTranslator`; never construct keys with runtime concatenation.
- [ ] In `renderHandRecap`, for each `event.decision` append a small stamp to the **same** item after the action icon/amount. Stamp text is ⭐ / 👍 / ⚠️; a localized accessible label gives its meaning. Add localized grade and rounded percentages to the existing action `title`, combining a new equity label with the existing `potOdds` translation for odds. The stamp's `aria-label` (or row label) carries the grade and decision detail for assistive tech. **Do not implement an iOS long-press/title tooltip**: `title` is not visible to sighted mobile users; the glyph itself is the mobile UI. Use `createElement` and `textContent` rather than HTML interpolation.
- [ ] Derive the grade tally at render from `recap.streets.flatMap(...events)` filtered to manual grade metadata: numerator `sharp`, denominator all `decision` entries. Show `⭐ 0/N` when N is positive but no sharp actions; hide/clear it when N is zero so reopening another recap never shows stale text. Rival, timeout and check events do not change the denominator.
- [ ] Add just one element to `#recap-panel > header` in `poker.astro` for the tally. Modify recap-specific CSS to accommodate it alongside the hand number, chip delta and close button at 320–390px. Existing flex-wrapping action rows can contain the extra icon. Do not let the translucent folded-action style make its grade unreadable.
- [ ] Extend the renderer DOM tests: one human stamped call/fold/raise, ungraded check/AI/timer row, mixed tally (e.g. 2/3), all-miss tally, no-grades hidden state, accessible label/title and new recap overwriting the previous header. Verify a Sit & Go hand uses the same renderer.

## Task 5 — Verification and acceptance in the SAME PR

**Automated gates (run after implementation, not claimed by the docs-only draft):**

- [ ] `bun test src/lib/poker/decisionGrade.test.ts src/lib/poker/handRecap.test.ts src/lib/poker/PokerGame.test.ts src/lib/poker/PokerUIRenderer.test.ts`.
- [ ] `bun run lint`, `bun run test`, `bunx astro check`, `bun run build`.
- [ ] Add/run the focused Playwright Poker smoke (`bun run test:e2e -- e2e/poker-turn-flow.spec.ts`, using the project's usual test DB preparation). Since the deck is **not seeded** in this test, assert that a manual human fold action in the recap has **exactly one** `.poker-recap-grade`, not a particular grade glyph. Test timeout grading exclusion in the existing `PokerGame.test.ts` fake-timer integration harness; do **not** add a flaky 20-second browser wait.
- [ ] Review PR diff for no unrelated code, data access, AI decision, settlement or visual asset changes.

**End-to-end acceptance (applicable browser platforms only):**

- [ ] **iOS Safari** at phone width (~375px; also inspect 320px CSS viewport): deal a hand, deliberately fold/call/raise where legal, open recap, verify each manual non-check action has one **visible grade glyph**, no horizontal clipping, and a usable close button. **Do not test a native title tooltip or long-press:** this UI intentionally presents the glyph on touch and the full text via accessibility labels. Compare visible placement against the sketch in the design spec.
- [ ] **macOS Safari/Chrome:** complete one hand with at least two human decisions, open/reopen recap and verify row stamps, sharp/graded tally, localized `title`/accessible explanation, keyboard navigation and unchanged game flow. Verify forced timeout fold/check shows an ungraded row using the integration test.
- [ ] **Windows Edge/Chrome:** repeat deal → human action → end hand → recap and inspect icon alignment/header tally at desktop width, plus narrow responsive viewport; no action buttons, chip delta or close icon are obscured.
- [ ] Visual acceptance reference: the sketch in the design spec; **no mockup is currently attached to HPA-726**. If a Linear mockup is added before implementation, compare the finished UI against it.
- [ ] Android/Linux require no manual acceptance; rely on CI as applicable.

**Definition of done:** Every *manual* human call/fold/raise in the finished recap has the correct stamp and an accessible/desktop-`title` estimated odds detail matching the **HUD's** pot odds; checks, AI actions and timer-forced actions have none; tally counts only stamped decisions; existing game logic and settlement remain unchanged; code/tests/docs all arrive in this one PR.

## Review guardrails

This is feedback for a hobby game, not authoritative coaching. Do not add poker solver Monte Carlo runs, post-hoc grade recomputation, persistent profile/history schema, event bus, generic action-source model, feature flags, paid AI commentary, or a new UI overlay framework. Prefer a few focused local helpers, no architecture ceremony, and a single incremental PR that stays easy to review.
