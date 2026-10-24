# HPA-172 — Game-specific achievements: design

**Status:** Proposed; documentation-only draft for review  
**Linear:** https://linear.app/cwchanap/issue/HPA-172/achievements-game-specific-badges  
**Implementation plan:** [2026-10-23-game-specific-achievements.md](../plans/2026-10-23-game-specific-achievements.md)

## Decision

Add nine achievements through Arcturus's existing achievement rules, D1 repository, wallet result, global toast, and profile UI. There is **one PR for this ticket**: review these documents first, then implement and test on the same branch. No new progression engine, table, migration, profile redesign, art, remote event queue, or anti-cheat layer.

These are **account achievements** only. Guests can play the games but do not persist badges. All rules are evaluated server-side after authenticated play, although gameplay feats from client-authoritative games may be self-reported (acceptable for virtual chips).

## Existing contracts to reuse

- `src/lib/achievements/types.ts`: closed `ACHIEVEMENT_IDS`, definitions, and check context.
- `src/lib/achievements/achievement-rules.ts`: `ACHIEVEMENTS` and `ACHIEVEMENT_CHECKS`, including existing once-only checks.
- `src/lib/achievements/achievements.ts`: service that reads rank/statistics/earned IDs, evaluates rules, and calls `grantAchievement`.
- `src/lib/achievements/achievement-repository.ts`: idempotent `user_achievement` insert keyed by `(userId, achievementId)`; `gameType` already exists.
- `src/lib/wallet/{types,settle}.ts`: validated per-round command, persisted wallet receipt and best-effort achievement evaluation after settlement.
- `src/lib/game-stats/{constants,game-stats-repository}.ts`: the 11 `GAME_TYPES` and `getAllUserGameStats`, with per-game hands, wins, and biggest win.
- `src/lib/wallet/public-game-settlement.ts`: shared settlement controller for Video Poker, Sic Bo, Three-Card Showdown, and Pai Gow Poker. The latter two must retain unchanged behavior when the optional feat argument is omitted; Slots, Keno, and Poker have game-local command builders.
- `src/lib/i18n/messages/achievements.ts`: achievement names/descriptions in en, zh-Hant, zh-Hans, and ja. The shared `achievement-earned` event is already handled by the toast. The profile reads `ACHIEVEMENTS`.

**HPA-176 is merged and its Sit & Go runtime exists.** Its `PokerGame.settleTournamentOutcome()` already knows `finishedPlace`, but SNG intentionally has no wallet transaction, no cash-Poker stats, and no account mission event. Do not add any of those to award an SNG badge.

## Badge catalog and exact predicates

| Badge ID | Display name | Category | Trigger | Saved game type |
| --- | --- | --- | --- | --- |
| `royal_treatment` 👑 | Royal Treatment | gameplay | At a **contested cash Hold'em showdown**, the human has not folded and `readHand(hole, board)?.key === 'ROYAL_FLUSH'`; or Video Poker draw result `evaluation.category === 'royal-flush'`. A board-only royal counts at showdown, and winning the pot is not required. Walkovers and fold wins do not count, even on the river. | `poker` or `video-poker` |
| `sng_champion` 🏆 | Sit & Go Champion | gameplay | The human finishes **1st** in local six-seat SNG; signed-in client reports terminal result through the narrow endpoint below. | `poker` |
| `triple_threat` 🎲 | Triple Threat | gameplay | Sic Bo's three rolled dice are equal **and at least one placed bet is won** (`results.some(r => r.won)`), even if the round's net delta is negative. | `sic-bo` |
| `straight_up` 🎯 | Straight Up | gameplay | Roulette's **server** `evaluateBets` output has a winning `bet.type === 'straight'`. | `roulette` |
| `big_catch` 🎱 | Big Catch | gameplay | Keno result `multiplier >= 100` (gross payout / wager, not net delta). | `keno` |
| `jackpot` 🎰 | Jackpot | gameplay | Slots result has a line win with `symbol === 'seven' && count === 5`, the top current paytable tier. | `slots` |
| `grand_tour` 🧭 | Grand Tour | milestone | Every ID in `GAME_TYPES` has a `game_stats` row with `handsPlayed >= 1`. Do not count local SNG hands. | `null` |
| `specialist` 🎓 | Specialist | milestone | Any single game has `totalWins >= 100`. | Qualifying game |
| `big_score` 💰 | Big Score | milestone | Any game's `biggestWin >= 10000` (a single positive win, **not** lifetime net profit). | Qualifying game |

