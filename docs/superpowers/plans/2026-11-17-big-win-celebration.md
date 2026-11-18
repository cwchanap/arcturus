# HPA-729 — Big-win celebration: implementation plan

**Ticket:** https://linear.app/cwchanap/issue/HPA-729/all-games-big-win-celebration  
**Design:** [2026-11-17-big-win-celebration-design.md](../specs/2026-11-17-big-win-celebration-design.md)  
**Dependencies:** HPA-725 and HPA-726 complete; HPA-728 asset-only [PR #89](https://github.com/cwchanap/arcturus/pull/89) merged.  
**PR policy:** **one PR** for HPA-729. This PR starts as documentation-only and remains **draft** while implementation and tests are added to the **same branch/PR**. Do not spawn a second implementation PR.

No backend/API/DB changes, packages, new art or SFX, generalized event bus, unneeded compatibility or new test-only production routes. Existing assets and modules are enough.

## 1. Implement the small reusable presentation boundary

- [ ] Add `src/lib/celebration/` with a pure normal-game tier selector (inclusive 5×/20× thresholds, positive net and stake validation) and the browser function `celebrateWin({ win, stake, anchor?, tier? })`. Keep poker's BB threshold policy **in PokerGame**, supplying only the computed tier override.
- [ ] Create the effect once on demand: one fixed, pointer-transparent overlay per casino page; 30–40 images using `public/images/fx/{chip-gold,chip-red,chip-blue,sparkle}.webp` with WAAPI gravity-like drift, spin and scaleX coin flip. Anchor is optional; fallback to viewport center. Animate and clean up in ~1.6s; cancel/replace a prior effect on repeat.
- [ ] Add the `big-win-ribbon.webp` huge-tier overlay with an accessible localized HTML title and net chip count-up. Honor the measured **(165,64,630,192)** text-safe band in the 960×320 ribbon; ensure it scales to 375px without clipping. Use existing `formatChips` and four-locale typed dictionary.
- [ ] Detect reduced motion and show **static big amount / huge ribbon+amount** instead of particles or number tweening; clean up the static layer too.
- [ ] Load/preload two shipped MP3s via simple lazy `HTMLAudioElement`; play coin shower for big, both files for huge; ignore blocked audio/absent APIs. No sound plays when muted.
- [ ] Add focused `*.test.ts` happy-dom tests for boundary ratios and invalid inputs, exact tier selection, one effect at a time, 30–40 chips, cleanup/cancel, reduced motion, banner label/count, mute, and rejected playback. Keep browser globals injectable/mocked only as needed; don't add an FX dependency.

## 2. Wire one preference and one casino header control

- [ ] Introduce `casino_sound_muted` as the single localStorage preference, with default unmuted. No old-key migration or history compatibility.
- [ ] Use `src/layouts/casino.astro` for the casino-specific control but integrate into the actual header markup in `src/layouts/AppLayout.astro` through one small header slot/prop (not a second header). Add accessible localized label and `aria-pressed`; load the preference when the browser script starts.
- [ ] Adapt `src/lib/poker/sound.ts` to use the same key and react to changes made by the header **after** poker sound's singleton initialized. Conversely, clicking the existing poker `#btn-sound` immediately updates the header. Keep `createPokerSound`'s test-injected storage and preserve other poker SFX; update obsolete file header.
- [ ] Use one lightweight same-page notification for synchronized toggles; optional browser storage event if needed. Global mute overrides any per-game celebration sound. No complex settings store.
- [ ] Test both button directions, initial mute, persistence across navigation, correct UI state/accessible label and muted poker/celebration playback in happy-dom.

## 3. Add one result-time hook per existing casual game

Treat this table as a checklist; do **not** modify game-rule classes, wallet settlement, or introduce one common game-event framework.

| Game | Planned insertion | Measure and caution |
| --- | --- | --- |
| Blackjack | `src/lib/blackjack/blackjackClient.ts:handleRoundComplete` after outcomes available and visible | Compute `sum(payout - bet)` and `sum(bet)` across completed split/double hands **once** |
| Baccarat | `src/pages/games/baccarat.astro` after `animateRound; showResult` | `roundNetDelta`, sum of `outcome.betResults.bet.amount` |
| Craps | `src/pages/games/craps.astro` after `showRollResult` | `result.netDelta`; sum resolved evaluation wagers only (skip continue) |
| Poker | `src/lib/poker/PokerGame.ts:presentHandResult` | Cash and solo Sit & Go; `delta>0` and `contested humanWon >=20/50*handBigBlind`; pass tier override; suppress overlapping synthesized `bigWin` and preserve normal cue below threshold |
| Slots | `src/lib/slots/slotsClient.ts:reveal` | `result.netDelta` / `result.bet`, after spin reveal; do not re-fire on wallet completion |
| Roulette | `src/lib/roulette/rouletteClient.ts:animateAndScheduleReveal` guarded `reveal` | `spinResult.netDelta` / `totalBet`; never reveal win early or on restored session |
| Keno | `src/lib/keno/kenoClient.ts:commitDraw` after last-result display | `result.netDelta` / `result.bet` |
| Video Poker | `src/lib/video-poker/client.ts` after draw+render | `round.netDelta` / `round.wager` |
| Sic Bo | `src/lib/sic-bo/client.ts` after roll+render | `result.netDelta` / `result.totalStake` |
| Three-Card Showdown | `src/lib/three-card-showdown/client.ts` after fold/play+render | `round.netDelta` / `round.totalWager` |
| Pai Gow Poker | `src/lib/pai-gow-poker/client.ts` after confirm+render | `result.netDelta` / `result.wager` |

- [ ] Wire all **11** rows and confirm none of `daily-challenge`, `blackjack-run` ranked route, `poker-mp` imports the feature; solo Sit & Go is included through `PokerGame`.
- [ ] Reuse current net/round-stake fields; do not infer “net win” from gross payout or account balance after asynchronous wallet reconciliation.
- [ ] Keep effects cosmetic and synchronous/best-effort. A failed animation/audio request must never block resolution, settlement or the next round. Wallet retry/adoption, state hydration and rerender must not re-fire a celebration.
- [ ] Add/extend the smallest relevant existing game tests for payload selection and single-fire semantics, especially Blackjack split/double aggregation, Craps pending wagers, Roulette delayed reveal, Poker contested pot and legacy cue, and slots guest/auth paths. Do not build a fake RNG integration framework.

## 4. Browser-MCP end-to-end and visual acceptance

There is **no UI mockup in Linear**, so screenshots are mandatory. Use **one browser/platform** (desktop Chrome plus phone-size emulation is sufficient).

- [ ] Run the real Astro app locally and open a casual single-player game page, including guest play. Use browser MCP to trigger the exported `celebrateWin` on that live page with deterministic 5×/20× values, **without modifying game RNG** or adding a committed debug route.
- [ ] Capture at least **1280×800 desktop** and **375×812 phone** screenshots of both tiers and the reduced-motion state; compare actual appearance with the established dark-green/gold casino styling and HPA-728 asset preview. Check 24–48px chip legibility, alpha, sparkle, no overflow, and ribbon central text within native safe band.
- [ ] Switch among `en`, `zh-Hant`, `zh-Hans` and `ja` on the real page, capture/inspect the huge-ribbon HTML text and final localized chip amount. Measure title and count bounding boxes against the ribbon's central safe area at desktop and phone widths. Check no clipped or overlapping text.
- [ ] Inspect DOM after ~1.6s: effect nodes cleared, repeated invocations do not accumulate children, and elements behind the overlay remain clickable. Test reduced motion with browser emulation: no moving chips/number tween, static text still appears and disappears.
- [ ] Toggle sound from header and from the poker table separately; verify both `aria-pressed` states synchronize, persistence after page navigation, and no new MP3 playback while muted. Browser audio policies may block sound: verify that rejection does not throw or break a round; unit tests prove playback choice.
- [ ] Where feasible perform one normal guest game's end-to-end round and inspect the result seam; tier threshold checks remain deterministic unit tests (do **not** require a lucky high payout in live gameplay). Record screenshot links, measured bounds and browser-MCP actions as PR evidence.
- [ ] No human approval step is an acceptance condition; no Playwright RNG rigging or duplicated multi-browser acceptance required.

## 5. Quality and one-PR completion

- [ ] Run `bun run test`, `bun run lint`, `bun run format:check`, `bunx astro check`, `bun run build` locally on the implemented diff. Existing docs under `docs/superpowers` are Prettier-ignored: review these two Markdown files directly.
- [ ] Verify that the PR changes stay focused (small shared effect, shared preference, existing 11 client seams, narrow tests and styles), with **zero** DB/schema/API/dependency/asset-generation changes. The HPA-728 seven media assets are reused, not replaced.
- [ ] Update this **same** PR with implementation, commit hashes, actual commands/results, and browser-MCP screenshot evidence. Keep it **draft until code and automated acceptance complete**; do not claim checks passed while only the documentation exists. Then mark ready for review and update Linear as appropriate.

## End-to-end acceptance criteria

- [ ] All **11** casual games invoke the shared effect **once** when a new visible positive-net result crosses the correct tier threshold; loss, push, invalid stake, restored rounds, settlement retry, Ranked/Daily/private-room multiplayer never trigger it.
- [ ] **5×/20× net ratio** and **20/50 BB contested Poker** boundaries are unit-tested, with Blackjack splits/doubles and Craps resolved-stake calculations covered.
- [ ] Big and huge render the seven preexisting art/SFX assets as specified; animated nodes/timers are fully cleaned or canceled; ~375px phone remains smooth and no gameplay control is obstructed.
- [ ] **Browser MCP visual E2E:** real game page at desktop+phone sizes and all four locales; screenshot comparisons and measured ribbon safe-area checks pass without an existing Linear mockup. Reduced motion renders static readable UI; accessible localized amount/title remain correct.
- [ ] Header and poker mute toggle share persistent state on the same page and across navigation; synthesized poker sound and HTMLAudioElement celebration playback both honor it, with no doubled big-win cue.
- [ ] Existing code-quality, unit/integration and production-build commands pass, and **real evidence** is recorded on the PR. No new backend behavior exists, so backend E2E is not applicable.

**Implementation is not part of this initial documentation commit.** All unchecked boxes are work for the implementation phase **within this one draft PR**.
