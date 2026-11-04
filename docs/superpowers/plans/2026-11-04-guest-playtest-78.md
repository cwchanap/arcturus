# Issue #78 — Guest playtest fixes: implementation plan

Status: proposed / not implemented  
Design: [2026-11-04 guest playtest design](../specs/2026-11-04-guest-playtest-78-design.md)  
Issue: [#78](https://github.com/cwchanap/arcturus/issues/78)  
PR policy: **one PR only** for issue #78. This docs-only draft becomes the implementation PR; no per-finding PR split.

## Implementation approach

Use small edits in existing modules. Suggested order puts chip-affecting behavior and visually broken cards first, then presentation/content improvements. Each step adds or updates its own focused tests. Keep the tests that currently assert incorrect intended behavior from masking the bug.

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

### 2. Shared card face legibility — high priority

Files:
- `src/styles/global.css` and/or `src/components/CardSlot.astro` (choose the smallest shared default; avoid duplicating card markup)
- `e2e/video-poker.spec.ts`
- `src/lib/video-poker/client.init.test.ts` (only if useful for DOM assertions)

Work:
1. Add baseline card-slot text coloring, red/black suit classes, and positional typography rules to make pre-rendered `[data-rank]` and suit glyphs readable on the existing white `.playing-card` background.
2. Verify Poker and Blackjack game-scoped styles still override the baseline. Check Pai Gow and Three-Card Showdown, which reuse `CardSlot`.
3. After a deterministic Deal in Video Poker, assert all five slots display a face-up card, ranks and suits are non-empty and visibly rendered, and computed face/text colors are distinguishable (not white-on-white). Use a targeted computed-style check rather than snapshots or an image-diff infrastructure.
4. Confirm hold overlay alignment/selection and the existing deterministic Win/Loss E2E journeys still pass. Check one small-screen viewport manually or with a focused Playwright viewport.

Done when: a sighted player can distinguish ranks/suits without the aria-label.

### 3. Roulette NET/result timing — high priority

Files:
- `src/lib/roulette/rouletteClient.ts`
- `src/lib/roulette/RouletteUIRenderer.ts` (only if needed)
- `e2e/roulette.spec.ts`
- `src/lib/roulette/rouletteClient.test.ts` / `rouletteClient.integration.test.ts` as appropriate

Work:
1. In both `showSpinResult` and the guest `spinGuest` branch, apply the existing settlement, animate the wheel, and call `ui.showResult(spinResult)` synchronously on successful settlement.
2. Remove `pendingResultTimer`, delayed `showResult` callbacks, and the now-unnecessary cancellation in the New Round handler. Keep result clearing, persisted settled-session restoration, error/retry paths, and balance synchronization.
3. Cover positive NET, negative NET, zero/push formatting, New Round clearing, restored last result, and no stale last-round result after rapid transitions.
4. Make a deterministic E2E check that NET is populated at settlement instead of relying on the usual Playwright 5-second retry to pass after the 4-second animation. Keep existing wallet/result expectations.

Done when: a completed spin never displays a settled balance alongside blank NET.

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

### 7. Daily Challenge instant-settlement display — low/medium priority

Files:
- `src/lib/blackjack-run/daily-ui.ts`
- `src/lib/blackjack-run/daily-ui.test.ts`
- `e2e/daily-challenge.spec.ts` (targeted if determinism is practical)
- `src/lib/i18n/messages/daily-challenge.ts` (only for new result copy)

Work:
1. In practice `renderCurrentView`, when `activeRoundPublic` is null and `replay.rounds` has a completed round, project the last round's existing replay data using the current Blackjack presentation helpers. Render the hand cards and a compact Win/Loss/Push with net result.
2. Keep this completed-hand view until the player deliberately starts another round or restarts practice. Do not change ranked rendering, run commands, deck seeds, scoring, or persisted state.
3. Add a deterministic practice-controller/renderer test with a start-round natural that settles without player action. Assert visible cards, visible result, accurate bankroll, exactly one round consumed, and no network POST.
4. Do not add debouncing, automatic forfeits, or a new state machine based only on the unreproduced double-click speculation. If a separate deterministic rapid-click test proves a double-round bug, add a minimal one-shot guard here within the same PR.

Done when: an auto-resolving practice round is visible and understandable rather than appearing as an unexplained chip loss.

## Verification and delivery

Run the scoped checks during implementation:

```bash
bun test src/lib/sic-bo/game.test.ts src/lib/pai-gow-poker/rules.test.ts src/lib/blackjack-run/daily-ui.test.ts
bun run test:unit
bun run lint
bun run format:check
bun run build
bunx playwright test e2e/sic-bo.spec.ts e2e/video-poker.spec.ts e2e/roulette.spec.ts e2e/pai-gow-poker.spec.ts e2e/daily-challenge.spec.ts
```

Playwright's authenticated setup needs the repository's documented local/CI test bootstrap configuration. Do not claim passing E2E until actually executed. Use guest journeys for visual verification and existing authenticated wallet tests for settlement recovery.

Final review checklist:
- [ ] All five actionable findings addressed.
- [ ] Pai Gow policy clarified without evaluator changes.
- [ ] Instantly settled Daily practice hands remain visible.
- [ ] Tests previously expecting Sic Bo retained bets are corrected, not skipped.
- [ ] All four locales covered for changed copy.
- [ ] No extra backend/persistence service, generated artwork, or migration.
- [ ] One coherent PR contains these docs and the eventual implementation; issue #78 linked in PR description.

## Rollout

No schema or data migration. Deploy with the normal Cloudflare application release after test checks pass. No backwards-compatibility machinery is needed for the hobby project. If issue #78 receives new playtest evidence, update the design and tests **in this same PR** before merge.
