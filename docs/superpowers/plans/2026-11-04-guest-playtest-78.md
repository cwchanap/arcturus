# Issue #78 — Guest playtest fixes: implementation plan

Status: steps 1–7 implemented in PR #79; final review fixes and delivery verification in progress\
Design: [2026-11-04 guest playtest design](../specs/2026-11-04-guest-playtest-78-design.md)  
Issue: [#78](https://github.com/cwchanap/arcturus/issues/78)  
PR policy: **one PR only** for issue #78. This docs-only draft becomes the implementation PR; no per-finding PR split.

## Implementation approach

Use small edits in existing modules. Suggested order puts chip-affecting behavior and visually broken cards first, then presentation/content improvements. Each step adds or updates its own focused tests. Keep the tests that currently assert incorrect intended behavior from masking the bug. **Implement as one focused commit per step inside this one PR** to make review and revert straightforward; no separate PRs.

### 1. Sic Bo reset — high priority

Files:
- `src/lib/sic-bo/game.ts`
- `src/lib/sic-bo/game.test.ts`
- `src/lib/sic-bo/client.init.test.ts` (where reset wiring is covered)
- `e2e/sic-bo.spec.ts`

Work:
1. Change `resetRound()` to clear `this.bets` alongside `lastResult` and transition back to `betting`. Leave `roll()` and settlement pathways untouched.
2. Rewrite the “retained slip recovery” and “reset keeps bets” tests to require an empty slip. Assert that `getRollError()` reports `no-bets` and that the total stake is zero even if the previous round was profitable or unprofitable.
3. Update the existing E2E that explicitly expects the retained Big bet. After clicking New Round, assert empty data-bet-amount, `aria-pressed="false"`, zero stake, and disabled Roll; placing a new bet enables Roll.
4. Validate the authenticated Retry/Reset flow still prevents duplicate settlement, adopts the authoritative balance, and starts with a clean slip.

Done when: there is no automatic carryover bet and no wallet accounting regression.


### 2. Component-scoped CardSlot legibility — high priority

Files:
- `src/components/CardSlot.astro` (**not** `src/styles/global.css`)
- `e2e/video-poker.spec.ts`
- `e2e/pai-gow-poker.spec.ts` and/or `e2e/three-card-showdown.spec.ts`
- Existing game DOM tests only if they add useful semantic coverage

Work:
1. Add a `<style>` block **inside `CardSlot.astro`**, scoped by Astro to its own markup: dark face text on white; red suits `#a3161c`; absolute top and bottom flex-column corners with a 180° rotation on the lower one; centered suit glyph. Copy the minimal visual design contract from `poker.css`, not its global/game-specific selectors.
2. Do **not** touch `global.css`, `poker.css`, or `blackjack.css`: Poker and Blackjack reuse class names in different card components and mix CSS `rotate`/`translate` with `transform`. Their layouts must be untouched.
3. Verify **all three affected games** — Video Poker, Pai Gow, and Three-Card Showdown. Add E2E assertions for visible, non-empty ranks and suits and contrasting computed face/text colors in Video Poker plus at least one other game; smoke-test the third.
4. Verify overlay alignment/selection, deterministic payouts, both suit colors, and a narrow viewport. Prefer these targeted assertions to a new visual snapshot dependency.

Done when: all three games display legible cards without affecting Poker/Blackjack markup or styling.


### 3. Roulette result reveal consistency — high priority

Files:
- `src/lib/roulette/rouletteClient.ts`
- `src/lib/roulette/RouletteUIRenderer.ts` (only if the current renderer needs a tiny presentation helper)
- `e2e/roulette.spec.ts`
- `src/lib/roulette/rouletteClient.test.ts` / `rouletteClient.integration.test.ts` as appropriate

Work:
1. Add one local `revealSpin(spinResult)` callback that performs `ui.update(game.getState())` and `ui.showResult(spinResult)` **together after `SPIN_ANIMATION_MS`**, preserving the wheel animation before showing its outcome.
2. Both account and guest branches apply/record the existing settlement and `persistSession()` immediately, then animate and schedule that one reveal. Eliminate their duplicated reveal timers.
3. While waiting for reveal, **keep the visible controls locked and show spinning**. Authenticated `beginSpin()` already updates the view before the fetch. For guests, snapshot the pre-spin game state for presentation and call `ui.update({...preSpinState, phase: 'spinning'})` before `spinGuest()` so no bet button or Spin remains active even though the domain settles synchronously. Do not alter `spinGuest()` accounting.
4. Keep New Round hidden until reveal; remove the obsolete pending-result timer cancellation from the New Round click handler. Keep `clearResult`, persisted settled-session restoration, and duplicate/rejected/uncertain-spin handling unchanged.
5. Assert the final balance, winning number, NET and bet breakdown appear in one reveal; cover positive, negative, zero net, New Round clearing, and reloaded settled sessions. Check that no guest bet control is actionable during the wheel animation and that no intermediate settled balance/blank NET mismatch is visible.

Done when: the wheel shows suspense and settled balance/result/UI controls appear together, without any payout or persistence change.

### 4. Responsible-play links — medium priority

Files:
- `src/layouts/AppLayout.astro`
- `src/pages/responsible-play.astro` (new)
- `src/lib/i18n/messages/*` for the new page's four-language text
- Relevant layout or page test, or short Playwright navigation check

Work:
1. Create a short, public information page covering virtual chips/no cash value, breaks/limits, and an adult-audience note. Add anchors `responsible-gaming` and `age-guidance`.
2. Point the footer's “Responsible Gaming” and “18+ Only” links to the corresponding page anchors.
3. Localize the content in en, zh-Hant, zh-Hans and ja. Do not assert an implemented age gate or claim legal compliance.
4. Verify both links actually navigate to the sections from the homepage, and the page requires no login.

Done when: neither footer link points at `#` and the policy copy is truthful.

### 5. Remove fake lobby presence — medium priority

Files:
- `src/pages/index.astro`
- `src/components/GameCard.astro`
- `src/lib/i18n/messages/home.ts`
- Any focused lobby/card tests

Work:
1. Remove all numeric `players` literals, `HomeGame.players`, `GameCard.players`, and player-count UI.
2. Replace 5,680+ online with the true `games.length` and localized “Games available” hero label, or remove the hero stat entirely if the existing layout looks better. Prefer the factual game count without a new service.
3. Add/update four-language copy and remove obsolete player-count strings if unused.
4. Verify game URLs, featured tags, minimum-wager information, and the number of cards remain intact.

Done when: the lobby makes no unsupported presence claims.

### 6. Pai Gow Joker policy clarification — low priority

Files:
- `src/lib/i18n/messages/pai-gow-poker.ts`
- `src/lib/pai-gow-poker/rules.test.ts`

Work:
1. State in “How to Play” that five-card Joker may complete a straight/flush/straight flush/royal flush, otherwise Ace; two-card Joker is Ace; five Aces is the special high hand.
2. Add the exact reported `9♣ K♣ 7♣ 5♥ + Joker` test; expect high card, **not** flush. Keep the existing four-clubs-plus-Joker flush test unchanged.
3. Explicitly avoid edits to `rules.ts` and the payout evaluator unless these tests expose a real defect.

Done when: rules are explained without changing correct game behavior.


### 7. Daily Challenge completed-hand display — practice and ranked — low/medium priority

Files:
- `src/lib/blackjack-run/daily.ts`
- `src/lib/blackjack-run/protocol.ts`
- `src/server/blackjack-run/service.ts`
- `src/lib/blackjack-run/daily-ui.ts`
- `src/lib/blackjack-run/daily.test.ts`
- `src/lib/blackjack-run/daily-ui.test.ts`
- `src/server/blackjack-run/http.test.ts`, `src/lib/blackjack-run/protocol.test.ts`, and any other strict daily-state fixtures
- `e2e/daily-challenge.spec.ts` as appropriate

Work:
1. In pure `snapshotReplay` (`daily.ts`), derive `lastCompletedRoundPublic` from `rounds.at(-1)` via `projectBlackjackRoundReplay` (terminal projection reveals final dealer cards and `outcome`). Omit internal `nextSequence` and produce `null` if no round completed; add unit tests for both natural-at-start and stand-settled rounds.
2. Add **required nullable** `lastRound` to the daily branch of `blackjackRunPublicStateSchema` (`protocol.ts`). In `service.ts`'s `renderDailyState`, expose the projection as `lastRound` while honoring the current expired-run policy. Because the daily schema is `.strict()` and the field is required, explicitly update `dailyState()` (`src/lib/blackjack-run/daily-ui.test.ts`), `dailyActiveState()` (`src/server/blackjack-run/http.test.ts`), and `dailyPublicSample` (`src/lib/blackjack-run/protocol.test.ts`) to include `lastRound: null` by default; search for other daily-state fixtures and update them too. Verify Zod parse tests accept null and reject missing or malformed `lastRound`. No migrations or new HTTP endpoints.
3. Update `daily-ui.ts` to display `activeRound ?? lastRound` in **both practice and ranked** via the existing `renderActiveRound`. Keep enabled actions, Start Round, and Forfeit based **only on real `activeRound`**, never on last-completed presentation data.
4. Render a visible completed outcome and net value using existing `blackjackTranslator` `resultWin`/`resultLoss`/`resultPush` and `formatBlackjackNet` as already done in `ranked-ui.ts`. **Do not unconditionally overwrite `statusEl` when `lastRound` exists.** Practice `status === 'active'` with no active hand may show the last outcome there; practice `status === 'completed'`/`'forfeited'` must keep the existing `practiceComplete`/`practiceForfeited` status text (or render outcome separately). Keep ranked terminal receipt/terminal status visible, including when a prior settled hand is displayed. No duplicate Daily translations or changes to forfeit/receipt semantics.
5. Add deterministic renderer/controller coverage for natural and stand-settled rounds in both modes: dealer and player cards remain visible, result/net matches replay, next Start Round stays available if the attempt remains active, no extra API write occurs, and bankroll/score remain unchanged by presentation work. Cover moving to next round and restarting practice. **Regression:** the existing `daily-ui.test.ts` terminal-practice test must still show exact `Practice forfeited.` (and completion copy when completed), the ranked terminal receipt stays visible, and strict daily protocol/HTTP fixtures pass with `lastRound: null`.
6. Do not add debouncing, automatic forfeits or a second game state machine based on the unreproduced double-click speculation. If a separate reproducible rapid-click test demonstrates a bug, resolve it minimally in this PR.

Done when: completed practice and ranked hands remain readable until the next round (or restart), with no changes to gameplay or one-attempt rules.

## Verification and delivery

Run the scoped checks during implementation:

```bash
bun test src/lib/sic-bo/game.test.ts src/lib/pai-gow-poker/rules.test.ts src/lib/blackjack-run/daily.test.ts src/lib/blackjack-run/daily-ui.test.ts src/lib/blackjack-run/protocol.test.ts src/server/blackjack-run/http.test.ts
bun run test:unit
bun run lint
bun run format:check
bun run build
bunx playwright test e2e/sic-bo.spec.ts e2e/video-poker.spec.ts e2e/roulette.spec.ts e2e/pai-gow-poker.spec.ts e2e/daily-challenge.spec.ts
```

Playwright's authenticated setup needs the repository's documented local/CI test bootstrap configuration. Do not claim passing E2E until actually executed. Use guest journeys for visual verification and existing authenticated wallet tests for settlement recovery.

Final review checklist:
- [ ] All five actionable findings addressed, with CardSlot legibility checked in all three affected games.
- [ ] Pai Gow policy clarified without evaluator changes.
- [ ] Completed Daily practice **and ranked** hands (including naturals and stand-settled hands) remain visible without clobbering terminal/forfeit status text or ranked receipts.
- [ ] All strict daily schema and test fixtures include `lastRound` (null by default); protocol parsing and HTTP mocks pass.
- [ ] Tests previously expecting Sic Bo retained bets are corrected, not skipped.
- [ ] All four locales covered for changed copy.
- [ ] No extra backend/persistence service, generated artwork, or migration.
- [ ] One coherent PR contains these docs and the eventual implementation; issue #78 linked in PR description.

## Rollout

No database schema or data migration; the existing Daily run HTTP response gains the nullable `lastRound` field. Deploy with the normal Cloudflare application release after test checks pass. No backwards-compatibility machinery is needed for the hobby project. If issue #78 receives new playtest evidence, update the design and tests **in this same PR** before merge.
