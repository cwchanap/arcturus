# Small Wallet Settlement Module Design

**Status:** Ready for implementation planning  
**Date:** 2026-08-09  
**Issue:** HPA-545  
**Parent roadmap:** HPA-167  
**Scope:** Replace casual single-player chip-sync implementations with one deliberately small wallet settlement module.

---

## 1. Why this is the next task

HPA-542 is complete, so private-room poker no longer shares the account wallet. HPA-545 is now the highest-priority unblocked architecture task in the roadmap and blocks Video Poker plus several later game/module tickets.

The repository currently implements the same play-money write concern several different ways:

- Blackjack has pending-stat aggregation, retries, follow-up retries, optimistic rebasing, and sync IDs.
- Slots has a batching `ChipSyncCoordinator`, balance-sync state, backoff, and unload flushing.
- Keno has a durable outbox, cross-tab heartbeats, orphan recovery, persisted draining, and replay reconciliation.
- Craps batches resolved wagers and also syncs bet placement/refunds, with retry and persisted dropped-sync state.
- Poker performs settlement transport from inside `PokerGame`.
- Roulette owns a separate server-authoritative settlement cascade and replay tables.
- `/api/chips/update` contains game-specific limits, receipt replay comparison, rate limiting, optimistic balance matching, statistics, missions, and achievement-response caching.

Those mechanisms were reasonable when the project was optimizing for recovery and compatibility. They are now contrary to the single-player-first hobby-project direction. The goal is to delete them, not hide them behind a configurable abstraction.

---

## 2. Goals

- One wallet module owns authenticated casual-game balance settlement.
- Every wallet mutation for a completed casual game event uses one server application function: `settleWalletRound`.
- Client-authoritative games use one thin browser function and `POST /api/wallet/settle`.
- Roulette remains server-authoritative for spin generation, but calls `settleWalletRound` directly after calculating the result.
- One settlement updates balance, receipt, game statistics, and directly related mission progress atomically.
- `(userId, settlementId)` is idempotent, including ordinary concurrent duplicate requests.
- A duplicate returns the stored resulting balance; it does not reproduce historical achievement/toast payloads.
- Game clients may keep one in-memory failed command for a visible manual retry, but may not persist queues or coordinate background retries.
- The migration is intentionally breaking. Existing receipt rows, pending browser state, and old endpoint compatibility are discarded.
- The resulting code and test surface is materially smaller than the current implementation.

## 3. Non-goals

- Server-authoritative outcomes for currently client-authoritative games.
- Anti-cheat, abuse detection, audit logging, per-isolate rate limiting, payload signing, or tamper evidence.
- Crash-durable browser queues, IndexedDB, Web Locks, cross-tab ownership, background drains, exponential retry policy, or unload beacons.
- Replaying historical achievement toasts after a duplicate request.
- Financial-grade recovery from a Worker disappearing between the wallet commit and non-atomic follow-up UI effects.
- Multiplayer settlement.
- A generic ledger, event bus, repository framework, workflow engine, or configurable per-game settlement strategy.
- Preserving `/api/chips/update`, `chip_sync_receipt`, `roulette_round`, old local-storage settlement keys, or their payload formats.

---

## 4. Approaches considered

### A. Recommended: one server settlement core plus thin adapters

Create one concrete wallet use case and repository. Normal client-authoritative games call it through `/api/wallet/settle`; Roulette calls the same use case from its existing server spin route.

**Why:** This shares the actual domain concern—account balance settlement—without forcing Roulette's RNG/bet validation through a client transport or adding configuration flags for every old behavior.

### B. One configurable browser sync client for every existing behavior

Preserve batching, outboxes, rebasing, rate-limit retries, unload flushing, and per-game callbacks behind options.

**Rejected:** This recreates the current complexity inside a larger abstraction and was the reason HPA-545 was previously canceled.

### C. Force Roulette onto the same browser settlement endpoint

Move Roulette RNG/payout calculation client-side so every game literally performs the same request.

**Rejected:** This changes unrelated gameplay trust semantics only to make transport uniform. The wallet boundary should not dictate where game outcomes are calculated.

---

## 5. Module boundary

```text
src/modules/wallet/
  types.ts          # SettleRoundCommand / result contract
  schema.ts         # wallet_settlement receipt table
  repository.ts     # concrete D1 balance/receipt/stats batch
  settle.ts         # validation, idempotency, bounded in-request conflict retry
  client.ts         # one browser POST helper; no retry policy
  index.ts          # browser-safe public exports
```