The account-wide milestones are **retroactive** against existing stats on the next evaluation, with no D1 backfill. **Specialist remains 100 wins in one game as HPA-172 specifies.** It is stricter than the existing Consistent Winner (100 wins across all games); a dedicated player can unlock both on the same round. This intentional overlap is not a reason to change an agreed threshold. If several games qualify for a per-game milestone, use the current settling game when it qualifies; otherwise choose the first qualifying `GAME_TYPES` entry for deterministic `gameType` attribution. `grand_tour` is global and always stores null. Every badge is earned at most once **per account**, not per game, matching the existing composite key.

## Settlement feat contract

Use **one source of truth** for wallet feat IDs and eligible games, alongside `ACHIEVEMENT_THRESHOLDS` in `src/lib/achievements/achievement-rules.ts`. Do not add a second `wallet/feats.ts` or duplicate game eligibility checks in each badge rule:

```ts
export const WALLET_FEAT_GAMES = {
  royal_treatment: ['poker', 'video-poker'],
  triple_threat: ['sic-bo'],
  straight_up: ['roulette'],
  big_catch: ['keno'],
  jackpot: ['slots'],
} as const satisfies Partial<Record<AchievementId, readonly GameType[]>>;

export type WalletFeatId = keyof typeof WALLET_FEAT_GAMES;
```

The `as const satisfies` constraint keeps `WalletFeatId` a closed union **and** rejects misspelled achievement IDs or game types. Add `feats?: readonly WalletFeatId[]` to `SettleRoundCommand`; achievement context/service options can use `feats?: readonly AchievementId[]` to permit the separate `sng_champion` event.

In `validate(unknown)`, accept omitted feats or an array of unique allowed IDs and check each ID against `WALLET_FEAT_GAMES` for `command.game`. Reject invalid arrays, duplicates, unknown IDs, or disallowed game/feat pairs with `INVALID_COMMAND` before writes. Each game currently has only one eligible wallet feat, so a separate maximum-one condition is redundant. `[]` is valid; omitted feats must not change existing command shapes. TypeScript does not replace runtime validation of client JSON.

Use one small `checkFeat(id: AchievementId)` helper to make the six feat checks (five wallet feats plus `sng_champion`). It skips already-earned IDs and checks `context.feats?.includes(id)` with `gameType: context.gameType`. The wallet validator enforces game eligibility, while the SNG-only route fixes its game to `poker`; don't duplicate that policy in the rules. Never persist feat arrays in wallet receipts or game stats.

**Single stats query:** replace the achievement service's `getAggregateUserStats` dependency with `getAllUserGameStats(db, userId)` (not alongside it). Reuse `aggregateGameStats(rows)` to compute the current aggregate fields, and pass fetched rows directly as `gameStats: readonly Pick<GameStats, 'gameType' | 'handsPlayed' | 'totalWins' | 'biggestWin'>[]`. No separate projection mapper or second D1 read; earned-ID/rank reads remain unchanged.

### SNG-only achievement event

Add one authenticated POST route `/api/achievements/sng-champion`. A signed-in player finishing first sends an **empty POST body** exactly once from `PokerGame.settleTournamentOutcome()`; the URL is the intent, with no payload to parse.

