# Issue #78 — Guest playtest follow-up: design

Status: implemented in PR #79; final review fixes and delivery verification in progress, 2026-11-04\
Source: [GitHub issue #78](https://github.com/cwchanap/arcturus/issues/78) (guest playthrough on 2026-10-30)  
Reviewed against: `main` at `1011c39e9bc8b2589b61cb34713e0ce2b54999ae`  
Implementation policy: **one PR for the entire issue**; extend this draft PR after design approval rather than opening separate code PRs.

## Problem and scope

The playtest reported five usability/trust findings and two questions. The follow-up review [on PR #79](https://github.com/cwchanap/arcturus/pull/79#issuecomment-6647132211) establishes the agreed component-scoping and both-mode Daily corrections. The core bet and payout rules should remain intact. This proposal addresses confirmed UI and reset behavior, makes public copy honest, and clarifies existing rules. It does not introduce new services, persistence, external APIs, or broad architectural refactoring.

### Evidence and decisions

| Item | Repository evidence | Decision |
| --- | --- | --- |
| 1. Sic Bo: bets survive New Round | `src/lib/sic-bo/game.ts` `resetRound()` deliberately retains `bets`; `src/lib/sic-bo/client.ts` reuses that method; unit and E2E tests assert retained slips | **Fix.** New Round means an empty bet slip. Explicit rebet is not needed. |
| 2. Three games: blank-looking white cards | `CardSlot.astro` is used by Video Poker, Pai Gow and Three-Card Showdown; all inherit ivory body text over the white card face without component-local positioning/color rules. Poker and Blackjack use other components with overlapping CSS class names. | **Fix.** Add component-scoped `<style>` rules in `CardSlot.astro` only; leave `global.css`, Poker and Blackjack styles unchanged. |
| 3. Roulette: NET empty after winning spin | `rouletteClient.ts` settles and calls `ui.update()` (balance / New Round) immediately, but calls `showResult()` only after the 4-second wheel animation; the tester therefore sees a settled balance beside the pre-reveal result. | **Fix.** Hold all settlement-facing UI until a single reveal after the wheel stops; keep internal settlement/persistence immediate. |
| 4. Footer legal links | `src/layouts/AppLayout.astro` has two `href="#"` placeholders | **Fix.** Both links navigate to meaningful sections on a small local informational page. |
| 5. Fabricated player counts | `src/pages/index.astro` hard-codes 5,680+ online and game-card player numbers, passed to `GameCard.astro` | **Fix.** Remove unsupported active-player claims; replace the hero with a factual count of listed games. |
| Pai Gow Joker | `src/lib/pai-gow-poker/rules.ts` already allows semi-wild Joker completions; `rules.test.ts` covers four suited cards + Joker forming a flush | **No rules fix.** Explain the policy in How to Play and cover the reported three-club hand. |
| Daily Challenge: completed hands disappear | `daily.ts` sets `activeRound = null` for **every** completed hand (stand, bust, natural); `daily-ui.ts` clears hands and renders only active rounds in both practice and ranked, while the service returns only `activeRoundPublic`. | **Fix both modes.** Project the last completed round in the pure replay, expose it through the existing daily response, and render it when no round is active. The original single incident remains unverified. |

## Proposed behavior

### A. Sic Bo — each new round starts with no bets

- `SicBoGame.resetRound()` transitions to `betting` and resets `lastResult` **and `bets`**. Roll history stays in the client-side history collection.
- The stake label becomes zero; all bet cells have no amount and `aria-pressed="false"`; Roll is disabled until the player deliberately places a bet.
- The same reset semantics apply to successful authenticated settlement recovery via `onResetRound`. Keep the existing Retry/Reset settlement gate and do not change `roll()`, payout formulas, denominations, or balance adoption.
- Clicking an already-selected bet remains the existing remove/toggle action during an active betting phase. Do not implement automatic repeat bets or a new preference.


### B. Shared CardSlot — legible cards in all three games

- The affected component is `src/components/CardSlot.astro`, consumed by **Video Poker, Pai Gow Poker, and Three-Card Showdown**. All three need visible ranks and suits; `setSlotState` already writes their card data.
- Add a small **Astro component-scoped `<style>` block inside `CardSlot.astro`**: dark default face text against the existing white background; red for hearts/diamonds and dark for clubs/spades; positioned top/bottom card corners, with the bottom corner rotated 180 degrees; centered suit glyph. Reuse the minimal visual pattern already established in `src/styles/poker.css`, but do not change or import that game-specific file.
- **Do not add generic card-corner, card-center or transform declarations to `global.css`.** Poker and Blackjack share the class names but render through different components, with incompatible transform/rotate strategies. Component-scoped CSS avoids their DOM altogether.
- Preserve card dimensions, overlay/button alignment, aria-labels, and game state. No card art or new asset generation.
- Add a computed-style/legibility check to Video Poker E2E and at least one of Pai Gow / Three-Card Showdown; smoke-check the third. Verify both red and black suits and a small viewport.


### C. Roulette — reveal all result UI together after the wheel stops

- Keep the existing wheel spin suspense: the result should **not** be shown before the four-second `SPIN_ANIMATION_MS` transition finishes.
- On accepted guest or authenticated spin, immediately apply the **existing** settlement to the game, record achievements, and persist the settled session exactly as today. These domain/accounting operations must never wait for an animation.
- Have one `revealSpin(spinResult)` helper, called by a single animation timer in both branches, perform `ui.update(game.getState())` and `ui.showResult(spinResult)` in the **same callback**, so final balance, New Round button, winning number/color, NET and bet breakdown appear together.
- Keep the on-screen state **spinning / controls locked** during that interval. Authenticated spins already call `ui.update()` for their in-flight `game.beginSpin()` state. For guests, render an equivalent short-lived **presentation-only spinning snapshot** before `game.spinGuest()`; do not expose a still-enabled Spin or bet button while the internal game has settled. Avoid changing guest game rules just for this view.
- The New Round control stays hidden until reveal; remove its obsolete timer-cancellation path. Starting a new round clears the whole prior result as today. Reloading a persisted settled session can reveal the already-decided result immediately. Preserve duplicate, rejected and uncertain settlement behavior.
- Positive, negative, and zero NET use the existing localized `formatRouletteNet`; no payout math or API/storage changes. This replaces the original proposal to reveal the winning number immediately during the animation.

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


### G. Daily Challenge — preserve completed hands in both modes

- **Every** completed Daily hand currently disappears: `settleCompletedRound` pushes the outcome into `rounds` then nulls `activeRound`, and `renderCurrentView` clears both dealer and player hands when there is no active round. The problem affects **practice and ranked**, including naturals that settle on `start-round` without an input turn.
- In the existing pure `snapshotReplay` (`src/lib/blackjack-run/daily.ts`), project `rounds.at(-1)?.replay` using `projectBlackjackRoundReplay`, producing a nullable `lastCompletedRoundPublic` alongside `activeRoundPublic`; strip the internal `nextSequence` exactly as the active-round projection does. A completed projection already exposes the final dealer cards and `outcome`. When no round has settled, the field is null.
- In `src/lib/blackjack-run/protocol.ts`, add **required nullable** `lastRound: blackjackActiveRoundSchema.nullable()` to the existing **daily** response schema, not the ranked-blackjack mode. In `src/server/blackjack-run/service.ts`, return the replay's projection as `lastRound` for valid daily responses; respect existing expired-run data-handling policy. The daily branch is a **strict Zod object**, so all builders/fixtures must supply the field (initially `lastRound: null`), especially `dailyState()` in `src/lib/blackjack-run/daily-ui.test.ts`, `dailyActiveState()` in `src/server/blackjack-run/http.test.ts`, and `dailyPublicSample` in `src/lib/blackjack-run/protocol.test.ts`. Audit other daily samples so both compile-time and schema validations continue to pass. This is an in-place daily-response evolution, **not a new endpoint or D1 schema migration**.
- In `src/lib/blackjack-run/daily-ui.ts`, display `activeRound ?? lastRound` with the existing `renderActiveRound` for **both practice and ranked**. For practice, `lastRound` comes from `replay.lastCompletedRoundPublic`; for ranked it comes from `state.lastRound`. **Keep controls and forfeit visibility based only on the actual active round**, not the last-completed display projection, so players can start the next round.
- When showing a completed hand, display a succinct win/loss/push and net figure from its existing `outcome`. Reuse the established `blackjackTranslator` result keys and `formatBlackjackNet` (`ranked-ui.ts`) rather than adding duplicate Daily translations. **Status priority:** if practice is `active` and has no active hand, show the last completed result in `statusEl`; if practice is `completed` or `forfeited`, preserve `t('practiceComplete')` / `t('practiceForfeited')` in `statusEl` (or show the outcome in a separate element without replacing the terminal message). For ranked terminal states, preserve the existing receipt/terminal status rather than overwriting it with the last hand's outcome. A previous completed hand may still be visible on forfeit, but it must not disguise the forfeited state.
- The completed hand stays visible until the next explicit round/restart or a change of mode. Do **not** change outcome calculation, bankroll, ranked attempt constraints, deterministic replay, seed policy or round-command sequencing. The specific original playtest incident is unverified; do not assume an actual double-fired START ROUND bug without a deterministic reproduction.
- Add deterministic unit and UI tests for **natural** (settles on start) and **stand-settled** outcomes in both modes, including final dealer cards, NET, one round consumed, and correct wallet/score effects. Explicitly test practice complete/forfeited status precedence and ranked terminal receipt, plus required-null `lastRound` fixtures and strict protocol parsing.

## Architecture

Keep ownership in existing modules:
- `src/lib/<game>/`: rules, state and browser presentation for the affected game.
- `src/components/CardSlot.astro`: component-scoped legibility rules shared only by the three affected games; keep `src/styles/global.css` unchanged.
- `src/lib/blackjack-run/daily.ts`, `protocol.ts`, `daily-ui.ts`, and `src/server/blackjack-run/service.ts`: one pure projection and one daily-response field for practice and ranked presentation.
- `src/layouts/AppLayout.astro` and `src/pages/responsible-play.astro`: informational navigation.
- `src/pages/index.astro` / `src/components/GameCard.astro`: truthful lobby metadata.
- `src/lib/i18n/messages/*`: localized copy.

No D1 migrations, new npm dependencies, new endpoints, external calls, shared “game reset” abstraction, compatibility layer, or additional Worker/DO service. The existing Daily Challenge response schema gains exactly one nullable presentation field.

## Acceptance criteria

1. Sic Bo: after completing any round, New Round empties every bet, resets total stake to zero, and disables Roll until a new selection; balances and one-time settlement remain correct.
2. Video Poker, Pai Gow, and Three-Card Showdown: all dealt face-up cards have visibly legible, appropriately colored ranks and suits in both desktop and mobile views; hold controls and gameplay remain functional.
3. Roulette: while the wheel animates, bet controls remain locked and no new final balance/New Round is shown; when the spin is revealed, balance, NET, winning number and bet breakdown appear together and match the accepted settlement; New Round clears them, and reload restores settled results.
4. Footer: both labels navigate to real sections with accurate content; there are no `href="#"` legal links.
5. Lobby: no fabricated live player/online numbers remain; game count equals rendered registered game cards and is translated in all four locales.
6. Pai Gow: unchanged semi-wild evaluator, explanatory Joker copy in all locales, and unit coverage for the exact reported hand plus a real Joker flush.
7. Daily practice **and ranked**: natural and stand-settled hands retain final player/dealer cards and a win/loss/push + NET result until the next round, without extra commands/requests or changes to bankroll, ranked eligibility, or scoring. Practice completion/forfeit labels and ranked terminal receipts are preserved; strict daily schemas accept the updated fixtures.
8. Existing supported-game and settlement regression suites still pass.

## Out of scope

Public casino launch readiness, regulatory certification, age verification, live presence analytics, new games, wallet rearchitecture, artistic redesign, new SFX/art assets, multiplayer/authenticated playtesting beyond focused regression checks, and investigation of a double-start bug without a reproducible case.

## Validation notes

Findings above come from **source review**, including existing tests, not a new deployed-browser reproduction. Build and E2E results are not asserted by this document. Implementation must run targeted Bun tests, lint/format/build checks, and focused guest Playwright journeys, plus the relevant authenticated wallet-recovery checks before merge.