Adapters remain thin:

```text
src/pages/api/wallet/settle.ts     # auth + JSON parse + settleWalletRound
src/pages/api/roulette/spin.ts     # roulette validation/RNG + settleWalletRound
```

Dependency direction:

```text
casual game browser code
        |
        +--> modules/wallet/client.ts
                  |
                  v
        POST /api/wallet/settle
                  |
                  v
        modules/wallet/settle.ts
                  |
                  v
        modules/wallet/repository.ts
                  |
                  +--> D1 user / game_stats / wallet_settlement
                  +--> mission progress prepared statements

roulette browser
        |
        v
/api/roulette/spin
        |
        +--> roulette rules + server RNG
        +--> modules/wallet/settle.ts
```

`wallet` must not import a game engine, page, renderer, or game-specific retry policy. Games may import only `wallet/client.ts`, shared wallet types, or—in server-only code—the `settleWalletRound` application function.

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

Replace `chip_sync_receipt` with a purpose-specific receipt:

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

`attemptId` is server-generated and never exposed to the browser. It exists only so every statement in one D1 batch can prove that it belongs to the fresh settlement that won the idempotency race. This avoids double-applying statistics or missions when two requests with the same settlement ID race.

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
8. Otherwise refresh the account balance and retry the in-request optimistic step once. If another unrelated wallet write wins again, return one ordinary application conflict and let the UI offer manual retry.

This keeps cross-game concurrency handling on the server and removes every browser balance-rebase loop. Two bounded in-request attempts are sufficient for normal hobby-project use; there is no background retry worker.

---

## 8. Statistics, missions, and achievements

### Statistics

A fresh wallet batch updates `game_stats` using:

- `totalWins += stats.wins`;
- `totalLosses += stats.losses`;
- `handsPlayed += stats.rounds`;
- `biggestWin = max(biggestWin, stats.biggestWin)`;
- `netProfit += delta`.

No game-specific settlement branch is needed.

### Missions

Keep mission progress atomic with settlement. Replace the current `chip_sync_receipt` gate with a `wallet_settlement` gate that includes `attemptId`. The mission event is derived from the same command:

```ts
{
  gameType: command.game,
  outcome: command.delta > 0 ? 'win' : command.delta < 0 ? 'loss' : 'push',
  handCount: command.stats.rounds,
  winsIncrement: command.stats.wins,
  lossesIncrement: command.stats.losses,
}
```

This is a focused change to the current mission prepared-statement gate, not a generic event system.

### Achievements

For a fresh settlement only, run the existing achievement check after the wallet batch and return newly earned achievements for immediate UI use. Achievement grant logic is already idempotent, but duplicate wallet requests do not rerun it solely to reconstruct old toast payloads.

If the Worker disappears after the atomic wallet batch and before achievement response resolution, a historical toast may be lost. That is accepted by the HPA-545 scope; the wallet balance, statistics, and direct mission progress remain correct.

---

## 9. Game migration rules

| Game | New behavior | Delete/simplify |
|---|---|---|
| Blackjack | One settlement per completed round; split stats are sent in that command. | pending-stat accumulator, follow-up syncs, rate-limit/backoff handling, balance rebasing, sync coordinator state |
| Baccarat | One settlement after each completed hand. | pending stats, retry classification, balance reconciliation code |
| Poker | One settlement when the human hand is complete, including fold-out. | direct `/api/chips/update` transport and receipt/retry code inside `PokerGame` |
| Slots | One settlement per spin. | `ChipSyncCoordinator`, batching/coalescing, unload beacon, balance-sync state |
| Keno | One settlement per draw. | persisted outbox, tab IDs, heartbeats, orphan recovery, drain/replay UI state |
| Craps | Settle only when a roll resolves wagers; send that roll's net economic delta and resolved-wager stats. | server sync on bet placement/refund, roll batching, persistent dropped-sync state, exponential retry/backoff, balance-rebase loop |
| Roulette | Keep server-side RNG/bet validation, then call `settleWalletRound` for the calculated net delta. | separate chip receipt cascade, `roulette_round` replay persistence, rate limiter, achievement-payload replay |

### Craps clarification

