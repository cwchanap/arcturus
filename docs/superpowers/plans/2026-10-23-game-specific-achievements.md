# HPA-172 — Game-specific achievements: implementation plan

**Status:** Proposed; no production code changed by this planning PR yet.  
**Linear:** https://linear.app/cwchanap/issue/HPA-172/achievements-game-specific-badges  
**Design:** [2026-10-23-game-specific-achievements-design.md](../specs/2026-10-23-game-specific-achievements-design.md)

## Working agreement

Implement **all accepted scope in this same PR/branch** (`docs/hpa-172-game-achievements-plan`) after reviewing the design. One ticket = one PR; do not create a follow-up implementation PR. Ship no new images or SFX. Keep this a small, incremental extension of existing services rather than a new event or progression architecture.

Before coding, confirm `main` has not changed relevant achievement/wallet/SNG boundaries; rebase or refresh this same branch if needed. Do not preserve old data contracts for nonexistent clients.

## 1. Achievement definitions and tests

**Files**
- `src/lib/achievements/types.ts`
- `src/lib/achievements/achievement-rules.ts`
- `src/lib/i18n/messages/achievements.ts`
- `src/lib/achievements/achievement-rules.test.ts`

**Work**
1. Add nine IDs to `ACHIEVEMENT_IDS`, static emoji/category definitions, and locale names/descriptions. Keep all five existing IDs and checks intact.
2. Put `WALLET_FEAT_GAMES` in `achievement-rules.ts` near `ACHIEVEMENT_THRESHOLDS` as `as const satisfies Partial<Record<AchievementId, readonly GameType[]>>`. Derive `export type WalletFeatId = keyof typeof WALLET_FEAT_GAMES`. This validates both feat IDs and game values at compile time. **Do not** create a separate wallet allowlist module.
3. Extend `AchievementCheckContext` with `feats?: readonly AchievementId[]` and `gameStats: readonly Pick<GameStats, 'gameType' | 'handsPlayed' | 'totalWins' | 'biggestWin'>[]`. Reuse fetched `GameStats` rows directly; no new projection type or mapping.
4. Use one short `checkFeat(id)` helper for the six feat checks (five wallet + SNG), which checks existing IDs and the feat ID, not a second copy of per-game authorization. The wallet validates the table and the SNG endpoint hard-codes `poker`. Keep three separate milestone predicates and deterministic attribution.
5. **Specialist = 100 wins in one game**, per HPA-172. The existing Consistent Winner is 100 aggregate wins; intentional overlap is acceptable. Lock this in boundary tests before shipping. Cash Poker's royal feat is **showdown only**, not a river walkover.
6. Table-drive tests: feat present/absent, already earned, game type returned; Grand Tour across all 11 games; Specialist and Big Score attribution and boundaries; compilation of table's closed union. Localize all four languages.

**Gate:** `bun test src/lib/achievements/achievement-rules.test.ts`.

## 2. Reuse the achievement service; validate wallet feats

**Files**
- `src/lib/achievements/achievements.ts`
- `src/lib/game-stats/aggregation.ts` (reuse existing `aggregateGameStats`)
- `src/lib/game-stats/game-stats-repository.ts` (reuse existing `getAllUserGameStats`)
- `src/lib/wallet/types.ts`
- `src/lib/wallet/settle.ts`
- `src/lib/achievements/achievements.test.ts`
- `src/lib/wallet/settle.test.ts` and `settle-api.test.ts`

**Work**
1. Replace `getAggregateUserStats` in the service dependency object with `getAllUserGameStats`; call the latter **once** per evaluation, use `aggregateGameStats(rows)` to preserve old aggregate fields, and pass the same rows directly as `context.gameStats`. Pass optional `feats` through service options. Adapt test doubles; no new query or repository.
2. Add `feats?: readonly WalletFeatId[]` to `SettleRoundCommand`. Import `WalletFeatId` (type) from the achievements rules module. In `validate(unknown)`, accept an optional array, reject malformed entries, duplicates, unknown IDs or wrong-game feats against `WALLET_FEAT_GAMES`; do this before any receipt lookup or write. Do not add a separate max-one condition (each game has one allowed feat today). No-feat callers still omit the field.
3. Forward validated `command.feats` from `buildFreshResult` to `checkAndGrantAchievements`; leave wallet receipts, stats, mission writes, and duplicate receipt handling unchanged.
4. Test table membership (including misspelled ID compile-time restriction), bad JSON arrays, duplicates, missing `feats`, wrong-game claims, unchanged legacy commands, and one stats read per evaluation. Preserve aggregate-value test cases and existing achievement/wallet tests.

**Gate:** `bun test src/lib/achievements src/lib/wallet`.

## 3. Existing game settlement wiring

**Files**
- `src/lib/wallet/public-game-settlement.ts` and `public-game-settlement.test.ts`
- `src/lib/video-poker/client.ts`
- `src/lib/sic-bo/client.ts`
- `src/lib/poker/PokerGame.ts` / `PokerGame.test.ts`
- `src/lib/slots/slotsClient.ts` / `slotsClient.test.ts`
- `src/lib/keno/kenoClient.ts` / `kenoClient.test.ts`
- `src/pages/api/roulette/spin.ts` / `src/lib/roulette/spin-api.test.ts`

