# HPA-727 — Poker-specific daily and weekly missions: design

**Linear:** https://linear.app/cwchanap/issue/HPA-727/missions-poker-specific-daily-and-weekly-missions  
**Implementation plan:** [2026-11-15-poker-missions.md](../plans/2026-11-15-poker-missions.md)  
**Delivery:** Exactly **one PR** for HPA-727. This draft starts with the design and plan; add code and tests to the **same PR** after review. No separate implementation PR or asset task is needed.

## Goal and player-visible behavior

Give signed-in players poker-specific progression in the existing Missions board and the small claimable rings next to their seat at the **cash** poker table. Preserve generic missions, the one-daily-reroll rule, wallet-backed rewards, and the four locales. Do not add a poker-specific mission service, settlement endpoint, schema, or new UI framework.

| Mission ID | Period / placement | Metric | Target | Reward | Emoji |
| --- | --- | --- | ---: | ---: | --- |
| `daily-poker-10` | Default daily (fourth card) | `handsPlayed`, `gameType: 'poker'` | 10 hands | 500 chips | ♠️ |
| `daily-poker-wins-3` | Daily reroll pool | `roundsWon`, `gameType: 'poker'` | 3 winning hands | 600 chips | ♥️ |
| `daily-poker-big-pot` | Daily reroll pool | `bigWin`, `minDelta: 500`, `gameType: 'poker'` | 1 qualifying hand | 800 chips | ♦️ |
| `weekly-poker-wins-15` | Default weekly (second card) | `roundsWon`, `gameType: 'poker'` | 15 winning hands | 2,500 chips | ♣️ |

Existing daily default missions remain; the daily board grows from **3 to 4** items and weekly from **1 to 2**. Reroll-only missions do not appear unless selected by the existing reroll mechanism. Weekly missions cannot be rerolled.

## Verified main-branch integration points (2026-11-15)

1. `src/lib/missions/types.ts` holds the closed `MISSION_IDS` tuple, `MissionMetric` discriminated union, and `MissionGameEvent` with `gameType`, `outcome`, `handCount`, `winsIncrement` and `delta`.
2. `src/lib/missions/registry.ts` owns `DEFAULT_DAILY_MISSIONS` (currently three), `REROLL_POOL_DAILY`, `DEFAULT_WEEKLY_MISSIONS` (currently one), and the unified lookup helpers.
3. `src/lib/missions/progress.ts`'s `computeIncrement` computes per-event increments; `prepareMissionProgressStatements` reads active, post-reroll definitions and builds **receipt-gated** D1 upserts. The caller filters events with no outcome. It already clamps progress and prevents duplicate wallet receipts from incrementing twice.
4. `src/lib/poker/PokerGame.ts`'s `buildPokerSettlementCommand` emits one `game: 'poker'` command per completed authenticated cash hand with `stats.rounds: 1`, win/loss counts, and the **net** hand delta. Guest and Sit & Go are handled locally. `src/lib/wallet/repository.ts` converts that command into a mission event: `delta = command.stats.netProfit ?? command.delta`. For cash poker this is the hand's net chip change; no new event payload is needed.
5. `src/lib/missions/board.ts` dynamically derives daily and weekly views from the registries. `src/lib/missions/reroll.ts` uses the default ID set; it will automatically recognize the fourth default slot. The existing `/api/missions/board` and `/api/missions/claim` contracts need no changes.
6. `src/lib/poker/tableMissions.ts` filters missions that a poker hand may advance and refreshes/claims rings on `POKER_HAND_SETTLED_EVENT`. `src/pages/games/poker.astro` mounts the rings for signed-in cash poker only. `src/pages/missions/index.astro` renders the daily cards from an array in a responsive two-column grid; its refresh path also maps the full returned arrays. `src/styles/poker.css` currently moves 54px desktop / 42px phone rings into a centered row only below 1100px; four or five rings collide with the bankroll in the 1101–~1260px intermediate desktop range. The weekly section in `src/pages/missions/index.astro` currently lacks a gap between cards.
7. `src/lib/i18n/messages/missions.ts` has typed titles/descriptions and canonical `MISSION_GAME_KEYS` in `en`, `zh-Hant`, `zh-Hans`, and `ja`.

## Smallest implementation

### Extend the existing domain and localized catalog as one type-checkable change

Add four IDs and registry definitions, plus the localized titles/descriptions in all four locales. The new `daily-poker-big-pot` registry row needs the new `bigWin` metric, so its union arm and `computeIncrement` handler must land in **the same implementation step** as the registry row; deferring that union arm would leave the tree failing `astro check`. The closed ID tuple likewise requires the copy catalog to change together.

Import the existing `GameType` from `../game-stats/types`, and type each optional definition-side `MissionMetric.gameType?: GameType` (including the new arm), not `string`. Keep the incoming `MissionGameEvent` shape unchanged. Add only:

```ts
| { kind: 'bigWin'; minDelta: number; gameType?: GameType }
```

In `computeIncrement`, a matching `bigWin` returns `{ amount: 1 }` when `event.delta >= metric.minDelta` and the optional `gameType` matches; otherwise return `{ amount: 0 }`. Use the **net delta** already supplied by the wallet event, not pot size, gross payout, cumulative winnings, or `biggestWin`. Exactly **500** qualifies; 499 does not. Each qualifying completed cash hand counts once. Keep the existing outcome-presence guard and receipt-gated D1 writes.

All four goals inherit existing UTC periods, clamping, rerolls, wallet receipt idempotency, and claims. Do not build new settlement logic or repeat comprehensive tests for those shared behaviors.

### Poker-table ring selection

