# HPA-727 — Poker-specific daily and weekly missions: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-727/missions-poker-specific-daily-and-weekly-missions  
**Design:** [2026-11-15-poker-missions-design.md](../specs/2026-11-15-poker-missions-design.md)  
**PR contract:** Exactly **one PR** (#88) for HPA-727. Add the implementation to this draft branch following design review; do not split the ticket across PRs. No new art/SFX, schema, API, wallet, or AI changes.

**Review adjustment (2026-11-15):** Reworked the initial four-stage plan into three individually type-checkable steps, corrected the actual desktop and weekly-card layout problems, reduced repetitive verification, and kept the platform E2E goals without adding a costly permanent browser CI matrix.

## Verified code boundaries

- `src/lib/missions/types.ts` has a closed `MISSION_IDS` tuple and `MissionMetric` variants; adding IDs requires the typed message catalog to change at the same time.
- `src/lib/missions/registry.ts` has three default daily missions, three reroll-only daily missions, and one weekly. `registry.test.ts` alone hardcodes daily/weekly counts; the board integration tests already derive counts from arrays.
- `src/lib/missions/progress.ts` computes event increments and uses existing receipt-gated D1 upserts. `src/lib/wallet/repository.ts` already supplies real net profit; one completed cash poker hand produces one settlement command with `stats.rounds: 1`.
- `src/lib/poker/tableMissions.ts` already renders/claims rings and refreshes on hand settlement. The switch's current default hides unknown metric kinds; make it exhaustive for future additions.
- `src/pages/missions/index.astro` uses dynamic daily and weekly mission arrays; its weekly wrapper lacks spacing and its English heading is singular.
- `src/styles/poker.css` currently moves rings to their own centered seat row at max-width **1100px**. With 54px rings and 12px gaps, four take 252px and five take 318px; this collides with bankroll space at 1101–~1260px. The proper targeted breakpoint is **1280px**.
- `playwright.config.ts` has one Chromium project. `.github/workflows/lint.yml` runs `bunx astro check` for non-draft PRs; keep that as an explicit local step because CI skips the draft.

## File map

| File(s) | Change |
| --- | --- |
| `src/lib/missions/types.ts`, `registry.ts`, `progress.ts` | Four IDs, typed optional definition-side `gameType?: GameType`, one `bigWin` union arm + handler, four definitions |
| `src/lib/i18n/messages/missions.ts` | Four-locale titles/descriptions and canonical `poker` game mappings; English `weeklyGoal` → “Weekly Goals” |
| `src/lib/missions/registry.test.ts`, `progress.test.ts` | Counts/placement assertions and new threshold behavior |
| `src/lib/poker/tableMissions.ts`, `tableMissions.test.ts` | `bigWin` filter; exhaustiveness; four-default/five-reroll rings and in-place claim tests |
| `src/lib/missions/progress-integration.test.ts` | One Miniflare test proving the new reroll-only big-pot definition is reachable |
| `src/styles/poker.css` | Raise existing centered-ring breakpoint from 1100px to 1280px |
| `src/pages/missions/index.astro` | Add `grid gap-4` to `#weekly-section` |
| `e2e/poker-turn-flow.spec.ts` | Extend signed-in ring smoke and one stubbed five-ring geometry assertion |
| `e2e/missions.spec.ts` (optional) | Extend existing board smoke for 4 daily / 2 weekly if not already covered by ring/registry assertions |

Do **not** edit `src/lib/wallet/`, `PokerGame.ts`, `src/pages/games/poker.astro`, D1 schema/migrations, new API routes or a new UI framework. Leave existing mid-hand balance-adoption guard and tests intact.

## Task 1 — Atomic mission definitions, new metric, and localization

**Why atomic:** If `MISSION_IDS` changes without the four-locale catalog, the type checker fails. If a `bigWin` registry row is added without the union arm, it also fails. Ship IDs, definitions, copy, union, and handler **together** in the same implementation step so the tree remains type-checkable.

- [ ] Add `daily-poker-10` (default daily; play 10; 500 chips; ♠️), `daily-poker-wins-3` (daily reroll; win 3; 600; ♥️), `daily-poker-big-pot` (daily reroll; +500 net in one winning cash hand; 800; ♦️), and `weekly-poker-wins-15` (default weekly; win 15; 2,500; ♣️).
- [ ] Import `GameType` from `../game-stats/types` into `src/lib/missions/types.ts` and type optional `gameType` in `handsPlayed`, `roundsWon`, and `bigWin` as `GameType`, not `string`. Keep `MissionGameEvent` unchanged. Add `{ kind: 'bigWin'; minDelta: number; gameType?: GameType }`.
- [ ] Extend `computeIncrement`: matching `bigWin` adds **1** when `event.delta >= metric.minDelta` and the optional game type matches, otherwise **0**. Respect the existing outcome guard and receipt-gated write path. No payout/pot-size tracking.
- [ ] Add four game mappings, translated titles, and descriptions to `en`, `zh-Hant`, `zh-Hans`, and `ja`. Translate `{game}` from the canonical catalog, include fixed 500 **net** chips in the big-pot copy, and change the English heading to “Weekly Goals.”
- [ ] Update `registry.test.ts` expected daily/weekly counts to **4/2**, verify which arrays contain the four new IDs, and retain existing uniqueness tests. In `progress.test.ts`, test +499 → 0, +500 → 1, +750 → 1, −500 → 0, other-game +1000 → 0 (and unscoped metric behavior if needed). Do not duplicate target/reward data into a second giant assertion table.

**Verification:** `bunx astro check`, `bun run test:unit` on changed tests. No partial commit that breaks the type checker.

## Task 2 — Ring filtering and one real D1 reroll path

- [ ] Make `selectPokerMissions` return a typed `boolean` from its filter callback, check for an absent definition before the switch, handle `handsPlayed` / `roundsWon` / `bigWin` with the same poker-game guard, return true for `gamesTried` and false for `spinsCompleted`. Enumerate every variant **without a default case**, so future kinds fail type checking unless explicitly handled.
- [ ] Extend `tableMissions.test.ts`: ordinary cash board yields four ring IDs in daily-before-weekly order; rerolling a non-poker daily mission to a poker mission yields five; unrelated-game `bigWin` is excluded; a claimable new ring uses existing claim mechanics and accessible labeling.
- [ ] In `progress-integration.test.ts`, seed a `mission_override` from a default daily ID to `daily-poker-big-pot` and apply one +500 net poker event with the existing Miniflare D1 harness; assert `daily-poker-big-pot` progress **1**. Do not re-test generic D1 clamping, `completedAt`, UTC periods, or duplicate-receipt behavior, which already have tests.
- [ ] Reuse the existing board state/reroll code: no new database schema, server endpoint, or fixed-ID checks.

**Verification:** `bunx astro check`, relevant `bun run test:unit` and `bun run test:integration`. Preserve existing settlement/idempotency tests.

## Task 3 — Two layout fixes and targeted browser smoke

- [ ] In `src/styles/poker.css` change the existing centered ring-row breakpoint to `@media (max-width: 1280px)`. Do not wait for a phone failure: the bug is the **1101–~1260px** desktop range. Verify normal absolute placement at **1281px**.
- [ ] In `src/pages/missions/index.astro` add `class="grid gap-4"` to `#weekly-section`; the dynamic refresh uses that same container. The English heading was changed in Task 1.
- [ ] Extend the signed-in `e2e/poker-turn-flow.spec.ts` ring test: `daily-poker-10` is visible; finish a cash hand through the existing fast-AI flow (a fold suffices) and assert the ring/board advances to **1/10**, without requiring a random win.
- [ ] Add one deterministic browser geometry test: intercept `/api/missions/board` to supply five matching poker ring IDs, visit cash poker as signed-in user, set viewport width to **1101px**, and assert mission-ring bounds don't intersect bankroll, cards or actions. Repeat at **1281px**, where the ring row returns to its absolute position. Smoke-check 320px centered layout if existing test helpers make it trivial. Use DOM bounding rectangles and a visual/layout check against the current UI; **no screenshot baseline** against an ASCII sketch.
- [ ] Check the Missions weekly cards have spacing, the daily card grid remains responsive, and an eligible ring can claim in place; use the existing claim API and UI tests. Do not add a separate browser project or rigged RNG path for the big-pot reward.

**Verification:** `bunx astro check`, `bun run lint`, `bun run format:check`, `bun run build`, the focused existing Chromium Playwright tests, and relevant Bun/Miniflare tests.

## End-to-end acceptance and completion

- [ ] **iOS Safari:** signed-in mission board renders four dailies/two weeklies, cash poker shows/updates rings and supports claim on touch-width layout, with the 320px minimum remaining non-overlapping. Prefer a targeted automated WebKit/iOS smoke; record accurately whether this is iPhone emulation or a native device run.
- [ ] **macOS Safari:** the same signed-in cash-hand → mission progress → ring/board update → claim path works at desktop width, including the new 1280px ring-layout boundary. A focused automated WebKit smoke is enough; no dedicated new CI project.
- [ ] **Windows Chrome:** the same flow works with the existing Chromium Playwright test. Verify the new two-card weekly gap and 1101px/1281px ring geometry.
- [ ] **New metric:** deterministic unit cases for the inclusive net threshold and one Miniflare reroll-path test pass; existing shared settlement/claim tests stay green.
- [ ] **Visual check:** actual browser geometry at 1101px/1281px and current Art Deco layout/spacing, plus small-screen fit, rather than approving screenshots. The Linear ticket has **no UI mockup**, so none is required for visual comparison.
- [ ] `bunx astro check` passes after every step, and final unit/integration, lint, format, build and focused E2E checks are recorded on this **same PR**. CI covers Android/Linux where applicable; there are no Android/Linux acceptance targets or human sign-off criteria.

**Cost/complexity guardrails:** No new test matrix, screenshot baseline maintenance, general mission rules engine, new database/API, art/SFX, backward-compatibility layer, or repeated tests for unchanged wallet infrastructure. Keep the existing draft PR until code and tests are ready for review.
