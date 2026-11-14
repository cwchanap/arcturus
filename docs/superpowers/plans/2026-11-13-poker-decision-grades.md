# HPA-726 — Poker decision grade stamps: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-726/poker-decision-grade-stamps-in-the-hand-recap
**Design:** [2026-11-13-poker-decision-grades-design.md](../specs/2026-11-13-poker-decision-grades-design.md)
**PR contract:** **ONE PR only** for HPA-726. This branch and draft PR start with the spec/plan; add implementation and tests to the SAME PR after design review. Do not open a second implementation PR. No new art/SFX task is needed.

## File map

| Path | Minimal change |
| --- | --- |
| `src/lib/poker/decisionGrade.ts` (new) | Pure typed grade function with one threshold constants block; heuristic disclaimer. |
| `src/lib/poker/decisionGrade.test.ts` (new) | Boundary matrix for call, fold, raise, check and free-fold edge case. |
| `src/lib/poker/handRecap.ts` | Optional `RecapDecision` metadata on each human `RecapEvent`; no new recorder or tally state. |
| `src/lib/poker/handRecap.test.ts` | Normal/graded events, finish retaining metadata, existing last-hand/reset behavior. |
| `src/lib/poker/PokerGame.ts` | Shared visible-context builder, pre-mutation human snapshots, timer-forced action exclusion. |
| `src/lib/poker/PokerGame.test.ts` | Human action integration, no AI grades, timer click path, preserved AI redaction/rules. |
| `src/lib/poker/PokerUIRenderer.ts` | Stamp eligible actions, compute `sharp / graded` tally, translated accessible details. |
| `src/lib/poker/PokerUIRenderer.test.ts` | Stamp and tally DOM behavior with local tests/mock document. |
| `src/pages/games/poker.astro` | One compact `#recap-grade-tally` element in the existing recap header. |
| `src/lib/i18n/messages/poker.ts` | Four-locale grade and detail strings, existing translator only. |
| `src/styles/poker.css` | Scoped compact stamp and phone-width header layout. |
| `e2e/poker-turn-flow.spec.ts` | One focused real browser manual fold → recap stamp smoke; timer exclusion where test control permits. |

No edits to `src/lib/mp-poker`, AI scoring/rules, multiplayer, D1, wallet, asset files, sound, or mission state. Keep the existing recorder/renderer split.

## Task 1 — Pure grade policy with explicit edges

**Files:** `decisionGrade.ts`, `decisionGrade.test.ts`.

- [ ] Export `DecisionGrade` and `gradeDecision({ action, equity, potOdds, callAmount })` using `RecapAction` from `handRecap`. Return `null` on `check`; in `fold` test `callAmount === 0` **first** and return `'miss'`; use the threshold table in the spec for the rest.
- [ ] Put `CALL_SHARP_MARGIN = 0.05`, `CALL_OK_MARGIN = 0.05`, `FOLD_MISS_MARGIN = 0.10`, `RAISE_SHARP = 0.55` and `RAISE_OK = 0.35` together. No need to expose settings. Document once: `estimateVisibleEquity` is an approximation, not solved equity.
- [ ] Explicitly make folding at/between odds and odds+10 points `ok`, including the ticket's previously unspecified 5–10-point gap; only `> 10` above odds is `miss`. Unit-test strict versus inclusive boundaries with safe example fractions.
- [ ] Matrix-test a sharp/ok/miss call; sharp/ok/miss fold; free-check fold even though the estimator reports `potOdds = 1.0`; three raise tiers; a check. Tests should also show that the amount of chips called/raised does not change the selected policy beyond `callAmount === 0`.

## Task 2 — Recap metadata and one shared visible context

**Files:** `handRecap.ts`, `handRecap.test.ts`, `PokerGame.ts`, `PokerGame.test.ts`.

- [ ] Add optional `RecapDecision { grade, equity, potOdds }` on `RecapEvent`. Keep the recorder as the only storage owner; copy the optional metadata into the street event and let `finish` preserve it. Do not precompute grades at recap render time.
- [ ] Extract `PokerGame.buildVisibleGameContext(player)` from existing `processAITurn` inline context (currently around its `sanitizedPlayers` local). Preserve the AI's exact context fields and player position. Keep every opponent's `hand` empty in the context, including when the subject is the human; never mutate the real `this.players`.
- [ ] Add a focused PokerGame test for shared context redaction and preserved AI behavior. Do not alter `estimateVisibleEquity` or `getPlayerPosition`.

## Task 3 — Grade only deliberate human actions, before mutation

**Files:** `PokerGame.ts`, `PokerGame.test.ts`.

