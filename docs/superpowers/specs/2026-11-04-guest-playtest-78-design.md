# Issue #78 — Guest playtest follow-up: design

Status: proposed; planning-only draft PR, 2026-11-04  
Source: [GitHub issue #78](https://github.com/cwchanap/arcturus/issues/78) (guest playthrough on 2026-10-30)  
Reviewed against: `main` at `1011c39e9bc8b2589b61cb34713e0ce2b54999ae`  
Implementation policy: **one PR for the entire issue**; extend this draft PR after design approval rather than opening separate code PRs.

## Problem and scope

The playtest reported five usability/trust findings and two questions. The core bet and payout rules should remain intact. This proposal addresses confirmed UI and reset behavior, makes public copy honest, and clarifies existing rules. It does not introduce new services, persistence, external APIs, or broad architectural refactoring.

### Evidence and decisions

| Item | Repository evidence | Decision |
| --- | --- | --- |
| 1. Sic Bo: bets survive New Round | `src/lib/sic-bo/game.ts` `resetRound()` deliberately retains `bets`; `src/lib/sic-bo/client.ts` reuses that method; unit and E2E tests assert retained slips | **Fix.** New Round means an empty bet slip. Explicit rebet is not needed. |
| 2. Video Poker: blank-looking white cards | `src/lib/video-poker/client.ts` sets ranks/suits through `setSlotState`; `CardSlot.astro` has markup, but shared `global.css` gives white card backgrounds without neutral legible face typography, while poker and blackjack face styles are separately scoped | **Fix.** Add minimal default legible styles to the shared card slots; retain game-specific overrides. |
| 3. Roulette: NET empty after winning spin | `rouletteClient.ts` applies the settlement and enables New Round before a `SPIN_ANIMATION_MS = 4000` timer calls `RouletteUIRenderer.showResult()`; only `showResult()` writes `#net-delta` | **Fix.** Make NET/result presentation synchronous with accepted settlement, not contingent on a timer. |
| 4. Footer legal links | `src/layouts/AppLayout.astro` has two `href="#"` placeholders | **Fix.** Both links navigate to meaningful sections on a small local informational page. |
| 5. Fabricated player counts | `src/pages/index.astro` hard-codes 5,680+ online and game-card player numbers, passed to `GameCard.astro` | **Fix.** Remove unsupported active-player claims; replace the hero with a factual count of listed games. |
| Pai Gow Joker | `src/lib/pai-gow-poker/rules.ts` already allows semi-wild Joker completions; `rules.test.ts` covers four suited cards + Joker forming a flush | **No rules fix.** Explain the policy in How to Play and cover the reported three-club hand. |
| Daily Challenge practice loss with no cards | `daily.ts` permits natural outcomes to settle on `start-round`; `daily-ui.ts` clears hands and draws only `activeRoundPublic`, which is null after instant settlement | **Targeted display fix.** Preserve the just-completed hand/result in practice mode. The specific original incident is unverified. |

## Proposed behavior

### A. Sic Bo — each new round starts with no bets

- `SicBoGame.resetRound()` transitions to `betting` and resets `lastResult` **and `bets`**. Roll history stays in the client-side history collection.
- The stake label becomes zero; all bet cells have no amount and `aria-pressed="false"`; Roll is disabled until the player deliberately places a bet.
- The same reset semantics apply to successful authenticated settlement recovery via `onResetRound`. Keep the existing Retry/Reset settlement gate and do not change `roll()`, payout formulas, denominations, or balance adoption.
- Clicking an already-selected bet remains the existing remove/toggle action during an active betting phase. Do not implement automatic repeat bets or a new preference.

### B. Video Poker — readable face-up cards

- Use the existing `CardSlot` and `setSlotState`. The reported visible problem is styling, not a missing card or evaluator state.
- Define a minimal baseline for face-up `[data-card-slot]` cards: dark readable rank/suit text on the white face, red for hearts/diamonds, black for clubs/spades, and positioned upper/lower corners plus center suit.
- Preserve `poker.css` and `blackjack.css` presentation overrides. Scope baseline selectors to card slots instead of changing all buttons or text.
- Keep card dimensions, hold-overlay geometry, aria-labels, selected holds, and the existing draw/evaluation flow unchanged. No card image generation or new art needed.

### C. Roulette — result/readout moves together with settlement

- On a successful guest spin or authoritative spin response, construct the existing `SpinResult`, apply the existing settlement exactly once, and immediately call `ui.showResult(spinResult)` (NET, winning number/color, and per-bet breakdown).
- Keep the wheel transition/animation visual; it must not gate visibility of an already-settled result. Eliminate the redundant pending-result timer and its stale-callback/new-round cancellation path rather than add additional phase or timing state.
- `ui.update()` continues controlling balance, history, and button availability. `New Round` clears the old result and opens fresh betting. Restored `settled` sessions still show the previous result. Existing duplicate/uncertain-settlement behavior must remain unchanged.
- Positive, negative, and zero NET values use existing localized `formatRouletteNet`. No payout math, API shape, or storage changes.

Tradeoff: revealing the result before the wheel has stopped reduces suspense, but avoids a stale/readout mismatch and keeps the implementation simple. A future animation-specific design would be separate from this bug fix.

### D. Honest footer links and copy

- Add one small public Astro page at `src/pages/responsible-play.astro`, with sections `#responsible-gaming` and `#age-guidance`; point the existing footer links to those anchors.
- State accurately that Arcturus uses virtual play-money chips, that chips have no monetary value or cash-out, that users should take breaks, and that the product is intended for an adult audience. Do **not** claim verified age enforcement or legal compliance when neither exists.
- Reuse `CasinoLayout` or the established shared page shell. Provide compact text in en, zh-Hant, zh-Hans, and ja via the existing localization approach, without introducing a CMS or new policy backend.
- The links should navigate rather than merely change the page hash to `#`.

### E. Honest lobby statistics

- Delete the hard-coded `players` field from the home game registry and `GameCard` props/UI, along with unnecessary `playersPlaying` strings.
- Replace `5,680+ Players Online` with `games.length` and localized “Games available” wording (as the registry count, not a live presence estimate). Keep the existing card links, names, minimum wagers, and featured state.
- No live user presence service, database counts, polling, fake approximations, or new tracking. If the site later needs active users, that should be built from actual measurements in a separate feature.

### F. Pai Gow — clarify the existing Joker contract

- In five-card High hands, Joker acts as an Ace except when it can complete a straight, flush, straight flush, or royal flush; four natural Aces plus Joker form five Aces. In two-card Low hands it counts as an Ace.
- Explain the distinction in each locale’s `howToPlayBody` without changing `rules.ts`.
- Regression: `9♣ K♣ 7♣ 5♥ Joker` contains only three natural clubs and therefore **cannot** be a flush: replacing Joker with a club gives four clubs plus one heart. Assert the evaluator's high-card outcome; retain the positive four-club-plus-Joker flush case.

### G. Daily Challenge — show instantly settled practice hands

- A starting Blackjack deal can legally settle immediately (e.g. a natural). The local `replayDailyRun` correctly records the round in `replay.rounds`, but leaves `activeRoundPublic` null.
- When practice has no active round but has completed rounds, render its **latest completed** round's face-up player/dealer cards and simple localized win/loss/push + net result from the already-available `replay.rounds.at(-1).replay`. Use existing Blackjack presentation/projection helpers where practical. Hold it until the next explicit round/restart.
- Do not change outcome calculation, bankroll, ranked APIs, replay determinism, seeds, or persisted ranked state. Only practice gets this browser-local last-hand presentation.
- The observed incident has not been reproduced; do **not** claim a double event or automatic forfeit. Investigate repeat-click handling only if a deterministic test demonstrates a separate duplicate-round defect. Keep this fix focused on the visible evidence.

## Architecture

Keep ownership in existing modules:
- `src/lib/<game>/`: rules, state and browser presentation for the affected game.
- `src/components/CardSlot.astro` / `src/styles/global.css`: smallest reusable card typography baseline.
- `src/layouts/AppLayout.astro` and `src/pages/responsible-play.astro`: informational navigation.
- `src/pages/index.astro` / `src/components/GameCard.astro`: truthful lobby metadata.
- `src/lib/i18n/messages/*`: localized copy.

No D1 migrations, new npm dependencies, external calls, shared “game reset” abstraction, compatibility layer, or additional Worker/DO service.

## Acceptance criteria

1. Sic Bo: after completing any round, New Round empties every bet, resets total stake to zero, and disables Roll until a new selection; balances and one-time settlement remain correct.
2. Video Poker: all five dealt cards have visibly legible, appropriately colored ranks and suits in both desktop and mobile views; hold controls and gameplay remain functional.
3. Roulette: immediately after a settled guest or authorized spin, the NET matches the settled net delta and the result/bet breakdown is visible; starting another round clears it; reload restores settled results.
4. Footer: both labels navigate to real sections with accurate content; there are no `href="#"` legal links.
5. Lobby: no fabricated live player/online numbers remain; game count equals rendered registered game cards and is translated in all four locales.
6. Pai Gow: unchanged semi-wild evaluator, explanatory Joker copy in all locales, and unit coverage for the exact reported hand plus a real Joker flush.
7. Daily practice: an immediately settled natural shows its cards and round result, with no extra command/API request, and only the intended bankroll change.
8. Existing supported-game and settlement regression suites still pass.

## Out of scope

Public casino launch readiness, regulatory certification, age verification, live presence analytics, new games, wallet rearchitecture, artistic redesign, new SFX/art assets, multiplayer/authenticated playtesting beyond focused regression checks, and investigation of a double-start bug without a reproducible case.

## Validation notes

Findings above come from **source review**, including existing tests, not a new deployed-browser reproduction. Build and E2E results are not asserted by this document. Implementation must run targeted Bun tests, lint/format/build checks, and focused guest Playwright journeys, plus the relevant authenticated wallet-recovery checks before merge.
