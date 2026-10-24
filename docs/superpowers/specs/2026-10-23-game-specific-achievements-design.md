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
- `src/lib/wallet/public-game-settlement.ts`: shared settlement controller for Video Poker and Sic Bo; Slots, Keno, and Poker have game-local command builders.
- `src/lib/i18n/messages/achievements.ts`: achievement names/descriptions in en, zh-Hant, zh-Hans, and ja. The shared `achievement-earned` event is already handled by the toast. The profile reads `ACHIEVEMENTS`.

**HPA-176 is merged and its Sit & Go runtime exists.** Its `PokerGame.settleTournamentOutcome()` already knows `finishedPlace`, but SNG intentionally has no wallet transaction, no cash-Poker stats, and no account mission event. Do not add any of those to award an SNG badge.

## Badge catalog and exact predicates

| Badge ID | Display name | Category | Trigger | Saved game type |
| --- | --- | --- | --- | --- |
| `royal_treatment` 👑 | Royal Treatment | gameplay | At the end of an unfolded Hold'em cash hand, `readHand(hole, board)?.key === 'ROYAL_FLUSH'`; or Video Poker draw result `evaluation.category === 'royal-flush'`. No requirement to win a pot; a board-only royal counts if the human reaches showdown. | `poker` or `video-poker` |
| `sng_champion` 🏆 | Sit & Go Champion | gameplay | The human finishes **1st** in local six-seat SNG; signed-in client reports terminal result through the narrow endpoint below. | `poker` |
| `triple_threat` 🎲 | Triple Threat | gameplay | Sic Bo's three rolled dice are equal **and at least one placed bet is won** (`results.some(r => r.won)`), even if the round's net delta is negative. | `sic-bo` |
| `straight_up` 🎯 | Straight Up | gameplay | Roulette's **server** `evaluateBets` output has a winning `bet.type === 'straight'`. | `roulette` |
| `big_catch` 🎱 | Big Catch | gameplay | Keno result `multiplier >= 100` (gross payout / wager, not net delta). | `keno` |
| `jackpot` 🎰 | Jackpot | gameplay | Slots result has a line win with `symbol === 'seven' && count === 5`, the top current paytable tier. | `slots` |
| `grand_tour` 🧭 | Grand Tour | milestone | Every ID in `GAME_TYPES` has a `game_stats` row with `handsPlayed >= 1`. Do not count local SNG hands. | `null` |
| `specialist` 🎓 | Specialist | milestone | Any single game has `totalWins >= 100`. | Qualifying game |
| `big_score` 💰 | Big Score | milestone | Any game's `biggestWin >= 10000` (a single positive win, **not** lifetime net profit). | Qualifying game |

The account-wide milestones are **retroactive** against existing aggregate stats the next time achievements are evaluated, and do not require backfilling D1. If several games qualify for a per-game milestone, use the current settling game when it qualifies; otherwise choose the first qualifying `GAME_TYPES` entry for deterministic `gameType` attribution. `grand_tour` is global and always stores null. Every badge is earned at most once **per account**, not per game, matching the existing composite key.

## Settlement feat contract

Extend `SettleRoundCommand` with optional `feats?: string[]`. Add `feats?: readonly string[]` to the achievement service/context options. The wallet's `validate(unknown)` accepts omitted feats or an array containing at most one recognized feat, and rejects non-strings, duplicates, unknown IDs, and a feat not allowed for that `game` with `INVALID_COMMAND`, before any wallet write. A single game can emit at most one defined feat per round today; avoid a generalized registry/plugin mechanism.

Wallet feat allowlist:

- `poker` and `video-poker`: `royal_treatment`
- `sic-bo`: `triple_threat`
- `roulette`: `straight_up`
- `keno`: `big_catch`
- `slots`: `jackpot`
- All other games: none.

`sng_champion` is **not valid on any wallet command**. It uses the SNG-only endpoint. The service's feat checks require the expected `gameType` and the feat ID in the current request; milestones require no feat. Do not persist the feat array in the wallet receipt or game stats: it is only input to post-settlement achievement checking.

Use `getAllUserGameStats(db, userId)` once as an additional service dependency to build a compact per-game stats view. Reuse the existing aggregate query rather than rewriting all consumers. This costs one small D1 read per normal achievement evaluation and avoids a new materialized store.

### SNG-only achievement event

Add a **single authenticated** POST endpoint `/api/achievements/sng-champion` with no wallet or stats operation. Only the terminal `finishedPlace === 1` branch of `PokerGame.settleTournamentOutcome()` calls it, and only for signed-in users. Server obtains `userId` from `locals.user`, never the request payload, checks a fixed champion intent, and calls the existing achievement service with `gameType: 'poker'` and `feats: ['sng_champion']`. Never insert directly into `user_achievement` from the route. A repeat POST is harmless because the repository's primary key rejects duplicate grants.

Return only the newly granted `{id, icon}` payload; dispatch the existing `achievement-earned` event on success. In a guest SNG, still show the place but do not make the request. No SNG wallet receipt, cash-Poker stats, mission tokens, tournament database, prize, or historical result is created.

**Trust policy:** a signed-in client can claim this local-only champion feat without server-replayed tournament proof. The game uses play money and this badge carries no economic reward. Document this tradeoff rather than inventing a server-side SNG coordinator.

## Client integration

- Video Poker/Sic Bo: add an optional `feats` argument to `PublicGameSettlementController.completeRound` so existing callers remain unchanged; derive the feat from the completed round and submit it with the same wallet command.
- Poker: include `royal_treatment` on the *cash* `buildPokerSettlementCommand` call only when the human reaches a qualifying complete hand. Keep SNG fully isolated.
- Slots and Keno: extend existing game-local command builders to read `lineWins` or `multiplier` on the completed result, respectively. Retried commands retain the original feat list.
- Roulette: set `straight_up` within `src/pages/api/roulette/spin.ts`, using server-calculated winning `BetResult`, not a client flag.
- Existing toast/profile should require no display wiring beyond adding the IDs and four-locale messages. Verify this with tests/browser smoke.

## Failure behavior and exclusions

A wallet settlement commits before achievement evaluation. Reusing today's **best-effort** evaluation means a transient D1 failure could lose an ephemeral feat while the account balance still updates; replaying a duplicate receipt does not re-emit feats. This is an accepted MVP tradeoff. Milestones can be re-checked on a later successful round. Do **not** add an outbox, wallet receipt rewrite, retry subsystem, or generalized event ledger for badges.

Do not add live progress bars, leaderboard filters, multi-tier badge art, retrospective feat scanning, new game stats for SNG, new persistence, guest badge sync, or anti-cheat. Art/SFX are out of scope and would be separate tasks if wanted.

## Acceptance criteria

1. Every added ID has one definition, rule, and translated name/description in all four locales. Existing five achievement rules remain unchanged.
2. All six feat predicates and three milestone predicates are covered by positive, negative, game attribution, and already-earned unit tests.
3. Invalid/disallowed wallet feats return `INVALID_COMMAND` before writes; omitted feats leave previous requests untouched.
4. A single accepted wallet event grants each feat once, and repeated receipts/POSTs do not grant a second badge.
5. SNG champion works only on signed-in first-place completion and never touches wallet, guest bankroll, cash stats, or missions.
6. Profile and toast show new earned badges. Run focused unit tests, full unit suite, lint, format check and build, plus at least one representative browser journey.