- [ ] Introduce a private helper such as `snapshotHumanDecision(action): RecapDecision | undefined`. It calls `estimateVisibleEquity(this.buildVisibleGameContext(this.players[0]))` once while state still reflects the decision, then runs `gradeDecision`. Return no metadata for `check` or a forced timer action. Avoid caching/persisting equity.
- [ ] Extend existing `noteAction(playerId, action, amount = 0, decision?)` to pass optional metadata to `this.recap.act`. Rival `showDecision` continues calling `noteAction` without metadata, so AI actions stay ungraded.
- [ ] In valid `btn-fold`, `btn-call` and `btn-raise` handlers, obtain the snapshot **before** `foldPlayer` / `placeBet` and before `this.pot = calculatePot`; pass it through existing `noteAction` after the action. Keep amount, all-in, sound and settlement paths exactly as before. Do not compute for invalid/disabled button attempts.
- [ ] `actOnTimeout` currently clicks those buttons, so wrap only its programmatic click with a synchronous `timeoutAction` flag and `try/finally` reset. The click handler checks the flag before estimating; the timer path still records the actual check/fold but without grade metadata. Do not infer origin from timestamps or change timer semantics.
- [ ] Test a manual fold facing a bet (correct pre-fold snapshot), a free fold (`miss`), a call and an affordable raise, plus check absence, an AI action without metadata, timeout-forced fold/check without metadata, and normal all-in/settlement/turn regressions. Reuse the existing PokerGame DOM/timer test harness.

## Task 4 — Accessible compact recap, four locales, mobile CSS

**Files:** `PokerUIRenderer.ts`, `PokerUIRenderer.test.ts`, `poker.astro`, `messages/poker.ts`, `poker.css`.

- [ ] Add localized message keys for `sharp`, `ok`, `miss`, a grade-tally accessible label and estimated equity/odds detail to `en`, `zh-Hant`, `zh-Hans`, `ja`. Use the existing typed `pokerTranslator`; never construct keys with runtime concatenation.
- [ ] In `renderHandRecap`, for each `event.decision` append a small stamp to the **same** item after the action icon/amount. Stamp text is ⭐ / 👍 / ⚠️; a localized accessible label gives its meaning. Add localized grade/rounded percentages to the existing action `title`. Use `createElement` and `textContent` rather than HTML interpolation.
- [ ] Derive the grade tally at render from `recap.streets.flatMap(...events)` filtered to manual grade metadata: numerator `sharp`, denominator all `decision` entries. Show `⭐ 0/N` when N is positive but no sharp actions; hide/clear it when N is zero so reopening another recap never shows stale text. Rival, timeout and check events do not change the denominator.
- [ ] Add just one element to `#recap-panel > header` in `poker.astro` for the tally. Modify recap-specific CSS to accommodate it alongside the hand number, chip delta and close button at 320–390px. Existing flex-wrapping action rows can contain the extra icon. Do not let the translucent folded-action style make its grade unreadable.
- [ ] Extend the renderer DOM tests: one human stamped call/fold/raise, ungraded check/AI/timer row, mixed tally (e.g. 2/3), all-miss tally, no-grades hidden state, accessible label/title and new recap overwriting the previous header. Verify a Sit & Go hand uses the same renderer.

## Task 5 — Verification and acceptance in the SAME PR

**Automated gates (run after implementation, not claimed by the docs-only draft):**

- [ ] `bun test src/lib/poker/decisionGrade.test.ts src/lib/poker/handRecap.test.ts src/lib/poker/PokerGame.test.ts src/lib/poker/PokerUIRenderer.test.ts`.
- [ ] `bun run lint`, `bun run test`, `bunx astro check`, `bun run build`.
- [ ] Add/run the focused Playwright Poker smoke (`bun run test:e2e -- e2e/poker-turn-flow.spec.ts`, using the project's usual seeded/test DB preparation). The timer case can be primarily integration-tested against the existing fake-timer harness rather than adding flaky 20-second waits.
- [ ] Review PR diff for no unrelated code, data access, AI decision, settlement or visual asset changes.

**End-to-end acceptance (applicable browser platforms only):**

- [ ] **iOS Safari** at phone width (~375px; also inspect 320px CSS viewport): deal a hand, deliberately fold/call/raise where legal, open recap, verify each manual non-check action has one grade and no horizontal clipping; check grade tooltip/accessibility fallback and close button. Compare visible placement against the layout sketch in the design spec.
- [ ] **macOS Safari/Chrome:** complete one hand with at least two human decisions, open/reopen recap and verify row stamps, sharp/graded tally, localised explanation, keyboard navigation and unchanged game flow. Verify forced timeout fold/check shows an ungraded row.
- [ ] **Windows Edge/Chrome:** repeat deal → human action → end hand → recap and inspect icon alignment/header tally at desktop width, plus narrow responsive viewport; no action buttons, chip delta or close icon are obscured.
- [ ] Visual acceptance reference: the sketch in the design spec; **no mockup is currently attached to HPA-726**. If a Linear mockup is added before implementation, compare the finished UI against it.
- [ ] Android/Linux require no manual acceptance; rely on CI as applicable.

**Definition of done:** Every *manual* human call/fold/raise in the finished recap has the correct stamp and optional estimated odds detail; checks, AI actions and timer-forced actions have none; tally counts only stamped decisions; existing game logic and settlement remain unchanged; code/tests/docs all arrive in this one PR.

## Review guardrails

This is feedback for a hobby game, not authoritative coaching. Do not add poker solver Monte Carlo runs, post-hoc grade recomputation, persistent profile/history schema, event bus, generic action-source model, feature flags, paid AI commentary, or a new UI overlay framework. Prefer a few focused local helpers, no architecture ceremony, and a single incremental PR that stays easy to review.
