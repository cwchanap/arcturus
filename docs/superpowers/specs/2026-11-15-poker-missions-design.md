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
6. `src/lib/poker/tableMissions.ts` filters missions that a poker hand may advance and refreshes/claims rings on `POKER_HAND_SETTLED_EVENT`. `src/pages/games/poker.astro` mounts the rings for signed-in cash poker only. `src/pages/missions/index.astro` renders the daily cards from an array in a responsive two-column grid; its refresh path also maps the full returned arrays. `src/styles/poker.css` uses 54px desktop / 42px phone rings, moved into their own centered row below 1100px.
7. `src/lib/i18n/messages/missions.ts` has typed titles/descriptions and canonical `MISSION_GAME_KEYS` in `en`, `zh-Hant`, `zh-Hans`, and `ja`.

## Smallest implementation

### Extend typed mission definitions

Add exactly four identifiers to `MISSION_IDS` and four definitions in the existing registry arrays. Reuse `handsPlayed` and `roundsWon` for three of the goals. Add only this one new metric to `MissionMetric`:

```ts
| { kind: 'bigWin'; minDelta: number; gameType?: string }
```

In `computeIncrement`, a matching `bigWin` returns `{ amount: 1 }` **when** `event.delta >= metric.minDelta` and the optional `gameType` matches; otherwise return `{ amount: 0 }`. Use **net delta**, not pot size, gross payout, accumulated session winnings or `biggestWin`. Exactly **500** qualifies, 499 does not. Each qualifying completed cash hand contributes one unit; large hands never contribute multiple units. Keep the existing outcome-presence guard and receipt-gated D1 writes. A successful cash-poker event with +500 net is already classified as a win; do not introduce a redundant win-state protocol.

The four goals remain normal registry definitions, including the two in the reroll pool. They inherit today's daily/weekly UTC periods, progress clamping, reroll persistence, and idempotent claims.

### Poker-table ring selection

Add `bigWin` to `selectPokerMissions`, with the same game-type guard used for `handsPlayed` / `roundsWon`. It must accept both an unscoped big-win metric and one scoped to `poker`, but reject another game's big-win mission. No special-case mission IDs or `poker`-specific progress state.

Ordinary default cash board: `daily-win-3`, `daily-poker-10`, `weekly-games-3`, `weekly-poker-wins-15` — **4 rings** in existing daily-then-weekly order. Rerolling a non-poker default card into one of the poker pool missions can yield **5 rings**. Existing pop/claim/balance-owed behavior stays untouched. Check five rings at 320–390px and desktop widths; change only the minimal existing CSS if actual overflow or overlap is reproduced.

### Localized display

Add all four mission IDs to both `MISSION_TITLES` and `MISSION_DESCRIPTIONS` in all four existing locales. Add `'poker'` to `MISSION_GAME_KEYS` for every new ID so the canonical translated game name is substituted via `{game}`; reuse the existing `{count}` token for 10/3/15 and 1 for the one-time goal. The big-pot description explicitly states **500 net chips** in localized text. This is a fixed feature threshold; do not change the public description-helper signature solely for one mission.

Example English copy (translation equivalents required):
- `daily-poker-10`: “Poker Hands” — “Play 10 Poker hands”
- `daily-poker-wins-3`: “Poker Winner” — “Win 3 Poker hands”
- `daily-poker-big-pot`: “Big Pot” — “Win 1 Poker hand with at least 500 net chips”
- `weekly-poker-wins-15`: “Poker Regular” — “Win 15 Poker hands”

Do not duplicate the game-name translation in the literal copy. Preserve localized accessible ring labels built by `tableMissions.ts`.

## UI reference and visual constraints

The Linear ticket has **no attached UI mockup**. The following is a structural reference to verify against the existing Art Deco styling, not a new visual system:

```text
MISSIONS                         DAILY QUESTS
┌─────────────────────┐ ┌─────────────────────┐
│ Existing Blackjack  │ │ Existing Three Wins │
└─────────────────────┘ └─────────────────────┘
┌─────────────────────┐ ┌─────────────────────┐
│ Existing Slots      │ │ ♠️ Poker Hands 0/10 │
└─────────────────────┘ └─────────────────────┘
WEEKLY GOAL
┌─────────────────────────────────────────────┐
│ Existing Variety Seeker                     │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ ♣️ Poker Regular 0/15                       │
└─────────────────────────────────────────────┘

CASH TABLE / PLAYER SEAT (default)
[🏆 0/3] [♠️ 0/10] [📅 0/3] [♣️ 0/15]
A reroll may add a fifth poker-relevant ring.
```

The real daily grid stacks on narrow phones, while the weekly items follow existing full-width cards. On a narrow cash table the rings sit in a centered row, do not cover the player's controls/cards, and still provide focusable claim buttons with an accessible localized label. No new images, audio, custom effects, or icon library.

## Explicit scope boundary

**In scope:** four ID/registry entries, `bigWin` progress calculation, ring filtering, four-locale messages, narrowly necessary layout adjustments, and unit/integration/browser regression tests.

**Out of scope:** Sit & Go, private-room poker, guest missions, poker rules/AI, rank/reward economics beyond the specified amounts, wallet changes, new D1 migrations, new API endpoints, retrospective attribution of old hands, a configurable threshold framework, new art or SFX.

## Acceptance criteria (end-to-end; implementation PR)

- [ ] **macOS Safari and Windows Chrome, signed-in cash play:** the SSR and refreshed board show four daily and two weekly cards with the expected rewards, localized descriptions, progress, and existing one-reroll behavior. Poker hands increase `daily-poker-10` even on a loss; winning hands increase both poker-win missions. Sit & Go/guest play does not change wallet-backed mission progress.
- [ ] **Cash-hand settlement:** +499 net poker chips do not move `daily-poker-big-pot`, +500 or more moves it by exactly 1, a non-poker settlement does not move it, and repeat receipt submissions do not advance it twice. Targets cap properly, UTC reset works, and both board and table can claim the normal reward exactly once.
- [ ] **iOS Safari phone width and desktop layouts:** four default poker rings and a possible five-ring reroll state remain visible and usable, never overlap cards/actions, and respect keyboard/touch accessibility. All four locales have nonempty title/description and accessible labels.
- [ ] **Automated visual check:** save deterministic screenshots for 4-daily/2-weekly boards and 4-/5-ring cash-table states at 390px phone and 1280px desktop; compare against this layout reference and existing Art Deco baseline, since no Linear mockup exists. Use automated screenshot/overflow assertions, not a human-approval gate.
- [ ] Unit, D1 integration, i18n, lint, formatting and relevant Playwright tests pass in CI. No Android/Linux acceptance target is added; CI alone covers those platforms where applicable.

No implementation or runtime tests are part of this docs-only first draft.
