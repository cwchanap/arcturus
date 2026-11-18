# HPA-729 — All-game big-win celebration: design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-729/all-games-big-win-celebration  
**Implementation plan:** [2026-11-17-big-win-celebration.md](../plans/2026-11-17-big-win-celebration.md)  
**Assets:** [HPA-728, merged PR #89](https://github.com/cwchanap/arcturus/pull/89)  
**Delivery:** one PR for HPA-729, initially design-only; add implementation and tests to **this same PR** after review.

## Goal and constraints

Give meaningful **net-positive** casual single-player wins a shared Art Deco celebration. Cover all **11** entries of `GAME_TYPES`, for both guest and authenticated casual play. This is **presentation-only**: wallet state, odds, random outcomes, score accounting, mission and achievement rules must not change.

Excluded: Ranked Blackjack, Daily Challenge, multiplayer poker rooms, Sit & Go, new generated art/audio, new backend routes or D1 schema, dependencies, generalized animation frameworks, legacy storage migration or compatibility scaffolding. HPA-725/HPA-726 are already merged; the separate HPA-728 assets are already on `main`.

## Win contract and tier policy

Expose the small browser-facing API `celebrateWin({ win, stake, anchor?, tier? })` in `src/lib/celebration/`. `win` is the **net chips gained**, not total gross payout; `stake` is the amount wagered for the resolved round. `anchor` is an optional DOM element; the viewport center is the fallback. `tier` is an optional precomputed `'big' | 'huge'` override **only for poker**, whose metric differs. The module does not import or inspect game types.

A pure tier function handles normal games:

- Ignore non-finite values, invalid/nonpositive stake, and `win <= 0`; an explicit poker tier cannot override the net-positive requirement.
- `huge` at `win >= 20 * stake`; otherwise `big` at `win >= 5 * stake`; otherwise no effect. Check huge first; comparisons are inclusive.
- Aggregate all simultaneous payouts and bets **once per round**. A Blackjack split/double-down uses the sum of final hand bets and the sum of `payout - bet` across hands, never a separate celebration for each hand. A win in one sub-bet with net loss overall does not qualify.
- **Poker cash only:** at presentation time, compute tier from the *contested pot awarded to the human*, with returned uncalled bets excluded. `huge` at `potWon >= 50 * handBigBlind`; `big` at `potWon >= 20 * handBigBlind`. Require `handResultDelta > 0`. Pass the tier as an override, and show the **net delta** as the count-up value. Preserve normal poker feedback for smaller wins. Tournament/Sit & Go rounds are out of scope.

The caller fires exactly once when its result is **visibly revealed**, not during delayed animation, wallet retry, rerender, restored-state hydration or a generic balance update. Rendering is best-effort and cannot fail a game round.

## Visual behavior and asset contract

Assets already exist on `main`:

- `public/images/fx/chip-gold.webp`, `chip-red.webp`, `chip-blue.webp`, `sparkle.webp` (four 128×128 transparent WebPs).
- `public/images/fx/big-win-ribbon.webp` (960×320 transparent WebP); its measured native text-safe area is approximately **(165, 64, 630, 192)**.
- `public/audio/fx/coin-shower.mp3` (~1.48s) and `big-win-sting.mp3` (~2s).

Use **one** lazily created, fixed-position overlay in the casino layout, `pointer-events: none` and above game content. Do not create an overlay for every game module.

- **Big:** 30–40 painted chip images burst from the anchor/viewport center; use Web Animations API translate/rotate/scaleX (coin flip), gravity-like vertical motion, fade over roughly **1.6s**, and a small sparkle. Keep particles within reasonable phone viewport bounds.
- **Huge:** big particles plus the original ribbon with a localized HTML **Big Win** title and animated, locale-formatted net chip amount. Place the HTML in the ribbon's known safe band, not over decorative edges. Count up to the exact final positive net amount.
- Cleanup the overlay children, animations and any pending timer after the effect; a second celebration replaces the previous effect rather than accumulating nodes. Avoid leaving orphaned text, even after a rapid navigation or another result.
- On `prefers-reduced-motion: reduce`, **no particle motion** or numeric count-up; show a concise static localized amount for big, or the static ribbon + amount for huge, with normal cleanup. Keep an accessible result description without duplicating announcements from the game's existing live result.
- UI is decoration; it must never trap focus, cover controls for hit-testing, block the game or alter existing result display.

The ribbon's HTML overlay must fit at 1280×800 and 375×812 CSS viewports for all four supported locales (`en`, `zh-Hant`, `zh-Hans` and `ja`). Use the shared `formatChips` helper and typed `defineMessages` dictionary; no baked-in text or new i18n framework.

## Site-wide sound and layout integration

Create one browser preference with a new key `casino_sound_muted`, default unmuted. There is no need to import the obsolete `poker_sound_muted` value or preserve it. Sound playback uses lazy `HTMLAudioElement` instances for the two committed MP3 files, created/preloaded upon first use (or after first user gesture); catch playback rejection and leave game results unaffected.

- Big plays `coin-shower`. Huge plays **both** coin-shower and big-win-sting. The merged asset review measured a safe simultaneous mix; do not add volume boosting or a new audio dependency.
- Poker's synthesized `win`, `chips` and action effects remain. When an HPA-729 celebration fires, **do not additionally play** the old synthesized `bigWin` cue; when a smaller poker win does not qualify, preserve the preexisting normal/large feedback. Update `src/lib/poker/sound.ts`'s obsolete "no audio files ship" header.
- The visible header markup actually lives in `src/layouts/AppLayout.astro`, while `src/layouts/casino.astro` wraps it. Insert the casino-only mute action via a small **named header slot or casino-specific prop**, avoiding a duplicate full header. Include a mute toggle with localized accessible label, real `aria-pressed` state, and keyboard activation.
- The poker table's existing `#btn-sound` stays available. Both it and the global header toggle read/write the **same** preference and update one another immediately on the current page. Existing `createPokerSound` test injection remains viable. Sync the poker singleton's cached mute state, including if the header is toggled after page initialization. A small same-page change event is sufficient; do not build a settings store.
- The Slots settings checkbox currently has its own legacy sound setting; the global mute must take precedence over any new celebration playback, without broad Slots settings refactoring.

## Concrete casual-game wiring map

| Game | Existing result point | Positive net win and round stake |
| --- | --- | --- |
| Blackjack | `src/lib/blackjack/blackjackClient.ts` `handleRoundComplete` after `settleRound`, when result text is displayed | Aggregate outcomes `sum(payout - hand.bet)` and `sum(hand.bet)` using the pre-settlement hands; includes split/double |
| Baccarat | `src/pages/games/baccarat.astro` after `animateRound` and `showResult` | Already captured `roundNetDelta`; stake `sum(outcome.betResults[].bet.amount)` |
| Craps | `src/pages/games/craps.astro` immediately after `showRollResult` | `result.netDelta`; sum the `amount` of resolved win/lose/push `result.evaluations[].bet`, excluding continue/pending wagers |
| Poker | `src/lib/poker/PokerGame.ts` `presentHandResult` | Frozen `delta > 0`; qualifying contested `humanWon` relative to `handBigBlind`, cash mode only |
| Slots | `src/lib/slots/slotsClient.ts` in the one-time `reveal()` after `renderer.renderResult` | `result.netDelta` / `result.bet` |
| Roulette | `src/lib/roulette/rouletteClient.ts` in guarded `animateAndScheduleReveal` reveal callback | `spinResult.netDelta` / `spinResult.totalBet`; never reveal before wheel completes or re-fire on hydration |
| Keno | `src/lib/keno/kenoClient.ts` in `commitDraw` after `renderer.renderLastResult` | `result.netDelta` / `result.bet` |
| Video Poker | `src/lib/video-poker/client.ts` after `game.draw()` and `render()` | `round.netDelta` / `round.wager` |
| Sic Bo | `src/lib/sic-bo/client.ts` after `game.roll()` and `render()` | `result.netDelta` / `result.totalStake` |
| Three-Card Showdown | `src/lib/three-card-showdown/client.ts` after fold/play result `render()` | `round.netDelta` / `round.totalWager` (not ante alone on a Play) |
| Pai Gow Poker | `src/lib/pai-gow-poker/client.ts` after `game.confirm()` and `render()` | `result.netDelta` / `result.wager` |

Keep the hooks in existing browser compositions, not game rules/domain classes or the shared wallet, so only **actual newly revealed** results celebrate. Calling before asynchronous account settlement is fine because local outcome is already final; never fire a second time on wallet retry.

## Testing and evidence policy

Linear has **no UI mockup**. The implementation PR therefore requires **browser-MCP desktop and phone screenshots**, visually compared with Arcturus's current Art Deco styling, plus DOM measurements for ribbon fit. Browser MCP can invoke the exported celebration function from the **running real casino page** with known win/stake values; that tests the browser/rendering layer without rigging game RNG or introducing a permanent test-only route. The existing game clients still need unit/integration tests that ensure their result seams pass correct net/stake exactly once.

- Unit/happy-dom: tier inclusivity (5×/20×, 20BB/50BB), invalid/loss/push checks, Blackjack aggregate and Craps resolved stake, mutually exclusive active overlay, WAAPI cleanup, reduced motion, mute and two-button synchronization, localized labels and suppressed duplicated poker cues.
- Browser MCP E2E: real casual game page (guest sufficient) at **1280×800 and 375×812**; deterministic big/huge API calls, particle/ribbon count and cleanup, no click blocking, four locale ribbon text, accessible toggles, reduced motion and mute behavior. Capture screenshots and measured bounds; one browser/platform is sufficient. If one natural game win is reproducible, verify wiring as well; never change production RNG or rely on a lucky outcome.
- Validate `bun run test`, `bun run lint`, `bun run format:check`, `bun run build` and `bunx astro check` on the eventual **code** diff. Record actual results, don't label a skipped draft-PR CI job as passed.

No new backend logic is proposed, so no new backend E2E or database migration is needed. No human sign-off is an automated acceptance criterion.
