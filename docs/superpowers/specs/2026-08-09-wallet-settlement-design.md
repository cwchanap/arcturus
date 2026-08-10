# Small Wallet Settlement Module Design

**Status:** Revised after repository review; ready for implementation  
**Date:** 2026-08-09  
**Issue:** HPA-545  
**Parent roadmap:** HPA-167  
**Scope:** Replace casual single-player chip-sync implementations with one deliberately small wallet settlement boundary while keeping the repository's existing `src/lib/<domain>` layout.

---

## 1. Why this is the next task

HPA-542 is complete, so private-room poker no longer shares the persistent account wallet. HPA-545 is now the highest-priority unblocked architecture task in the roadmap and blocks Video Poker plus several later game/module tickets.

The repository currently implements the same play-money write concern several different ways:

- Blackjack has pending-stat aggregation, retries, follow-up retries, optimistic rebasing, and sync IDs.
- Baccarat has a separate pending-stat/retry state helper.
- Slots has a batching `ChipSyncCoordinator`, balance-sync state, backoff, and unload flushing.
- Keno has a durable outbox, cross-tab heartbeats, orphan recovery, persisted draining, and replay reconciliation.
- Craps batches resolved rolls and also syncs bet placement/refunds, with retry and persisted dropped-sync state.
- Poker performs settlement transport from inside `PokerGame`.
- Roulette owns a second server-authoritative settlement cascade plus persisted spin-recovery state.
- `/api/chips/update` contains game-specific limits, receipt replay comparison, rate limiting, optimistic balance matching, statistics, missions, and achievement-response caching.

Those mechanisms were reasonable when the project was optimizing for recovery and compatibility. They are now contrary to the single-player-first hobby-project direction. HPA-545 deletes them instead of hiding them behind a configurable abstraction.

---

## 2. Goals

- One wallet library owns authenticated casual-game balance settlement.
- Every wallet mutation for a completed casual game event uses one server application function: `settleWalletRound`.
- Client-authoritative games use one thin browser function and `POST /api/wallet/settle`.
- Roulette remains server-authoritative for spin generation, but calls `settleWalletRound` directly after calculating the result.
- One settlement updates balance, receipt, game statistics, and directly related mission progress atomically.
- `(userId, settlementId)` is idempotent, including ordinary concurrent duplicate requests.
- A duplicate returns the stored resulting balance; it does not reproduce historical achievement/toast payloads.
- Game clients may keep one in-memory failed command for a visible manual retry, but may not persist queues or coordinate background retries.
- The migration is intentionally breaking. Existing receipt rows, pending browser settlement state, and old endpoint compatibility are discarded.
- The resulting code and test surface is materially smaller than the current implementation.

## 3. Non-goals

- Server-authoritative outcomes for currently client-authoritative games.
- Anti-cheat, abuse detection, audit logging, per-isolate rate limiting, payload signing, or tamper evidence.
- Crash-durable browser queues, IndexedDB, Web Locks, cross-tab ownership, background drains, exponential retry policy, or unload beacons.
- Replaying historical achievement toasts after a duplicate request.
- Recovering a historical Roulette wheel result after a committed response is lost.
- Financial-grade recovery from every Worker/browser interruption.
- Multiplayer settlement.
- A generic ledger, event bus, repository framework, workflow engine, or configurable per-game settlement strategy.
- Preserving `/api/chips/update`, `chip_sync_receipt`, `roulette_round`, old local-storage settlement keys, or their payload formats.
- Moving the repository to a new `src/modules` package layout as part of this task.

---

## 4. Approaches considered

### A. Recommended: one server settlement core plus thin adapters

Create one concrete wallet use case under the repository's existing domain-library convention. Normal client-authoritative games call it through `/api/wallet/settle`; Roulette calls the same use case from its existing server spin route.

**Why:** This shares the actual domain concern—account balance settlement—without forcing Roulette's RNG/bet validation through a client transport or introducing a new top-level project layout.

### B. One configurable browser sync client for every existing behavior

Preserve batching, outboxes, rebasing, rate-limit retries, unload flushing, and per-game callbacks behind options.

**Rejected:** This recreates the current complexity inside a larger abstraction and was the reason HPA-545 was previously canceled.

### C. Introduce `src/modules/wallet` and split schema ownership by module

