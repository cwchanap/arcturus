# HPA-727 — Poker-specific daily and weekly missions: implementation plan

**Linear:** https://linear.app/cwchanap/issue/HPA-727/missions-poker-specific-daily-and-weekly-missions  
**Design:** [2026-11-15-poker-missions-design.md](../specs/2026-11-15-poker-missions-design.md)  
**PR contract:** Exactly **one PR** for HPA-727. This draft PR contains spec and plan first; implementation, tests, and any corrections go into **this same branch/PR** after review. Do not open a follow-up implementation PR. No separate art/SFX task is required.

## Current-state check (main, 2026-11-15)

- `src/lib/missions/types.ts` has seven closed mission IDs and four metric variants.
- `src/lib/missions/registry.ts` has three default dailies, three reroll-only dailies, and one default weekly.
- `src/lib/missions/progress.ts` calculates increments; existing D1 wallet receipt-gating/claim and period-reset logic must stay unchanged.
- `src/lib/wallet/repository.ts` builds `MissionGameEvent` from `SettleRoundCommand` using true net profit; `PokerGame.buildPokerSettlementCommand` sends a single cash hand per command with `stats.rounds = 1` and net `delta`.
- `src/lib/poker/tableMissions.ts` filters metrics, refreshes when `POKER_HAND_SETTLED_EVENT` fires, and claims through the shared API. Its DOM tests use happy-dom.
- `src/pages/missions/index.astro` renders daily/weekly arrays dynamically: no hardcoded three-card layout or API response limit. `src/styles/poker.css` scales rings to 42px on phone.
- `src/lib/i18n/messages/missions.ts` has typed four-language titles and descriptions; `getMissionTitle` and `getMissionDescription` already supply rings and board cards.
- Latest open GitHub PR is Dependabot #87, unrelated to this scope; no open HPA-727 PR or HPA-727 branch was found when the plan began.

## Change map

| File | Intended edit |
| --- | --- |
| `src/lib/missions/types.ts` | Four new `MISSION_IDS`; one `bigWin` metric union arm. |
| `src/lib/missions/registry.ts` | Fourth default daily, two reroll-pool dailies, second weekly at exact targets/rewards. |
| `src/lib/missions/progress.ts` | One pure `bigWin` branch in `computeIncrement`, game-type filter + inclusive net-delta threshold. |
| `src/lib/poker/tableMissions.ts` | Let `selectPokerMissions` include matching `bigWin` definitions. |
| `src/lib/i18n/messages/missions.ts` | Four title/description entries in each of four locales, and all four canonical Poker mappings. |
| `src/lib/missions/registry.test.ts` | Updated daily/weekly sizes and explicit registry shape/pool checks. |
| `src/lib/missions/progress.test.ts` | `bigWin` threshold, wrong game, multiple qualifying events, and target semantics. |
| `src/lib/missions/progress-integration.test.ts` | D1 persistence/cap/period behavior for an active qualifying reroll. |
| `src/lib/missions/board-integration.test.ts` | Four default dailies, two weekly, selected poker IDs, and reroll replacement view. |
| `src/lib/poker/tableMissions.test.ts` | Default four, possible five, non-poker big-win rejection, accessible in-table claim. |
| `src/lib/i18n/messages/missions.test.ts` | Four-locale title/description and canonical Poker game-name substitution. |
| `e2e/missions.spec.ts` | Signed-in four-daily/two-weekly SSR + refresh and reroll smoke. |
| `e2e/poker-turn-flow.spec.ts` | Extend ring smoke and a completed cash-hand test, without rigging RNG. |
| `src/styles/poker.css` (conditional) | **Only** correct an observed five-ring overflow/overlap on phone; do not redesign rings. |

`src/pages/missions/index.astro` and `src/pages/games/poker.astro` should need **no production edits**. No D1 migrations, endpoint changes, new service, new persistence, new media, or extra dependency.

## Task 1 — Registry and typed definition extensions

**Files:** `types.ts`, `registry.ts`, `registry.test.ts`.

- [ ] Add these four IDs to the closed tuple: `daily-poker-10`, `daily-poker-wins-3`, `daily-poker-big-pot`, `weekly-poker-wins-15`.
- [ ] Add `{ kind: 'bigWin'; minDelta: number; gameType?: string }` to `MissionMetric`.
- [ ] Add `daily-poker-10` as the fourth default daily (`handsPlayed`/`poker`, target 10, reward 500, ♠️).
- [ ] Add `daily-poker-wins-3` (`roundsWon`/`poker`, target 3, reward 600, ♥️) and `daily-poker-big-pot` (`bigWin`/`poker`, `minDelta: 500`, target 1, reward 800, ♦️) **only** to `REROLL_POOL_DAILY`.
- [ ] Add `weekly-poker-wins-15` (`roundsWon`/`poker`, target 15, reward 2500, ♣️) to `DEFAULT_WEEKLY_MISSIONS`.
- [ ] Update the brittle registry tests expecting 3 default daily and 1 weekly to **4/2**, assert exact ID/period/metric/target/reward positions, and preserve no-duplicate/full-ID coverage. Existing reroll mechanics should discover the expanded pool and fourth slot automatically.

**Acceptance:** registry tests establish the four precise definitions and show all IDs resolve once; no new registry abstraction.

## Task 2 — One new event metric, reuse atomic wallet path