Authenticated Craps stops treating local bet placement as an account write. Placing a bet moves chips from the game's available local amount into its at-risk bets; canceling/refunding before resolution is also local. The wallet changes only when a roll resolves one or more wagers, using `RollResult.netDelta`.

For authenticated play, old persisted in-progress settlement/session recovery is discarded. A reload may reset an unfinished table from the server balance. Guest bankroll persistence remains because it is local gameplay state rather than account settlement recovery.

### Roulette clarification

Roulette keeps its current server-authoritative result calculation. HPA-545 does not justify making Roulette client-authoritative.

`roulette_round` is removed. Therefore a response lost after a successful spin cannot reconstruct the historical winning number on retry. A repeated `syncId` resolves through `wallet_settlement` and returns the already-settled balance with a duplicate indication; the UI can reset to the next spin instead of recreating the old result. This deliberately trades rare response-loss recovery for a much smaller architecture.

---

## 10. Client failure behavior

`wallet/client.ts` performs exactly one request:

```ts
export async function submitWalletSettlement(
  command: SettleRoundCommand,
): Promise<SettleRoundResult>;
```

It parses the typed success result and otherwise throws one `WalletSettlementError` containing a human-readable message. It does not sleep, retry, persist, queue, elect a tab, rebase a balance, or use `sendBeacon`.

A game may keep the failed `SettleRoundCommand` in memory while the current page is open so a visible **Retry settlement** action can resend the exact same ID. Until the player retries or resets/reloads the game, the game should not start another authenticated round that depends on the unsettled balance.

This is one pending command, not an outbox.

---

## 11. Breaking database and browser reset

Create the new wallet receipt schema and remove the old settlement-specific tables/columns used only by casual sync. Do not write a data backfill.

The hobby database is recreated when this implementation ships. Old `chip_sync_receipt` and `roulette_round` contents are disposable. Historical migrations do not need a general migration/squash framework; the implementation only needs a clear fresh-schema path and explicit local/remote recreation instructions.

Remove obsolete settlement local-storage keys without reading or converting them. Keno outboxes, Craps dropped-sync payloads, and any old sync coordinator persistence simply disappear.

Historical design documents may continue describing the implementation that existed at their date. Current developer guidance and runtime tests must stop presenting `/api/chips/update` as the active architecture.

---

## 12. Testing strategy

### Wallet contract

Focused tests must cover:

- valid positive, negative, and zero-delta settlements;
- negative resulting balance rejection;
- statistics validation;
- sequential duplicate returns stored balance without applying effects twice;
- concurrent duplicate requests apply balance, stats, and mission progress once;
- one unrelated concurrent balance change is handled by the bounded server retry;
- duplicate response does not require historical achievement payload.

### Game migrations

Keep pure game-rule tests unchanged except where setup previously depended on sync implementation details. Replace retry/outbox/coordinator tests with small client-integration tests that assert exactly one command for one completed event.

Craps needs a focused regression proving:

- bet placement and clearing do not call the wallet;
- a roll with no resolved wager does not settle;
- a roll with resolved wagers sends exactly `RollResult.netDelta` and matching stats.

Roulette needs a focused route test proving server-generated outcomes still settle through the wallet core and a duplicate does not spin or apply delta twice.

### End-to-end

Reuse representative existing Playwright journeys rather than create an E2E matrix for settlement internals. At minimum run authenticated flows for the public single-player suite plus the existing Slots, Keno, Craps, Roulette, Blackjack, Baccarat, and Poker specs affected by the migration.

---

## 13. Definition of done

- `src/modules/wallet` is the only casual authenticated account-settlement implementation.
- `/api/chips/update` is deleted.
- `chip_sync_receipt` and `roulette_round` are deleted from the active schema.
- All casual game account writes call `settleWalletRound`, directly or through `/api/wallet/settle`.
- No casual game contains a persisted settlement outbox, batching coordinator, background retry loop, balance-rebase loop, or receipt replay protocol.
- Balance, receipt, statistics, and direct mission progress are atomic and idempotent.
- Duplicate receipt handling returns balance without preserving historical achievement response payloads.
- Roulette remains server-authoritative without a separate wallet persistence path.
- Craps stops syncing unresolved bet-placement state to the account wallet.
- Focused wallet tests, affected game tests, lint, formatting, build, and representative Playwright flows pass.
- Net implementation/test complexity decreases; no compatibility layer or settlement feature flags are introduced.