Move the wallet implementation into a new top-level module tree and give it a separate schema file.

**Rejected for HPA-545:** The current repository keeps domain code under `src/lib/<domain>` and the active D1 schema in `src/db/schema.ts`. HPA-542 deliberately preserved that layout. A repository-wide package reorganization is unrelated to settlement simplification and would add structural novelty without improving this feature.

### D. Force Roulette onto the browser settlement endpoint

Move Roulette RNG/payout calculation client-side so every game literally performs the same request.

**Rejected:** This changes unrelated gameplay trust semantics only to make transport uniform. The wallet boundary should not dictate where game outcomes are calculated.

---

## 5. Repository boundary and reuse

Use the existing repository shape:

```text
src/lib/wallet/
  types.ts          # SettleRoundCommand / result contract
  repository.ts     # concrete D1 balance/receipt/stats/mission batch
  settle.ts         # validation, idempotency, bounded in-request conflict retry
  client.ts         # one browser request helper; no retry policy
  index.ts          # browser-safe exports only

src/db/schema.ts                    # walletSettlement table with the other active D1 tables
src/pages/api/wallet/settle.ts      # auth + JSON parse + settleWalletRound
src/pages/api/roulette/spin.ts      # roulette validation/RNG + settleWalletRound
```

Reuse existing focused primitives rather than reimplementing them:

- `GameType` and `isValidGameType` from `src/lib/game-stats`.
- `MissionGameEvent` and the existing mission prepared-statement path.
- `checkAndGrantAchievements` for post-settlement achievement checks.
- `fetchJsonWithTimeout` from `src/lib/fetch-with-timeout.ts` for the single browser request.
- The current `game_stats` upsert semantics from `src/lib/chip-sync-batch-sql.ts`, rewritten under the new receipt gate rather than copied as a second parallel cascade.

Dependency direction:

```text
casual game browser code
        |
        +--> src/lib/wallet/client.ts
                  |
                  v
        POST /api/wallet/settle
                  |
                  v
        src/lib/wallet/settle.ts
                  |
                  v
        src/lib/wallet/repository.ts
                  |
                  +--> D1 user / game_stats / wallet_settlement
                  +--> mission progress prepared statements

roulette browser
        |
        v
/api/roulette/spin
        |
        +--> roulette rules + server RNG
        +--> src/lib/wallet/settle.ts
```

`wallet` must not import a game engine, page, renderer, or game-specific retry policy. Games may import the browser client/types; server-only code may additionally import `settleWalletRound`.

---

## 6. Public settlement contract

Use one command per completed account-impacting game event:

```ts
export interface RoundStats {
  rounds: number;
  wins: number;
  losses: number;
  biggestWin: number;
}

export interface SettleRoundCommand {
  settlementId: string;
  game: GameType;
  delta: number;
  stats: RoundStats;
}

export interface SettleRoundResult {
  balance: number;
  duplicate: boolean;
  newAchievements?: Array<{
    id: string;
    name: string;
    icon: string;
  }>;
}
```

Validation stays domain-sized:

- `settlementId` is 1–128 characters.
- `game` must be an existing `GameType`.
- all numeric values are safe integers;
- `rounds >= 1`;
- `wins >= 0`, `losses >= 0`, and `wins + losses <= rounds`;
- `biggestWin >= 0`;
- applying `delta` must not make the account balance negative.

There are no per-game win caps, `previousBalance`, `statsDelta`, payload hashes, canonical replay comparison, rate-limit fields, retry counts, or compatibility fields.

`rounds` means the existing statistics unit for the game. For Blackjack split hands it is the number of completed hands. For Craps it is the number of wagers resolved by that roll. For Slots, Keno, Baccarat, Poker, and Roulette it is normally one completed play.

---

## 7. Receipt schema and idempotency

Replace `chip_sync_receipt` with a purpose-specific table in `src/db/schema.ts`:

```text
wallet_settlement
  userId         text
  settlementId   text
  attemptId      text
  balance        integer
  createdAt      integer

PRIMARY KEY (userId, settlementId)
INDEX (createdAt)
```

The receipt stores only what duplicate handling requires. It intentionally does not store the request payload, statistics payload, rank, warnings, or achievement response.

