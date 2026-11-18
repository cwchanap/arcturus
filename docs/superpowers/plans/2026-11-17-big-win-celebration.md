# HPA-729 — Big-win celebration: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-729/all-games-big-win-celebration  
**Design:** [2026-11-17-big-win-celebration-design.md](../specs/2026-11-17-big-win-celebration-design.md)  
**Prerequisites:** HPA-725/726 complete; HPA-728 assets merged in [PR #89](https://github.com/cwchanap/arcturus/pull/89).  
**PR discipline:** **one PR for HPA-729**, initially documents-only. Add code, tests and review fixes to **this same draft PR**; do not create a second PR for implementation.

Keep it YAGNI/KISS: no backend, migration, new dependencies, art/SFX, generalized event bus, old settings compatibility, client-side router cleanup or RNG instrumentation.

## 1. Centralize the site-wide mute setting

- [ ] Add `src/lib/sound-preference.ts` as the single state owner: `casino_sound_muted`, default unmuted, `isSoundMuted()`, `setSoundMuted()`, `bindSoundToggle()`. The binder sets `aria-pressed`, localized accessible on/off label, one click handler and one same-page change listener. Accept optional `onToggle?: (muted: boolean) => void` to preserve Poker's audio confirmation without attaching another handler. Handle unavailable localStorage with a simple in-memory fallback. No migration from `poker_sound_muted`.
- [ ] Create small `src/components/SoundToggle.astro` and render it directly next to `LanguagePicker` in the **real** shared header, `src/layouts/AppLayout.astro`. No slot/prop needed.
- [ ] Update `src/lib/poker/sound.ts` and `PokerGame.ts`: remove captured `muted` state, read shared preference on every play/unlock; bind existing `#btn-sound` with the same helper, rather than custom two-way synchronization. Preserve existing table sounds and constructor testability via `isMuted?: () => boolean` injection; adapt `src/lib/poker/sound.test.ts` instead of maintaining a legacy storage seam. In `PokerGame`, use the binder's `onToggle` to `this.sound.unlock()` then `this.sound.play('check')` **on unmute**, all within one click handler. Update `src/lib/poker/PokerGame.test.ts:mockPokerGameDOM()` to implement `setAttribute` (and `removeEventListener` if needed); its mock currently stores only one callback per event. Update obsolete no-audio-file comment.
- [ ] Remove Slots' misleading `#setting-sound` control from `src/pages/games/slots.astro` and its unused `soundEnabled` handler/render, type, default, and settings sanitizer; the shared header is the sole sound control on Slots. Update existing `src/lib/slots/GameSettingsManager.test.ts` and `SlotsUIRenderer.test.ts` fixtures that reference `soundEnabled`, and remove the now-unused `sound` message key across the four locales in `src/lib/i18n/messages/slots.ts`. Other games' unused settings are out of scope.
- [ ] Add focused tests for preference read/write, same-page two-button synchronization, persistence, missing storage and Poker audio gating. Avoid a generalized settings/store layer.

## 2. Add the focused celebration module using existing assets

- [ ] `src/lib/celebration/tier.ts`: one `WIN_TIER_MULTIPLES` block for **stake: 5×/20×** and **Poker BB: 20/50**; pure `winTier(measure, unit, multiples)` with inclusive thresholds (huge first), nonfinite/zero/negative rejection.
- [ ] `src/lib/celebration/index.ts`: `celebrateWin({win,stake})` for ordinary games; `showCelebration(tier,amount)` for Poker after calling `winTier(humanWon, handBigBlind, ...bigBlind)`. No `tier?` override or unused `anchor?` argument: bursts start at viewport center until there is a real anchor caller.
- [ ] Lazily `document.body.append` one fixed, **pointer-transparent, `aria-hidden="true"`** overlay. Big: 30–40 gold/red/blue chip images and small sparkles, animated by WAAPI spin/scaleX, gravity-like drift and fade over about 1.6s. Huge: add existing 960×320 ribbon and a translated title/animated net `formatChips` inside the measured **(165,64,630,192)** native safe rectangle.
- [ ] Replace a running effect rather than stacking: cancel previous animations, clear any timeout and remove old nodes; clean up after 1.6s. Plain document navigation requires no bespoke cleanup hook. Under reduced motion, show static net amount (big) or ribbon/title/amount (huge), without particles/count-up; still clean up.
- [ ] Lazily play `public/audio/fx/coin-shower.mp3` on big and both shipped MP3s on huge with `HTMLAudioElement`, gated by `isSoundMuted()`; pause/reset any reused clip (`currentTime = 0`) before replaying, and use `try/catch` around `Promise.resolve(audio.play()).catch(() => {})` so synchronous failures, rejected Promises and mock `undefined` returns do not interrupt results. No new audio dependency or gain tuning.
- [ ] Happy-dom/Bun tests: tier boundaries, loss/push/invalid inputs, overlay replacement/cleanup, reduced motion, localized text, rejected audio, shared mute. The browser result is already announced elsewhere, so do **not** add a live region.

## 3. Reuse the two already-established round-measure rules

- [ ] **Blackjack:** in `src/lib/blackjack/blackjackClient.ts`, add `blackjackRoundNet(outcomes, playerHands): {win,stake}` next to `buildBlackjackSettlementCommand` and reuse the per-hand `payout - bet` basis. Use the pre-`settleRound()` player hands; calculate once across split/double bets, including **guest** results. Test helper in existing `blackjackClient.test.ts`.
- [ ] **Craps:** factor existing win/lose/push filtering out of `src/lib/craps/settlement.ts:buildCrapsSettlementCommand` into `resolvedEvaluations(result)`; export `resolvedCrapsStake(result)` summing **`evaluation.bet.amount + (evaluation.bet.odds ?? 0)`** from that same resolved list. Continuing wagers are excluded. Test in existing `craps/settlement.test.ts`, including 10 Pass Line + 50 attached Odds = **60 at risk**; +110 net is only 1.83×, not a big win.
- [ ] Keep these functions near the owning settlement rules; do not add duplicate payout classifiers to the pages or a new cross-game settlement abstraction.

## 4. Wire the existing **one-shot visible result** seams

One browser composition call per casual game. Keep domain classes, wallet modules, and API routes unchanged.

| Game | Edit location | Input |
| --- | --- | --- |
| Blackjack | `blackjack/blackjackClient.ts:handleRoundComplete` after visible result | `blackjackRoundNet(outcomes, state.playerHands)`, once including splits/doubles |
| Baccarat | `pages/games/baccarat.astro` after `animateRound` + `showResult` | `roundNetDelta`, sum `outcome.betResults[].bet.amount` |
| Craps | `pages/games/craps.astro` after `showRollResult` | `result.netDelta`, `resolvedCrapsStake(result)` (base + attached odds) |
| Poker | `poker/PokerGame.ts:presentHandResult` | Cash **and solo Sit & Go**; positive frozen `delta` + contested `humanWon` vs 20/50BB thresholds; `showCelebration(tier, delta)` |
| Slots | `slots/slotsClient.ts:reveal` after `renderResult` | `result.netDelta` / `result.bet` |
| Roulette | `roulette/rouletteClient.ts:animateAndScheduleReveal` guarded `reveal` | `spinResult.netDelta` / `spinResult.totalBet`; **not** on restore/hydration |
| Keno | `keno/kenoClient.ts:commitDraw` after `renderLastResult` | `result.netDelta` / `result.bet` |
| Video Poker | `video-poker/client.ts` after `game.draw()` + `render()` | `round.netDelta` / `round.wager` |
| Sic Bo | `sic-bo/client.ts` after `game.roll()` + `render()` | `result.netDelta` / `result.totalStake` |
| Three-Card Showdown | `three-card-showdown/client.ts` after fold/play + `render()` | `round.netDelta` / `round.totalWager` |
| Pai Gow Poker | `pai-gow-poker/client.ts` after `game.confirm()` + `render()` | `result.netDelta` / `result.wager` |

- [ ] For Poker, replace the synthesized `bigWin` **only when a new tier fires**; keep `win`, action sounds and existing high-ranked-hand `bigWin` for other wins. Suppress duplicate fanfares when both new MP3s play.
- [ ] Ensure no calls from Ranked Blackjack, Daily Challenge, or private-room Poker. Solo Sit & Go remains in scope through `PokerGame` (no new route).
- [ ] The existing one-shot reveal location is the single-fire guarantee. Do not build fresh DOM closure harnesses for seven one-line client hooks; cover reusable measures and Poker branch in existing tests and smoke one real end-to-end guest-game flow with browser MCP.
- [ ] Any audio/DOM failure remains best-effort and **never** blocks wallet settlement or the next game round.

## 5. Regression tests and browser-MCP acceptance

**No UI mockup exists in Linear.** All visual verification is screenshot-based against the existing Arcturus style. One browser/platform with phone emulation suffices.

- [ ] Unit/Bun/happy-dom: `winTier` inclusivity (5/20 stake, 20/50BB), negative/invalid inputs; Blackjack split/double aggregate; Craps continuing bets omitted and attached odds included; Poker contested-pot tier, preserved unmute `'check'` cue and previous cue suppression; binder/mock compatibility, reload, cached audio replay and rejected/undefined `play()` returns; overlay lifecycle/reduced motion. Reuse current test suites rather than inventing client harnesses.
- [ ] Commit **one small Playwright spec** `e2e/big-win-celebration.spec.ts`. On the existing Vite dev server use `page.evaluate(async () => { const fx = await import('/src/lib/celebration/index.ts'); fx.celebrateWin({ win: 200, stake: 10 }); })` with no production debug route/window global/RNG rigging. Assert ribbon title and count rectangles stay inside the scaled (165,64,630,192) safe rectangle for **en/zh-Hant/zh-Hans/ja × desktop/phone**; check pointer-events and click-through. This automated geometry regression **complements** MCP acceptance, not substitutes for it. Follow existing `e2e/card-legibility.ts` and `e2e/i18n-activation.spec.ts` patterns.
- [ ] **Browser MCP is the end-to-end acceptance owner:** on a running real casual game page, complete one normal guest round through its UI to verify play/result still works. Then use the same dev-module import in its browser JS console to trigger fixed big, huge and reduced-motion displays without relying on random high wins.
- [ ] **Browser-MCP screenshot checks** at **1280×800** and **375×812** for big/huge/reduced motion; inspect painted chips/alpha, accessible visual contrast, decorative ribbon and amount, mobile overflow and compatibility with existing game UI. Use the four-locale Playwright geometry evidence; MCP can spot-check copy visually without manually repeating all eight numeric cases.
- [ ] Record screenshot paths or links, actual browser MCP commands/actions and visual findings in this **same PR**. No human sign-off is an automated acceptance criterion.

## 6. Run quality checks; keep one PR

- [ ] Verify `bun run test`, `bun run lint`, `bun run format:check`, `bunx astro check`, `bun run build` and the new Playwright regression on the **implemented** code diff. Document actual results; draft PR CI may skip jobs, so don't claim unexecuted checks passed.
- [ ] Check final diff is focused: one shared sound preference, one shared FX module, existing 11 result seams, removed dead Slots control, narrow tests, no new media/backend/dependencies.
- [ ] Add implementation commits, review responses and automated MCP screenshot evidence **to PR #91**. Remain draft until implementation and acceptance are complete; then change readiness and Linear status as appropriate. One task/ticket = **one PR**.

## End-to-end acceptance criteria

- [ ] All 11 casual games (including solo Sit & Go) use existing reveal seams to pass actual **net** amount and round stake; 5×/20× and Poker 20/50BB trigger correctly (Craps stake counts attached odds), with no effect for negative/zero wins, invalid measure, restored results, wallet retry, Ranked/Daily/private-room play.
- [ ] One pointer-transparent `aria-hidden` overlay with preexisting HPA-728 imagery/SFX, clean replacement/cleanup and reduced-motion static alternatives. No duplicate Poker big-win audio, preserved unmute confirmation, replayable cached SFX, no gameplay/input obstruction.
- [ ] Site-wide `casino_sound_muted` is the **only effective mute control** for Poker and celebration audio, synchronized between header and Poker and persistent across route navigation; Slots does not retain an inert checkbox. Unused Baccarat/Craps settings remain outside this ticket.
- [ ] Four-locale ribbon text/count fits the safe area in the Playwright regression across both viewport sizes; **browser-MCP E2E and screenshot visual checks** of big/huge/reduced-motion and a normal game flow pass on one platform.
- [ ] All code quality, unit/integration, build and relevant E2E/regression checks pass with evidence recorded; no backend changes exist, so backend E2E is not applicable.

**Planning-only right now:** no feature code, tests or browser-MCP checks are claimed to have executed.