Add `bigWin` to `selectPokerMissions` with the same optional game-type guard as `handsPlayed` / `roundsWon`, rejecting other-game metrics and accepting unscoped ones. Keep `gamesTried` and explicitly return false for `spinsCompleted`. Make the predicate explicitly return `boolean`, guard missing definitions before switching, and enumerate all known metric kinds **without a default branch** so adding an unhandled kind causes a type-check error. Removing `default` alone, without an explicit return type and missing-definition guard, does not guarantee exhaustiveness.

Default signed-in cash board: `daily-win-3`, `daily-poker-10`, `weekly-games-3`, `weekly-poker-wins-15` — **four rings**, daily first. Rerolling a non-poker default into a poker-only mission can yield **five**. Existing completion pop, claim, and the mid-hand balance-adoption guard stay untouched.

**Required layout fix:** move the existing ring row into its centered, non-overlapping seat row at widths `<= 1280px` (raise the current 1100px CSS breakpoint to 1280px). The 54px desktop rings plus 12px gaps occupy **252px for four** or **318px for five**; free space at 1101px is insufficient, while the existing narrow layout fits five 42px rings on a 320px viewport. Verify geometry at **1101px** and **1281px**, not just a wide desktop and a phone.

### Localized display

Add all four mission IDs to both `MISSION_TITLES` and `MISSION_DESCRIPTIONS` in all four existing locales. Add `'poker'` to `MISSION_GAME_KEYS` for every new ID so the canonical translated game name is substituted via `{game}`; reuse the existing `{count}` token for 10/3/15 and 1 for the one-time goal. The big-pot description explicitly states **500 net chips** in localized text. This is a fixed feature threshold; do not change the public description-helper signature solely for one mission.

Example English copy (translation equivalents required):
- `daily-poker-10`: “Poker Hands” — “Play 10 Poker hands”
- `daily-poker-wins-3`: “Poker Winner” — “Win 3 Poker hands”
- `daily-poker-big-pot`: “Big Pot” — “Win 1 Poker hand with at least 500 net chips”
- `weekly-poker-wins-15`: “Poker Regular” — “Win 15 Poker hands”

Do not duplicate the game-name translation in the literal copy. Preserve localized accessible ring labels built by `tableMissions.ts`. The weekly heading must change from English “Weekly Goal” to **“Weekly Goals”**; the Chinese/Japanese headings need no plural changes. Add `class="grid gap-4"` to `#weekly-section` so both server-rendered and subsequently refreshed weekly cards have spacing.

## UI reference and visual constraints

The Linear ticket has **no attached UI mockup**. Preserve the current Art Deco card and ring visuals; this sketch communicates **content and order only**, not a pixel baseline:

```text
DAILY QUESTS
[Blackjack]      [Three Wins]
[Slots]          [♠️ Poker Hands 0/10]

WEEKLY GOALS
[Variety Seeker]
[♣️ Poker Regular 0/15]  (separated by existing-style gap)

CASH POKER / PLAYER SEAT
[🏆 0/3] [♠️ 0/10] [📅 0/3] [♣️ 0/15]
Reroll of a non-poker daily into a poker goal: add a fifth ring.
```

Add a `grid gap-4` weekly wrapper so the second full-width card does not touch the first. Keep the existing two-column daily grid, switching to stacked cards on phones. On the cash table, five rings must fit without overlap at the **1101px centered-layout transition** and the **1281px absolute-layout boundary**, and remain usable at 320px phone width. Verify element bounding boxes and focus/claim behavior, not screenshot baselines compared against this sketch. No extra assets, audio, redesign, or permanent new Playwright projects.

## Explicit scope boundary

**In scope:** four ID/registry entries, `GameType`-typed metric definitions, `bigWin` progress calculation, exhaustive ring filtering, four-locale messages, the 1280px ring breakpoint, weekly-card gap and English plural heading, and focused unit/integration/browser regression tests.

**Out of scope:** Sit & Go, private-room poker, guest missions, poker rules/AI, rank/reward economics beyond the specified amounts, wallet changes, new D1 migrations, new API endpoints, retrospective attribution of old hands, a configurable threshold framework, new art or SFX.

## Acceptance criteria (end-to-end; implementation PR)

- [ ] **Signed-in cash poker → board and rings:** on iOS Safari, macOS Safari, and Windows Chrome targets, four daily and two weekly cards appear, poker rings refresh after a completed hand (including a losing hand raising `daily-poker-10` to 1/10), and normal claim/reroll flows work. Use targeted browser end-to-end smoke, not a permanent three-browser CI matrix or a human-approval gate; record when WebKit/device emulation rather than native iOS Safari was used.
- [ ] **New metric only:** unit tests prove +499 → 0, +500 → 1, +750 → 1, negative → 0, and wrong-game → 0. A Miniflare test seeds a daily reroll override to `daily-poker-big-pot`, applies a qualifying +500 poker event, and reads progress 1. Existing generic idempotency/clamping/period/claim tests remain the coverage for shared plumbing.
- [ ] **Responsive visual correctness:** two weekly cards have a visible gap and English plural heading. Existing poker e2e stubs a five-ring `/api/missions/board` response, checks non-intersection with bankroll/cards/controls at 1101px and 1281px, and verifies the existing centered row fits at 320px. Automated DOM geometry and existing Art Deco styling are the visual check; no screenshot baseline is compared to an ASCII sketch.
- [ ] `bunx astro check` and relevant unit tests pass after **each implementation step**; final lint, format, build, focused Chromium Playwright, and D1 integration tests pass. No Android or Linux acceptance scenarios; CI covers those where applicable. No manual approval criterion.

No implementation or runtime tests are part of this docs-only first draft.