`attemptId` is server-generated and never exposed to the browser. It exists only so every side-effect statement in one D1 batch can prove that it belongs to the fresh settlement that won the idempotency race. A losing concurrent request cannot reuse a peer's receipt to apply statistics or missions again.

### Settlement algorithm

`settleWalletRound` performs:

1. Read `(userId, settlementId)`. If present, return `{ balance, duplicate: true }` immediately.
2. Read the current balance and calculate `nextBalance = balance + delta`.
3. Reject if `nextBalance < 0` or the command is invalid.
4. Generate one `attemptId` for this server invocation.
5. Submit one D1 batch:
   1. guarded balance update: update only when the current balance still equals the value read and no receipt exists;
   2. insert `wallet_settlement` only if that guarded update changed one row;
   3. upsert `game_stats`, gated by this exact `(userId, settlementId, attemptId)` receipt;
   4. update mission progress, gated by the same receipt identity.
6. If the guarded update changed one row, return the new balance and mark the settlement fresh.
7. If it changed zero rows, re-read the receipt. If another duplicate request won, return its balance as a duplicate.
8. Otherwise refresh the account balance and retry the optimistic step once. If another unrelated wallet write wins again, return one ordinary conflict and let the UI offer manual retry.

This keeps cross-game concurrency handling on the server and removes every browser balance-rebase loop. Two bounded in-request attempts are sufficient for normal hobby-project use; there is no background retry worker.

---

## 8. Statistics, missions, and achievements

### Statistics

Port the existing `game_stats` accumulation behavior under the new receipt gate:

- `totalWins += stats.wins`;
- `totalLosses += stats.losses`;
- `handsPlayed += stats.rounds`;
- `netProfit += delta`;
- `biggestWin` changes only when the new candidate is positive and larger than the stored value.

A push or zero candidate must never reset a previous biggest win. This preserves the intent of the current `CHIP_SYNC_STATS_UPSERT_SQL` CASE expression while removing its old receipt coupling.

### Missions

Keep mission progress atomic with settlement. Replace the current `chip_sync_receipt` gate with a `wallet_settlement` gate containing both `settlementId` and `attemptId`. The existing `MissionGameEvent` is derived exactly as:

```ts
const missionEvent: MissionGameEvent = {
  gameType: command.game,
  outcome: command.delta > 0 ? 'win' : command.delta < 0 ? 'loss' : 'push',
  handCount: command.stats.rounds,
  winsIncrement: command.stats.wins,
  lossesIncrement: command.stats.losses,
  delta: command.delta,
};
```

The existing mission semantics remain authoritative. In particular, `roundsWon` still uses `winsIncrement` (falling back to outcome only where applicable), so Craps mixed-outcome rolls must report accurate resolved-wager win counts instead of reducing the event to the sign of `delta`.

This is a mechanical change to the current mission prepared-statement gate, not a second mission abstraction.

### Achievements

For a fresh settlement only, run the existing achievement check after the wallet batch and return newly earned achievements for immediate UI use. Achievement grant logic is already idempotent, but duplicate wallet requests do not rerun it solely to reconstruct old toast payloads.

If the Worker disappears after the atomic wallet batch and before achievement response resolution, a historical toast may be lost. That is accepted by HPA-545; the wallet balance, statistics, and direct mission progress remain correct.

---

## 9. Browser client failure behavior

`src/lib/wallet/client.ts` performs one timed request and no retry policy:

```ts
export const WALLET_SETTLEMENT_TIMEOUT_MS = 15_000;

export async function submitWalletSettlement(
  command: SettleRoundCommand,
): Promise<SettleRoundResult>;
```

Use the existing `fetchJsonWithTimeout` helper so both connection and response-body stalls become an ordinary terminal client error. The wallet client does not sleep, retry, persist, queue, elect a tab, rebase a balance, or use `sendBeacon`.

A game may keep the failed `SettleRoundCommand` in memory while the current page is open so a visible **Retry settlement** action can resend the exact same ID. Until the player retries or resets/reloads the game, the game must not start another authenticated play that depends on the unsettled balance.

This is one pending command, not an outbox.

---

## 10. Game migration rules