**Work**
1. Add optional `feats?: readonly WalletFeatId[]` as the third argument to `PublicGameSettlementController.completeRound` and `buildRoundSettlementCommand`. Video Poker emits `royal_treatment` from a royal draw; Sic Bo emits `triple_threat` for identical dice with any winning placed bet. **One controller-level test** verifies that calls with no third argument still emit no `feats` property for all four consumers, including unchanged Three-Card Showdown and Pai Gow Poker. Do not add per-game TCS/PGP test suites or edit their production code.
2. Cash Poker: **only** at the contested showdown in `PokerGame.nextPhase()`, where the human did not fold, call `readHand(human.hand, communityCards)` and pass `royal_treatment` through `settleHand(outcome, feats?)` to `buildPokerSettlementCommand`. Do not award a royal for walkovers, including river walkovers. Existing `playsLocally` already excludes SNG and guests. Test contested showdown vs walkover.
3. Keno: `result.multiplier >= 100` in its existing builder. Slots: `lineWins.some(win => win.symbol === 'seven' && win.count === 5)`. Existing settlement retry retains the original command.
4. Roulette: compute `straight_up` from server-evaluated `results.some(r => r.won && r.bet.type === 'straight')` and put it on the server-built wallet command. `spin.ts` already discards extra request fields; **do not** add a redundant client-feat rejection step or claim the public wallet endpoint independently proves the feat.
5. Test changed command shapes and negative outcomes in each game-local suite, plus the shared-controller test and roulette route. No art, balance changes, extra framework or payout refactor.

**Gate:** focused Poker, Video Poker, Sic Bo, Keno, Slots, Roulette, and shared-controller unit tests.

## 4. Wallet-free Sit & Go Champion

**Files**
- `src/lib/poker/PokerGame.ts` / `PokerGame.test.ts`
- New `src/pages/api/achievements/sng-champion.ts`
- Small route test using `createPostHandler(deps)`, based on `src/pages/api/wallet/settle.ts`

**Work**
1. At the existing single-fire `settleTournamentOutcome()` terminal branch, when `place === 1` for a signed-in human, send **one empty-body POST** to `/api/achievements/sng-champion`. Guest, unfinished, or lower-place tournaments send none.
2. Route: require `locals.user` and `locals.runtime.env.DB`, no JSON parsing or client identity/chip parameters. Call `checkAndGrantAchievements(createDb(d1), locals.user.id, locals.user.chipBalance, { gameType: 'poker', feats: ['sng_champion'] })`; the authenticated balance is required by the service. Reuse guards and `createPostHandler(deps)` test injection from the wallet route. No wallet/stats/mission writes.
3. Return all new `{ id, icon }` badges and invoke Poker's existing `dispatchEarnedAchievements`; rank or retroactive milestone achievements may also appear in the same response. Nonblocking failure, no retry coordinator.
4. Test first-place signed-in => one request and persisted champion with `poker` attribution; second/lower and guests => none; repeat POST => no duplicate; authenticated balance passed correctly; other returned badges allowed; wallet, missions and cash stats untouched.

**Gate:** targeted Poker tournament and route tests, plus existing SNG placement/all-in regression tests. No SNG browser E2E required.

## 5. Presentation and final verification

**Files:** the existing toast/profile should need only achievement catalog updates; add assertions to `e2e/sic-bo.spec.ts` and `e2e/profile.spec.ts` without new UI wiring unless a test reveals a gap.

1. Confirm unlocked and locked badges, deterministic per-game attribution, and a global `null` game on Grand Tour via existing `getAchievementsWithStatus`.
2. **Deterministic Playwright Sic Bo journey:** use the established `page.route('**/api/wallet/settle', …)` pattern to fulfill a result with `newAchievements: [{ id: 'triple_threat', icon: '🎲' }]`. Assert the existing toast displays the localized badge name. This tests presentation, not Sic Bo's random feat predicate (already covered by unit tests).
3. Add one locked-badge assertion in `e2e/profile.spec.ts`. No SNG trophy browser E2E: route and `PokerGame` tests deterministically cover it.
4. Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`, and the focused Playwright tests. Log any environment limitation accurately.
5. Inspect the full diff for wallet/stat mutations, duplicate authorization tables, migrations, extra abstractions, art and unrelated code. Complete HPA-172 in Linear only once this same PR's implementation merges.

## Known risks accepted for MVP

- Wallet achievements are evaluated after committing the settlement; a transient database failure can lose an ephemeral feat, as the current wallet contract already allows. Do not add an outbox/event log.
- Local SNG champion intent is client-reported and does not prove a full tournament replay. Virtual chips, no reward, no anti-cheat work.
- `grand_tour` follows the current `GAME_TYPES` list, including all 11 currently registered games; historic unlocks persist if a game is later added.
- The existing `(userId, achievementId)` PK means each badge can only be earned once across games.
- If a proposed game hook requires refactoring its state engine, reduce that individual feat's scope rather than refactoring the entire game in this ticket.

## Completion checklist

- [ ] Nine badges and four locales, unchanged existing checks, Specialist = 100 in one game
- [ ] Single `WALLET_FEAT_GAMES` table using `as const satisfies`, closed `WalletFeatId`, and one shared feat-check helper
- [ ] One `game_stats` read per achievement evaluation, aggregate locally, pass rows directly
- [ ] Optional feats on existing wallet command/controller; invalid/duplicate/forbidden claims rejected before writes
- [ ] One controller regression for all feat-free callers, no TCS/PGP game changes
- [ ] Five wallet feats (Poker royal at showdown only), three milestones, one wallet-free SNG feat
- [ ] SNG empty POST uses authenticated chip balance and existing toast, allows other newly earned badges
- [ ] Sic Bo mocked-settlement toast E2E, locked-profile E2E, SNG route/engine tests
- [ ] No migration, new art, verification engine, event log or unrelated refactor
- [ ] Full tests, lint, format, build; implementation in **this PR**, linked to HPA-172
