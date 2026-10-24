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
1. Add nine IDs in `ACHIEVEMENT_IDS`, their emoji/category records in `ACHIEVEMENTS`, and named checks in `ACHIEVEMENT_CHECKS`. Keep the five existing IDs stable.
2. Extend `AchievementCheckContext` with optional current-round feat IDs and small per-game statistic rows (game ID, rounds, wins, biggest win); do not duplicate the entire `GameStats` entity when a slim projection suffices.
3. Make feat checks require the matching `gameType`; `sng_champion` matches only the isolated SNG achievement service request. Milestones use current stats and return deterministic game context. Continue using `existingAchievementIds` to short-circuit already earned checks, and the DB PK as final idempotency gate.
4. Add all four locale translations in both catalogs and the relevant `getAchievementDescription` cases (with 100 wins, 100× payout, or 10,000 chips text as applicable).
5. Table-drive predicate tests: positive/negative, wrong game, already earned, all 11 games for Grand Tour, multi-game Specialist/Big Score attribution, boundary values.

**Gate:** `bun test src/lib/achievements/achievement-rules.test.ts`.

## 2. Reuse the achievement service; validate wallet feats

**Files**
- `src/lib/achievements/achievements.ts`
- `src/lib/game-stats/game-stats-repository.ts` (read existing export, change only if necessary)
- `src/lib/wallet/types.ts`
- `src/lib/wallet/settle.ts`
- `src/lib/achievements/achievements.test.ts`
- `src/lib/wallet/settle.test.ts`
- `src/lib/wallet/settle-api.test.ts`

**Work**
1. Supply `getAllUserGameStats` to the existing service's dependency object alongside `getAggregateUserStats`. Map the returned 11-or-fewer rows into the rule context; pass optional `feats` through service options. Prefer the already-existing reader over a custom query or a new repository class.
2. Add `feats?: string[]` on `SettleRoundCommand`. Extend `validate(unknown)` allowed top-level keys with `feats`, use one concise per-game allowlist, and allow zero or one valid feat. Validate before receipt lookup, balance update or DB batch. All omitted-feat commands remain valid.
3. Forward validated `command.feats` from `buildFreshResult` to achievement evaluation. Do not change wallet receipt schema, post-commit ordering, or duplicate-receipt behavior.
4. Test accepted/disallowed combinations, malformed arrays, missing feats, duplicate receipt idempotence, and the new context dependency. Ensure previous achievement/wallet tests still pass.

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
1. Extend `PublicGameSettlementController.completeRound(netDelta, localBalance, feats?)` and `buildRoundSettlementCommand(..., feats?)`; do **not** introduce a second settlement controller. Video Poker emits `royal_treatment` from `round.evaluation.category`; Sic Bo emits `triple_threat` if the dice all match and any bet won.
2. Cash Poker: check `readHand(human.hand, communityCards)` when the completed hand is settled; pass `royal_treatment` to the existing command builder only when the human did not fold and qualifies. Never emit it from SNG through the cash settlement path.
3. Keno: use `result.multiplier >= 100` in the existing command builder. Slots: use `result.lineWins.some(win => win.symbol === 'seven' && win.count === 5)`. Keep the same feat on settlement retry, because the original command is already retained by the gate.
4. Roulette: compute `straight_up` from `results.some(result => result.won && result.bet.type === 'straight')` after server evaluation and include it in the server-built command. Reject any request trying to submit a feat via roulette client fields.
5. Test command shape and negative outcomes in game-local tests; smoke-test the shared public-game controller and roulette server route. No new graphics, settings, page-level state machines, or payout changes.

**Gate:** focused Poker, Video Poker, Sic Bo, Keno, Slots, Roulette and wallet-controller unit tests.

## 4. Wallet-free Sit & Go Champion

**Files**
- `src/lib/poker/PokerGame.ts` / `PokerGame.test.ts`
- New `src/pages/api/achievements/sng-champion.ts`
- A small colocated route/service test, following `src/lib/roulette/spin-api.test.ts` conventions

**Work**
1. At the already-single-fire `settleTournamentOutcome()` terminal branch, if `place === 1` and authenticated (not guest), make one asynchronous POST of fixed champion intent. A finish other than 1, nonterminal hand, or guest produces no request.
2. In the server route, require `locals.user`, get database from `locals.runtime.env.DB`, ignore client identity/chips, and pass `feats: ['sng_champion']` with game type `poker` to **the existing** `checkAndGrantAchievements`. Avoid `settleWalletRound` and any `game_stats` writes.
3. Return only new achievements with `id`/ `icon`; dispatch the existing `achievement-earned` CustomEvent on success. Log and ignore network failure in the local tournament UI; do not block place display or start an account-side retry engine.
4. Tests: first-place signed-in => one call/toast and persisted game type `poker`; second or lower => none; guest => none; repeated endpoint call => no second grant; account wallet/mission/cash stats untouched.

**Gate:** targeted Poker tournament and endpoint tests. Re-run existing SNG all-in/placement regression tests.

## 5. Presentation and final verification

**Files:** usually no toast/profile production changes beyond the achievement catalogs. Touch UI code only if testing proves a missing integration.

1. Confirm `getAchievementsWithStatus` shows unlocked and locked new entries and `gameType` attribution, including the global null case.
2. Confirm the global toast handles the wallet and SNG endpoint payloads with locale-resolved names.
3. Confirm no guest profile badge is persisted. Check new translations render with no untranslated key or missing switch branch.
4. Run `bun run test`, `bun run lint`, `bun run format:check`, `bun run build`. Run at least one Playwright route journey for a wallet feat and one signed-in SNG trophy path if the harness supports deterministic setup; otherwise keep the deterministic unit/route tests as the gate and document the E2E limitation.
5. Inspect the final diff for accidental wallet/stat changes, extra abstractions, DB migration, art, and unrelated refactors. Complete HPA-172 on Linear only after this same PR's implementation merges.

## Known risks accepted for MVP

- Wallet achievements are evaluated after committing the settlement; a transient database failure can lose an ephemeral feat, as the current wallet contract already allows. Do not add an outbox/event log.
- Local SNG champion intent is client-reported and does not prove a full tournament replay. Virtual chips, no reward, no anti-cheat work.
- `grand_tour` follows the current `GAME_TYPES` list, including all 11 currently registered games; historic unlocks persist if a game is later added.
- The existing `(userId, achievementId)` PK means each badge can only be earned once across games.
- If a proposed game hook requires refactoring its state engine, reduce that individual feat's scope rather than refactoring the entire game in this ticket.

## Completion checklist

- [ ] Nine badges in IDs/rules/i18n, with tests and correct `gameType`
- [ ] One allowlisted optional wallet `feats` input, with negative validation tests
- [ ] Five wallet-attached feats, three stat milestones, and a wallet-free SNG champion signal
- [ ] No DB/schema changes, no new artwork, no second progression or settlement path
- [ ] Toast/profile verified; full lint/test/format/build gates green
- [ ] Implementation landed in **this PR**, linked to HPA-172