| Game | New behavior | Delete/simplify |
|---|---|---|
| Blackjack | One settlement per completed round; split stats are sent in that command. | `balance-sync-stats.ts`, both legacy pending-stat test files, follow-up syncs, rate-limit/backoff handling, balance rebasing |
| Baccarat | One settlement after each completed hand. | `balance-sync-state.ts` and test, pending stats, retry classification, balance reconciliation code |
| Poker | One settlement when the human hand is complete, including fold-out. | direct `/api/chips/update` transport and receipt/retry code inside `PokerGame` |
| Slots | One settlement per spin. | `ChipSyncCoordinator`, `balance-sync-state.ts` + test, batching/coalescing, unload beacon |
| Keno | One settlement per draw. | persisted outbox, tab IDs, heartbeats, orphan recovery, drain/replay UI state and outbox-only tests |
| Craps | Settle only when a roll resolves wagers; send that roll's net economic delta and resolved-wager stats. | `balanceSync.ts`, `syncLimits.ts`, server sync on bet placement/refund, roll batching, persistent dropped-sync state, exponential retry/backoff, balance-rebase loop |
| Roulette | Keep server-side RNG/bet validation, then call `settleWalletRound` for the calculated net delta. | separate chip receipt cascade, `roulette_round`, persisted pending-spin recovery, rate limiter, achievement-payload replay |

### Craps boundary

Keep the page thin by extracting only the two Craps-specific settlement calculations needed by the UI into `src/lib/craps/settlement.ts`:

```ts
export function buildCrapsSettlementCommand(
  settlementId: string,
  result: RollResult,
): SettleRoundCommand | null;

export function getAvailableCrapsBalance(
  walletBalance: number,
  activeAtRisk: number,
): number;
```

`buildCrapsSettlementCommand` returns `null` when no wager resolves. Otherwise:

- `delta = result.netDelta`;
- `rounds = number of `win | lose | push` evaluations`;
- `wins = number of winning evaluations`;
- `losses = number of losing evaluations`;
- `biggestWin = gross payout across winning evaluations when positive, otherwise 0`, preserving the current mixed-outcome-roll intent.

Authenticated Craps stops treating bet placement as an account write. Placing a bet moves chips from the game's available amount into its active at-risk bets; clearing/refunding before resolution is also local. After a successful wallet settlement, the available in-game balance is:

```text
wallet settlement balance - current active at-risk bets
```

This keeps still-active wagers reserved locally without syncing their placement to the account.

Old authenticated in-progress settlement/session recovery is discarded. A reload may reset an unfinished table from the server balance. Guest bankroll persistence remains because it is local gameplay state rather than account settlement recovery.

### Roulette boundary

Roulette keeps its current server-authoritative result calculation. HPA-545 does not justify making Roulette client-authoritative.

Remove `roulette_round` together with the browser recovery contract that depends on it:

- delete `pendingSyncId` / `pendingSyncCreatedAt` from persisted game state;
- stop restoring and resubmitting a `spinning` snapshot after reload;
- delete recovery helpers/tests whose only purpose is reconstructing a committed historical wheel result;
- a duplicate wallet result adopts the returned authoritative balance, clears the unresolved spin state, and returns the UI to betting without inventing a winning number.

A response lost after a committed spin can therefore lose the historical wheel display. That is an accepted simplification, not a reason to preserve `roulette_round`.

---

## 11. Breaking database and browser reset

Create `wallet_settlement` in the active schema and remove the old casual settlement tables. Do not write a data backfill.

The hobby database is recreated when this implementation ships. Old `chip_sync_receipt` and `roulette_round` contents are disposable. Historical migrations do not need a general migration/squash framework; the implementation only needs one destructive migration/fresh-schema path plus explicit local/remote recreation instructions.

Remove obsolete settlement local-storage keys without reading or converting them. Keno outboxes, Craps dropped-sync payloads, Roulette pending-spin settlement recovery, and other old sync state simply disappear.

Historical design documents may continue describing the implementation that existed at their date. Current developer guidance, tests, fixtures, and E2E bootstrap code must stop presenting `/api/chips/update` as the active architecture.

---

## 12. Deletion inventory

The implementation preflight and post-delete audit must explicitly classify/remove these known settlement-only surfaces in addition to any fresh grep matches:

```text
src/pages/api/chips/update.ts
src/lib/chip-sync-batch-sql.ts
src/lib/chips-update-api.test.ts
src/lib/chips-update.test.ts

src/lib/blackjack/balance-sync-stats.ts
src/lib/blackjack/balance-sync-stats.test.ts
src/lib/blackjack/balanceSyncStats.test.ts

src/lib/baccarat/balance-sync-state.ts
src/lib/baccarat/balance-sync-state.test.ts

src/lib/slots/chip-sync-coordinator.ts
src/lib/slots/chip-sync-coordinator.test.ts
src/lib/slots/balance-sync-state.ts
src/lib/slots/balance-sync-state.test.ts

src/lib/keno/outbox.ts
src/lib/keno/outbox.test.ts

src/lib/craps/balanceSync.ts
src/lib/craps/balanceSync.test.ts
src/lib/craps/syncLimits.ts

src/lib/roulette/spin-batch-sql.ts
src/lib/roulette/spin-cascade.integration.test.ts
```

Also migrate/remove old endpoint and recovery assumptions in at least:

```text
e2e/global-setup.ts
e2e/isolated-page.ts
e2e/ranked-blackjack.spec.ts
e2e/authed-user-preservation.spec.ts
e2e/blackjack-split.spec.ts
src/lib/roulette/types.ts
src/lib/roulette/RouletteGame.ts
src/lib/roulette/rouletteClient.ts
src/lib/roulette/rouletteClient.test.ts
src/lib/roulette/rouletteClient.integration.test.ts
src/server/cleanup.ts
CLAUDE.md
```

A fresh `git grep` remains authoritative; this list prevents known files from being missed simply because a regex changes.

---

## 13. Testing strategy

### Wallet contract

Focused tests must cover:

- valid positive, negative, and zero-delta settlements;
- negative resulting balance rejection;
- statistics validation;
- a push/zero biggest-win candidate does not erase an existing biggest win;
- sequential duplicate returns stored balance without applying effects twice;
- concurrent duplicate requests apply balance, stats, and mission progress once;
- one unrelated concurrent balance change is handled by the bounded server retry;
- duplicate response does not require historical achievement payload;
- the browser helper times out a stalled request and performs no automatic retry.

### Game migrations

Keep pure game-rule tests unchanged except where setup previously depended on sync implementation details. Replace retry/outbox/coordinator tests with small client-integration tests that assert exactly one command for one completed event.

Create `src/lib/baccarat/baccaratClient.test.ts`; there is no existing Baccarat client test to modify.

Craps gets focused pure tests for command construction and wallet-to-available-balance reconciliation, plus a page/client integration assertion that bet placement/clearing does not call the wallet.

Roulette tests must prove server-generated outcomes still settle through the wallet core, `pendingSyncId` recovery is removed, and a duplicate does not spin or apply delta twice.

### End-to-end

Reuse representative existing Playwright journeys rather than create an E2E matrix for settlement internals. Update fixtures/bootstrap code that currently posts `/api/chips/update`, then run authenticated flows for the affected public single-player suite plus Slots, Keno, Craps, Roulette, Blackjack, Baccarat, and Poker.

---

## 14. Definition of done

- `src/lib/wallet` is the only casual authenticated account-settlement implementation.
- `walletSettlement` lives with the active schema in `src/db/schema.ts`; no new schema-home convention is introduced.
- `/api/chips/update` is deleted.
- `chip_sync_receipt` and `roulette_round` are deleted from the active schema.
- All casual game account writes call `settleWalletRound`, directly or through `/api/wallet/settle`.
- The wallet browser client reuses the shared timeout helper and contains no retry policy.
- No casual game contains a persisted settlement outbox, batching coordinator, background retry loop, balance-rebase loop, unload settlement flush, or receipt replay protocol.
- Balance, receipt, statistics, and direct mission progress are atomic and idempotent.
- Mission events include the existing required `delta` field.
- Duplicate receipt handling returns balance without preserving historical achievement response payloads.
- Roulette remains server-authoritative and its obsolete pending-spin replay path is removed with `roulette_round`.
- Craps settles only resolved wagers and uses focused pure helpers for command/reconciliation math.
- All known old endpoint usages in E2E/bootstrap/current guidance are migrated or deleted.
- Focused wallet tests, affected game tests, lint, formatting, build, and representative Playwright flows pass.
- Net implementation/test complexity decreases; no compatibility layer, settlement feature flags, or repository-wide structural migration is introduced.