Follow the auth/DB guards and injectable `createPostHandler(deps)` test seam in `src/pages/api/wallet/settle.ts`. Require `locals.user` and D1, then call `checkAndGrantAchievements(createDb(d1), locals.user.id, locals.user.chipBalance, { gameType: 'poker', feats: ['sng_champion'] })`. The user's chip balance is a required service argument taken from authenticated middleware, not the request. Do not write wallet, `game_stats`, mission, or tournament records.

Return the full newly granted `{id, icon}` array and call Poker's existing `dispatchEarnedAchievements`. Other rank or retroactive milestone badges may unlock alongside the champion badge because the service evaluates all checks; do not assert only `sng_champion` is returned. The composite account+badge key makes repeat POSTs idempotent. Guests make no request; network failures do not block the tournament result.

**Trust policy:** a signed-in user may claim local-only first place without tournament replay proof. With virtual chips and cosmetic badges, a verification infrastructure is out of scope.

## Client integration

- Video Poker and Sic Bo: extend the existing `PublicGameSettlementController.completeRound` with an optional typed third argument; derive the feat from the resolved result and include it with the wallet command. `completeRound(delta, balance)` must still send a command with no `feats` property for all callers, including Three-Card Showdown and Pai Gow Poker.
- Cash Poker: at the contested **showdown** settlement call in `PokerGame.nextPhase()`, use `readHand` for an unfolded human and pass `royal_treatment` through `settleHand` to its command builder. Do not emit it on walkovers; the existing `playsLocally` guard excludes SNG and guests.
- Slots and Keno: extend their existing command builders to use `lineWins` and `multiplier`. Retried commands retain original feat values.
- Roulette: compute `straight_up` from the server route's evaluated `BetResult`. `spin.ts` already ignores unknown request fields, so add no special rejection. The general `/api/wallet/settle` path already trusts client-reported virtual-chip deltas and would also accept a valid typed roulette feat; do not claim the feat is server-verified end-to-end.
- Global toast/profile reuse the existing catalog and event wiring. Run one deterministic Playwright Sic Bo toast journey using a mocked wallet response and one profile locked-badge assertion. Test SNG Champion by `PokerGame` and route unit tests, not a nondeterministic browser tournament.

## Failure behavior and exclusions

A wallet settlement commits before achievement evaluation. Reusing today's **best-effort** evaluation means a transient D1 failure could lose an ephemeral feat while the account balance still updates; replaying a duplicate receipt does not re-emit feats. This is an accepted MVP tradeoff. Milestones can be re-checked on a later successful round. Do **not** add an outbox, wallet receipt rewrite, retry subsystem, or generalized event ledger for badges.

Do not add live progress bars, leaderboard filters, multi-tier badge art, retrospective feat scanning, new game stats for SNG, new persistence, guest badge sync, or anti-cheat. Art/SFX are out of scope and would be separate tasks if wanted.

## Acceptance criteria

1. All nine new IDs have definitions, rules, and four-locale translations; the original five remain unchanged.
2. One compile-time-checked `WALLET_FEAT_GAMES` table drives wallet validation and `WalletFeatId`. A shared `checkFeat` helper handles six feats; the SNG route separately authorizes its fixed ID.
3. Invalid, duplicate, or disallowed wallet feats fail before writes, while omitted feats preserve existing command shapes. The achievement service reads per-game stats once and aggregates locally with no row mapping.
4. A Poker royal feat occurs only at a contested showdown (not walkovers). A controller-level regression checks unchanged feat-free commands for existing callers.
5. Specialist stays at 100 wins in one game despite potential simultaneous Consistent Winner unlocks. Repeated receipts/POSTs cannot grant a badge twice.
6. A signed-in first-place SNG player sends an empty POST; the server uses `locals.user.chipBalance` and may return other badges without changing wallet, stats, or missions.
7. A deterministic mocked Sic Bo Playwright settlement demonstrates the localized toast, and profile E2E verifies new locked badges. SNG uses route/engine tests. Run full tests, lint, formatting, and build checks.
