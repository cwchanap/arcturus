# HPA-729 — All-game big-win celebration: design specification

**Linear:** https://linear.app/cwchanap/issue/HPA-729/all-games-big-win-celebration  
**Plan:** [2026-11-17-big-win-celebration.md](../plans/2026-11-17-big-win-celebration.md)  
**Assets:** [HPA-728 / merged PR #89](https://github.com/cwchanap/arcturus/pull/89)  
**Delivery:** one PR for this ticket; this draft initially contains planning documents only. Add implementation and tests to the same PR.

## Goal and boundaries

A lightweight, shared Art Deco payoff for **net-positive** results in the eleven casual `GAME_TYPES` games, including guest play, authenticated casual play, cash Poker and solo Sit & Go. Reuse the seven existing HPA-728 files. No new artwork/SFX, runtime dependency, backend route, database/schema change, new game-event bus, generalized animation engine, or old sound-setting migration.

Exclude Ranked Blackjack, Daily Challenge, and private-room multiplayer Poker. Effects are cosmetic; wallet results, odds, missions, achievements, game state and existing result messages are not modified.

## Minimal API and one threshold source

Keep rendering free of game rules, with a pure classifier and two browser entrypoints:

```ts
// src/lib/celebration/tier.ts
export const WIN_TIER_MULTIPLES = {
  stake: { big: 5, huge: 20 },
  bigBlind: { big: 20, huge: 50 },
} as const;
export type WinTier = 'big' | 'huge';
export function winTier(
  measure: number,
  unit: number,
  multiples = WIN_TIER_MULTIPLES.stake,
): WinTier | null;

// src/lib/celebration/index.ts
export function celebrateWin({ win, stake }: { win: number; stake: number }): void;
export function showCelebration(tier: WinTier, amount: number): void;
```

- `winTier` rejects nonfinite/zero/negative measure or unit. Compare inclusively: **huge first** at 20× (or 50 BB), then big at 5× (or 20 BB). No return below threshold.
- `celebrateWin` computes `winTier(netWin, roundStake)`, then calls `showCelebration`. `win` means net chips gained, **not** gross payout or total award. A profitable sub-bet cannot trigger the effect when the whole round loses.
- `showCelebration` accepts a resolved tier and positive finite net amount, rejecting invalid amounts. Poker uses `winTier(handNetDelta, handBigBlind, WIN_TIER_MULTIPLES.bigBlind)` and `showCelebration(tier, handNetDelta)`. The net delta already excludes returned uncalled bets and repaid own stakes, so a barely profitable share of a huge pot cannot inflate the tier. This keeps both threshold sets in one constants block, without a dummy Poker stake or a Poker-only optional override.
- **No `anchor` argument for this first implementation.** All existing callers use the viewport center; keep the ticket's permitted center fallback, and add anchoring only when a concrete UX need appears.
- Fire once from an **existing newly visible result/reveal seam**. Do not fire from wallet reconciliation, retry, rerender, restored/hydrated round state, or a generic balance-update event.

## Rendering, localization and accessibility

Re-use:

- `public/images/fx/chip-gold.webp`, `chip-red.webp`, `chip-blue.webp`, `sparkle.webp` (128×128 transparent WebPs);
- `public/images/fx/big-win-ribbon.webp` (960×320 transparent WebP; measured native text-safe rectangle approximately **x=165, y=64, width=630, height=192**);
- `public/audio/fx/coin-shower.mp3` (~1.48s), `big-win-sting.mp3` (~2s).

Create **one** browser overlay lazily with `document.body.append(...)`, not Astro layout markup. It is fixed over the game, uses `pointer-events: none`, and is `aria-hidden="true"` because every game already announces the result. Avoid duplicate live regions or focusable elements. A new win cancels/replaces the old animation; after roughly 1.6s remove child nodes, timers and active Web Animations API handles. Navigation is ordinary full-page navigation, so no special client-router cleanup is required.

**Big:** burst 30–40 gold/red/blue chip images from screen center with WAAPI drift, gravity, rotation, scaleX flip, opacity fade and a few sparkle images. **Huge:** the same burst plus the shipped ribbon and HTML (not image-baked) localized `Big Win` title and animated **net** chip count. Use `getDocumentLocale()`, `defineMessages` and `formatChips`, all already in the repository. Position the two lines inside the measured safe band at desktop and phone widths.

**Reduced motion:** no moving particles or count-up. Show a static localized net amount for big, or static ribbon/title/amount for huge; still time out and clean up. The overlay must never capture pointer/keyboard events, block controls or hide the game's ordinary result.

## One site-wide sound preference

Create `src/lib/sound-preference.ts` as the **single owner** of `casino_sound_muted` with `isSoundMuted()`, `setSoundMuted(boolean)` and `bindSoundToggle(button)` (or equally small functions). Default is unmuted; keep one in-memory state for unavailable storage, read/write localStorage when permitted, and publish a same-page change event so all bound controls re-render `aria-pressed` and a localized accessible label. No legacy `poker_sound_muted` import/migration.

- Put a small `SoundToggle.astro` next to `LanguagePicker` **directly in `src/layouts/AppLayout.astro`**. The existing common header already covers the casino pages: do not add a header slot/prop or duplicate shell. The keyboard-operable button and Poker's existing `#btn-sound` both use the same binding helper. Support `onToggle?: (muted: boolean) => void` in that binder: on unmute Poker calls `this.sound.unlock()` and plays the existing `'check'` confirmation cue within the **same click listener**. No duplicate handler. One state owner replaces bespoke two-way synchronization paths.
- Update `src/lib/poker/sound.ts`: `PokerSound.play`, `unlock` and `isMuted` read the shared preference at call time, rather than caching mute at singleton construction. Keep deterministic test injection via `isMuted?: () => boolean` instead of the old test-only storage injection if simpler; update existing tests and the stale “no audio files ship” comment. The `PokerGame.test.ts` DOM fixture currently lacks `setAttribute` and `removeEventListener`, and stores only one handler per event: update that fixture for the new binder, not production behavior.
- Celebration audio creates/reuses plain `HTMLAudioElement` for the existing MP3 files on first use, respects the shared mute and safely handles denied playback. On consecutive celebrations pause the previous cached clip and reset `currentTime = 0` to replay from the start; handle both synchronous errors and `play()` implementations returning `undefined` using a `try/catch` around `Promise.resolve(audio.play()).catch(() => {})`. Big plays coin shower; huge plays both. Do not boost the already leveled asset gains.
- At Poker results, **if a celebration fires, do not also synthesize the old `bigWin`**. Preserve the existing `win` and high-ranked-hand `bigWin` fallback for wins below the new threshold, as well as all action SFX.
- Slots' `#setting-sound` checkbox is **nonfunctional today** (it persists `soundEnabled`, but nothing reads it). Remove that checkbox, its client event/render wiring, and unused Slots `soundEnabled` setting/type/default/sanitizer rather than displaying a second misleading mute. Update `src/lib/slots/GameSettingsManager.test.ts` (obsolete `updateSettings({ soundEnabled: false })`) and `SlotsUIRenderer.test.ts` (literal `SlotSettings.soundEnabled`) and delete the now-unused four-locale Slots `sound` message key. No legacy-data migration. Leave Baccarat/Craps settings untouched.

## Verified game integration seams

| Game | Existing newly-visible result point | Net win / stake |
| --- | --- | --- |
| Blackjack | `blackjack/blackjackClient.ts:handleRoundComplete`, after outcomes and result label | New `blackjackRoundNet(outcomes, playerHands)` next to existing settlement builder: sum `payout - hand.bet` and final `hand.bet` across split/double hands once; use the pre-settlement snapshot (guest and authenticated) |
| Baccarat | `pages/games/baccarat.astro` after `animateRound` and `showResult` | Existing `roundNetDelta`; `sum(outcome.betResults[].bet.amount)` |
| Craps | `pages/games/craps.astro` after `showRollResult` | `result.netDelta`; use `resolvedCrapsStake(result)` beside existing settlement logic: sum `evaluation.bet.amount + (evaluation.bet.odds ?? 0)` over `resolvedEvaluations(result)` (win/lose/push only, not continuing bets) |
| Poker (cash and solo Sit & Go) | `poker/PokerGame.ts:presentHandResult` | `delta > 0`; compare net `delta` to 20/50 `handBigBlind` via `winTier`; render with `showCelebration(tier, delta)` |
| Slots | `slots/slotsClient.ts` in `reveal()` after `renderer.renderResult` | `result.netDelta` / `result.bet` |
| Roulette | `roulette/rouletteClient.ts:animateAndScheduleReveal` inside guarded `reveal()` | `spinResult.netDelta` / `spinResult.totalBet`; never early or on hydration |
| Keno | `keno/kenoClient.ts:commitDraw` after `renderer.renderLastResult` | `result.netDelta` / `result.bet` |
| Video Poker | `video-poker/client.ts` after `game.draw` and `render` | `round.netDelta` / `round.wager` |
| Sic Bo | `sic-bo/client.ts` after `game.roll` and `render` | `result.netDelta` / `result.totalStake` |
| Three-Card Showdown | `three-card-showdown/client.ts` after fold/play result `render` | `round.netDelta` / `round.totalWager` (includes Play bet, not just ante) |
| Pai Gow Poker | `pai-gow-poker/client.ts` after `game.confirm` and `render` | `result.netDelta` / `result.wager` |

Existing browser composition layers own these calls. Do **not** move them to the shared wallet or game-rule classes. The two reusable measure helpers stay next to their existing rules, rather than duplicating them in Astro markup.

## Verification and acceptance

There is **no Linear UI mockup**. Use **browser MCP** for real-page end-to-end acceptance and screenshot comparison with current dark-green/gold casino visuals on one browser/platform, at **1280×800** desktop and **375×812** phone width; check big, huge and reduced-motion appearances. The browser can load the ESM module from the running Vite development server and call `import('/src/lib/celebration/index.ts')` with fixed values, requiring **no RNG rig, debug route or `window.__celebrate` global**. Also complete one ordinary guest-game round through its UI to confirm the existing result flow remains usable.

Add a **small Playwright regression spec** (`e2e/big-win-celebration.spec.ts`) using that dev-server import to assert measured HTML title/count rectangles remain within the ribbon's scaled safe band across **four locales × two viewports**, and the overlay remains click-through. This complements, **does not replace**, the browser-MCP visual/E2E acceptance required by the project.

Unit/Bun happy-dom covers `winTier` boundaries, invalid/losing inputs, Blackjack aggregated split/double measurements, Craps resolved filtering and base-plus-attached-odds stake, DOM replace/cleanup/reduced motion, restarted cached SFX and rejected/undefined playback, shared mute bindings and Poker threshold/synth behavior. Do not add custom client-closure harnesses for seven one-line hookups; make the reveal-site placement explicit and use existing test coverage where available.

Before turning this documentation-only draft into an implementation-ready PR, record actual passing `bun run test`, `bun run lint`, `bun run format:check`, `bunx astro check`, `bun run build`, Playwright regression results and **browser-MCP acceptance screenshots/measured evidence**. No backend behavior changed, so backend E2E is not applicable. No human sign-off counts as automated acceptance.