**Files:** `progress.ts`, `progress.test.ts`, `progress-integration.test.ts`; optionally extend an existing wallet-settlement integration assertion if the coverage gap remains.

- [ ] Add a `computeIncrement` switch case:

```ts
case 'bigWin':
  if (metric.gameType && event.gameType !== metric.gameType) return { amount: 0 };
  return { amount: event.delta >= metric.minDelta ? 1 : 0 };
```

- [ ] Test poker net +499 → 0; +500 → 1; +750 → 1 (not 750); −500 → 0; non-poker +1000 → 0; unscoped `bigWin` accepts any game. Preserve `prepareMissionProgressStatements`' existing no-outcome short circuit.
- [ ] Test repeated distinct qualifying hands increment target-1 progress to **1** and then clamp, while repeated wallet receipt submissions are ignored by the existing settlement gate. Use the existing D1 test harness rather than a new mocking framework.
- [ ] Check daily/weekly period keys, new target values, and regular claim behavior through existing functions. **Do not** modify `PokerGame`, `wallet/repository.ts`, `prepareMissionProgressStatements`, or database tables: the current one-hand cash settlement contains all required information.

**Acceptance:** only eligible *net* poker cash settlements advance the big-pot mission, exactly once per committed settlement, without changing existing metrics.

## Task 3 — Localized cards and the poker ring filter

**Files:** `tableMissions.ts`, `tableMissions.test.ts`, `messages/missions.ts`, `messages/missions.test.ts`; `poker.css` only if necessary.

- [ ] In `selectPokerMissions`, add `case 'bigWin'` to the same branch as `handsPlayed`/`roundsWon`, including the existing optional game-type guard. Do not filter by hardcoded ID strings.
- [ ] Keep the default ring order daily then weekly: `daily-win-3`, `daily-poker-10`, `weekly-games-3`, `weekly-poker-wins-15`. Test a reroll that yields a fifth ring and one that does not; also verify a non-poker big-win definition is filtered out.
- [ ] Extend the title/description catalogs in `en`, `zh-Hant`, `zh-Hans`, `ja`. Add `'poker'` mappings to `MISSION_GAME_KEYS` for each ID, including the big-pot mission; use canonical game name substitution and the existing count formatter. The big-pot description says at least **500 net chips**, not a 500-chip pot or cumulative winnings.
- [ ] Test localized outputs, mission token ARIA labels and claim via shared API, and the existing completion pop/claimed state with a new ID.
- [ ] Validate the board's existing responsive grid handles four cards and the table's ring flex row handles five; if a real overflow is detected at 320/390px, adjust only the existing ring container spacing/wrapping in `poker.css`. Do not add a carousel, overlay, separate poker board, or new component.

**Acceptance:** all new goals appear in the intended board sections, matching poker rings are selectable/claimable, and none of the four locales produces a missing key.

## Task 4 — End-to-end checks, visual checks, and review

**Files:** existing `e2e/missions.spec.ts` / `e2e/poker-turn-flow.spec.ts`, only necessary test fixture helpers.

- [ ] Sign in to cash poker, assert four default poker-relevant rings and their localized accessible names, deal/fold a hand using existing fast-AI smoke helpers, wait for the wallet settlement, and assert `daily-poker-10` advances on the board/table regardless of the losing result. Keep the test deterministic with respect to *hand completion*, not win RNG; do not add a rigged-RNG endpoint.
- [ ] Assert SSR and client-refreshed Missions boards show four daily/two weekly cards, claims work, and a single reroll substitutes (rather than appends) a default daily card.
- [ ] For states that would require lucky poker outcomes (big pot, three/15 wins), use the D1 integration suite; avoid flaky browser loops waiting for random wins.
- [ ] Add deterministic presentation fixture snapshots: 390px iOS-like Safari viewport / 1280px desktop, normal 4-ring board and a stubbed 5-ring response; compare screenshots to the design's layout reference and existing Art Deco visuals. Assert ring rectangles do not overlap controls/cards or extend beyond the viewport. No mockup was attached to the Linear issue.
- [ ] Run `bun run test:unit`, `bun run test:integration`, `bun run lint`, `bun run format:check`, `bun run build`, and the relevant `bun run test:e2e` targets. Record the actual commands and outputs in this same PR; docs-only draft itself does not assert passing tests.
- [ ] Finish browser end-to-end acceptance on **iOS Safari**, **macOS Safari**, and **Windows Chrome** (or their relevant Playwright browser targets) for board, table rings, reroll, and claim. Leave Android/Linux out of acceptance; rely on CI for them where applicable. Visual validation is screenshot/automated-layout based, **not** human sign-off.

**Acceptance:** tests prove the feature from a signed-in cash hand through D1 mission progress to the visible claimable board/rings on supported user platforms; all checks and visual comparisons are recorded on the same PR.

## Review guardrails

- **YAGNI / KISS:** a single new metric switch arm and four registry records are enough. No generic “event rules engine,” config DSL, new wallet contract, or mission-specific database migration.
- **No backward-compatibility work:** no deployed clients require a versioned migration for this additive registry feature. Existing mission rows continue naturally; old plays are not backfilled.
- **No art/SFX:** use the site's current emoji-and-ring presentation. New art/sounds would need a separate ticket, but are not needed here.
- **One ticket, one PR:** follow reviewer feedback by editing these documents and later implementation on this same PR only. Keep the Linear issue linked and do not mark it done at the planning stage.
