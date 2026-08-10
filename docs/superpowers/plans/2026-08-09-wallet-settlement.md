# Small Wallet Settlement Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every casual single-player account chip-sync implementation with one small, idempotent wallet settlement use case and delete the retry/outbox/batching machinery that no longer serves the hobby-project architecture.

**Architecture:** `src/modules/wallet` owns the settlement contract, D1 receipt, atomic balance/stat/mission batch, browser request helper, and server use case. Client-authoritative games submit one settlement per completed event through `/api/wallet/settle`; Roulette keeps server-side RNG/bet validation and calls the same server use case directly. Browser recovery is intentionally limited to one in-memory failed command and a visible manual retry/reset path.

**Tech Stack:** Astro 5 SSR, Cloudflare Workers, Cloudflare D1, Drizzle ORM, TypeScript, Bun, Vitest/Miniflare where already used, Playwright, Wrangler 4.

## Global Constraints

- Keep one deployable Astro + Cloudflare Worker application.
- Use exactly one casual account-settlement application function: `settleWalletRound`.
- Use exactly one browser settlement endpoint for client-authoritative games: `POST /api/wallet/settle`.
- Roulette remains server-authoritative and calls `settleWalletRound` directly from `/api/roulette/spin`.
- A settlement command contains `settlementId`, `game`, `delta`, and `stats { rounds, wins, losses, biggestWin }` only.
- Do not send or retain `previousBalance`, `statsDelta`, retry metadata, canonical payload hashes, rate-limit metadata, or compatibility fields.
- `(userId, settlementId)` is idempotent; a duplicate returns the stored resulting balance and never reapplies balance, stats, or mission progress.
- Balance, receipt, game statistics, and direct mission progress commit atomically in one D1 batch.
- Achievement checks run only after a fresh settlement; duplicate settlement responses do not recreate historical achievement toasts.
- Browser code must not contain persisted settlement outboxes, background retry loops, balance-rebase loops, batching/coalescing coordinators, cross-tab ownership, unload beacons, or sync-election logic.
- A game may retain one failed command in memory for an explicit manual retry while the page remains open.
- Do not start another authenticated round/spin/draw that depends on the unsettled balance until the current settlement succeeds or the game is reset/reloaded.
- Craps account settlement happens only when a roll resolves wagers; bet placement/clearing is local game state.
- Guest bankroll behavior remains local and does not use the wallet module.
- No backward compatibility, dual endpoint, payload adapter, receipt backfill, old localStorage migration, or feature flag.
- Do not build a generic ledger, event bus, repository framework, workflow engine, or configurable per-game settlement strategy.
- Do not refactor unrelated game rules. Existing payout/legality tests remain authoritative.

---

## Preflight: pin the deletion surface

Before editing runtime code, capture an authoritative inventory so no legacy sync path survives accidentally.

- [ ] Run:

```bash
git grep -nE \
  '/api/chips/update|chip_sync_receipt|ChipSyncCoordinator|KenoSyncOutbox|previousBalance|statsDelta|pendingStats|pendingRollSyncs|syncPending|BALANCE_MISMATCH|RATE_LIMITED|sendBeacon' \
  -- src e2e scripts drizzle CLAUDE.md README.md \
  | tee /tmp/hpa-545-sync-before.txt
```

- [ ] Classify every runtime/test/config match as `DELETE`, `MIGRATE_TO_WALLET`, or `KEEP_NON_SETTLEMENT`. Historical files under `docs/superpowers/` may remain historical unless they are used as current developer guidance.

- [ ] Pin the current relevant tests before changes:

```bash
bun test \
  src/lib/chips-update-api.test.ts \
  src/lib/blackjack/blackjackClient.test.ts \
  src/lib/poker/PokerGame.test.ts \
  src/lib/slots/chip-sync-coordinator.test.ts \
  src/lib/keno/outbox.test.ts \
  src/lib/craps/balanceSync.test.ts \
  src/lib/roulette/spin-api.test.ts
```

Record failures that already exist; do not rewrite game-rule expectations to make the refactor pass.

---

## Final file shape

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/modules/wallet/types.ts` | Small settlement command/result contract |
| Create | `src/modules/wallet/schema.ts` | `wallet_settlement` Drizzle table |
| Create | `src/modules/wallet/repository.ts` | Concrete D1 receipt/balance/stats/mission batch |
| Create | `src/modules/wallet/repository.test.ts` | D1 idempotency/atomicity/concurrency coverage |
| Create | `src/modules/wallet/settle.ts` | Validation, duplicate lookup, bounded in-request retry, fresh achievement resolution |
| Create | `src/modules/wallet/settle.test.ts` | Application-service contract coverage |
| Create | `src/modules/wallet/client.ts` | Single browser POST helper; no retry policy |
| Create | `src/modules/wallet/client.test.ts` | Request/result/error contract coverage |
| Create | `src/modules/wallet/index.ts` | Browser-safe public exports |
| Create | `src/pages/api/wallet/settle.ts` | Thin authenticated HTTP adapter |
| Create | `src/pages/api/wallet/settle.test.ts` | Auth/JSON/status mapping coverage |
| Modify | `src/db/schema.ts` | Remove old receipt/roulette settlement tables and export wallet schema |
| Modify | `src/lib/missions/progress.ts` | Gate atomic mission writes on fresh wallet attempt identity |
| Modify | `src/lib/missions/progress.test.ts` | Wallet receipt gate coverage |
| Create | `drizzle/0016_wallet_settlement.sql` | Destructive wallet receipt schema transition; no data backfill |
| Delete | `src/pages/api/chips/update.ts` | Obsolete generic chip-sync endpoint |
| Delete | `src/lib/chip-sync-batch-sql.ts` | Obsolete receipt/stats SQL shared by old paths |
| Delete | `src/lib/chips-update-api.test.ts` | Obsolete endpoint tests, replaced by wallet contract tests |
| Modify | `src/lib/blackjack/blackjackClient.ts` | One settlement per completed round |
| Modify | `src/lib/blackjack/blackjackClient.test.ts` | One-command/no-overlap settlement tests |
| Modify | `src/lib/baccarat/baccaratClient.ts` | One settlement per completed hand |
| Modify | existing Baccarat client tests | Settlement boundary coverage |
| Modify | `src/lib/poker/PokerGame.ts` | Replace direct chip-sync machinery with one completed-hand settlement |
| Modify | `src/lib/poker/PokerGame.test.ts` | Completed-hand settlement tests |
| Modify | `src/lib/slots/slotsClient.ts` | One settlement per spin |
| Delete | `src/lib/slots/chip-sync-coordinator.ts` | Batching/retry coordinator |
| Delete | `src/lib/slots/chip-sync-coordinator.test.ts` | Coordinator-specific tests |
| Delete | `src/lib/slots/balance-sync-state.ts` | Obsolete balance-reconciliation state |
| Modify | existing Slots client tests | One-command/no-overlap settlement tests |
| Modify | `src/lib/keno/kenoClient.ts` | One settlement per draw |
| Delete | `src/lib/keno/outbox.ts` | Persisted/cross-tab outbox |
| Delete | `src/lib/keno/outbox.test.ts` | Outbox-specific tests |
| Review/delete or trim | `src/lib/keno/review-regressions.test.ts` | Keep only non-outbox gameplay regressions |
| Modify | `src/pages/games/craps.astro` | Settle resolved rolls only; no bet-placement sync |
| Delete | `src/lib/craps/balanceSync.ts` | Roll batching/rebase helper |
| Delete | `src/lib/craps/balanceSync.test.ts` | Batch-specific tests |
| Add/modify | focused Craps client/page test | Resolved-roll wallet contract |
| Modify | `src/pages/api/roulette/spin.ts` | Preserve RNG/bet validation; delegate wallet write |
| Delete | `src/lib/roulette/spin-batch-sql.ts` | Obsolete duplicate settlement SQL |
| Delete | `src/lib/roulette/spin-cascade.integration.test.ts` | Old cascade test |
| Modify | `src/lib/roulette/spin-api.test.ts` | Wallet-delegation and duplicate coverage |
| Modify | `src/server/cleanup.ts` and test if applicable | Replace old receipt/roulette cleanup with wallet receipt retention |
| Modify | current architecture guidance containing old endpoint references | Point developers to wallet module |

Design reference: `docs/superpowers/specs/2026-08-09-wallet-settlement-design.md`.

---

### Task 1: Build the atomic wallet receipt and repository

**Files:**

- Create: `src/modules/wallet/types.ts`
- Create: `src/modules/wallet/schema.ts`
- Create: `src/modules/wallet/repository.ts`
- Create: `src/modules/wallet/repository.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/lib/missions/progress.ts`
- Modify: `src/lib/missions/progress.test.ts`

**Interfaces:**

```ts
// src/modules/wallet/types.ts
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
  newAchievements?: Array<{ id: string; name: string; icon: string }>;
}
```

```ts
// src/modules/wallet/repository.ts
export interface WalletSettlementReceipt {
  balance: number;
  attemptId: string;
}

export async function findWalletSettlement(
  d1: D1Database,
  userId: string,
  settlementId: string,
): Promise<WalletSettlementReceipt | null>;

export async function readWalletBalance(
  d1: D1Database,
  userId: string,
): Promise<number | null>;

export async function applyWalletSettlementBatch(
  d1: D1Database,
  args: {
    userId: string;
    attemptId: string;
    expectedBalance: number;
    nextBalance: number;
    command: SettleRoundCommand;
    nowSeconds: number;
  },
): Promise<boolean>;
```

- [ ] **Step 1: Add the wallet contract and receipt schema**

Define `walletSettlement` in `src/modules/wallet/schema.ts` with exactly:

```ts
userId: text('userId').notNull(),
settlementId: text('settlementId').notNull(),
attemptId: text('attemptId').notNull(),
balance: integer('balance').notNull(),
createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
```

Use primary key `(userId, settlementId)` and an index on `createdAt`. Do not add payload JSON, game type, delta, warnings, achievement payload, status, or retry columns.

Re-export `walletSettlement` from `src/db/schema.ts`; remove `chipSyncReceipt` from the active schema in Task 7, after callers have migrated.

- [ ] **Step 2: Write failing receipt/idempotency tests**

In `repository.test.ts`, create a minimal migrated D1 fixture and assert:

```ts
const command: SettleRoundCommand = {
  settlementId: 'round-1',
  game: 'blackjack',
  delta: 100,
  stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 100 },
};

expect(await readWalletBalance(d1, 'u1')).toBe(1_000);
expect(await findWalletSettlement(d1, 'u1', 'round-1')).toBeNull();
```

Add cases for a fresh apply, a duplicate apply, a loss, a zero-delta push, and a stale expected balance.

- [ ] **Step 3: Run the focused test and verify failure**

```bash
bun test src/modules/wallet/repository.test.ts
```

Expected: FAIL because repository functions do not exist yet.

- [ ] **Step 4: Implement the guarded balance update and fresh receipt**

The first two batch statements must have this shape:

```sql
UPDATE user
SET chipBalance = ?, updatedAt = ?
WHERE id = ?
  AND chipBalance = ?
  AND NOT EXISTS (
    SELECT 1 FROM wallet_settlement
    WHERE userId = ? AND settlementId = ?
  );
```

then:

```sql
INSERT INTO wallet_settlement (userId, settlementId, attemptId, balance, createdAt)
SELECT ?, ?, ?, ?, ?
WHERE changes() = 1;
```

Return `true` only when the guarded user update changed one row.

- [ ] **Step 5: Gate statistics by the fresh `attemptId`**

Append one `game_stats` upsert only for:

```sql
EXISTS (
  SELECT 1 FROM wallet_settlement
  WHERE userId = ? AND settlementId = ? AND attemptId = ?
)
```

Apply:

```text
totalWins    += stats.wins
totalLosses  += stats.losses
handsPlayed  += stats.rounds
biggestWin    = MAX(existing.biggestWin, stats.biggestWin)
netProfit    += command.delta
```

- [ ] **Step 6: Replace the mission receipt gate**

Change the mission prepared-statement gate from `{ syncId }` / `chip_sync_receipt` to:

```ts
interface WalletSettlementGate {
  settlementId: string;
  attemptId: string;
}
```

and gate each mission statement on:

```sql
EXISTS (
  SELECT 1 FROM wallet_settlement
  WHERE userId = ? AND settlementId = ? AND attemptId = ?
)
```

Update `prepareMissionProgressStatements` so a wallet caller can provide the fresh gate for the current user. Ungated callers such as `applyMissionProgressBatch` keep their existing behavior.

- [ ] **Step 7: Add a concurrent duplicate regression**

Issue two repository/application attempts with the same `(userId, settlementId)` but different server-generated `attemptId` values. Assert exactly one receipt attempt ID wins and balance/stats/mission progress change once.

This test is the reason `attemptId` exists; do not replace it with a payload hash or client-visible token.

- [ ] **Step 8: Run focused tests**

```bash
bun test src/modules/wallet/repository.test.ts src/lib/missions/progress.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/wallet/types.ts src/modules/wallet/schema.ts \
  src/modules/wallet/repository.ts src/modules/wallet/repository.test.ts \
  src/db/schema.ts src/lib/missions/progress.ts src/lib/missions/progress.test.ts
git commit -m "feat(wallet): add atomic settlement repository"
```

---

### Task 2: Add the small settlement use case, route, and browser client

**Files:**

- Create: `src/modules/wallet/settle.ts`
- Create: `src/modules/wallet/settle.test.ts`
- Create: `src/modules/wallet/client.ts`
- Create: `src/modules/wallet/client.test.ts`
- Create: `src/modules/wallet/index.ts`
- Create: `src/pages/api/wallet/settle.ts`
- Create: `src/pages/api/wallet/settle.test.ts`

**Interfaces:**

```ts
export async function settleWalletRound(
  d1: D1Database,
  userId: string,
  command: SettleRoundCommand,
): Promise<SettleRoundResult>;
```

```ts
export class WalletSettlementError extends Error {}

export async function submitWalletSettlement(
  command: SettleRoundCommand,
): Promise<SettleRoundResult>;
```

- [ ] **Step 1: Write validation tests**

Cover:

```text
settlementId empty or >128 -> reject
unknown game -> reject
unsafe integer -> reject
rounds < 1 -> reject
wins/losses negative -> reject
wins + losses > rounds -> reject
biggestWin < 0 -> reject
resulting balance < 0 -> reject
```

Do not reintroduce per-game win/loss caps.

- [ ] **Step 2: Write duplicate and conflict tests**

Assert:

```ts
const first = await settleWalletRound(d1, 'u1', command);
const duplicate = await settleWalletRound(d1, 'u1', command);
expect(first).toMatchObject({ balance: 1100, duplicate: false });
expect(duplicate).toEqual({ balance: 1100, duplicate: true });
```

Add one test where the first guarded update loses to an unrelated balance write and the second in-request attempt succeeds. Add one test where two consecutive unrelated writes defeat both attempts and the use case returns one ordinary conflict error.

- [ ] **Step 3: Implement `settleWalletRound` with at most two write attempts**

Pseudo-flow:

```ts
const existing = await findWalletSettlement(d1, userId, command.settlementId);
if (existing) return { balance: existing.balance, duplicate: true };

for (let attempt = 0; attempt < 2; attempt++) {
  const balance = await readWalletBalance(d1, userId);
  if (balance === null) throw new WalletSettlementDomainError('User not found');

  const nextBalance = balance + command.delta;
  if (nextBalance < 0) throw new WalletSettlementDomainError('Insufficient chips');

  const applied = await applyWalletSettlementBatch(d1, {
    userId,
    attemptId: crypto.randomUUID(),
    expectedBalance: balance,
    nextBalance,
    command,
    nowSeconds: Math.trunc(Date.now() / 1000),
  });

  if (applied) {
    // fresh achievement resolution below
  }

  const racedReceipt = await findWalletSettlement(d1, userId, command.settlementId);
  if (racedReceipt) return { balance: racedReceipt.balance, duplicate: true };
}

throw new WalletSettlementDomainError('Wallet changed concurrently; retry settlement');
```

Do not add sleep/backoff.

- [ ] **Step 4: Resolve achievements only for a fresh settlement**

After a fresh batch, reuse `createDb(d1)` and `checkAndGrantAchievements`. Derive recent win amount from `stats.biggestWin` first, otherwise positive `delta`. Obtain any rank required by existing achievement rules using the existing game-stat read API after the commit.

Return `newAchievements` only when fresh and non-empty. If achievement checking fails, log once and still return the successful wallet balance; do not persist a replay payload.

- [ ] **Step 5: Implement the HTTP adapter**

`src/pages/api/wallet/settle.ts` does only:

```text
authenticate locals.user
parse JSON
obtain D1 binding
call settleWalletRound
map validation/insufficient/conflict errors to 400/409
return SettleRoundResult JSON
```

Do not copy game limits, rate limiting, receipt comparison, mission SQL, or achievement replay into the route.

- [ ] **Step 6: Implement the browser client**

`submitWalletSettlement` performs one fetch to `/api/wallet/settle`. On non-2xx, parse the server message when available and throw one `WalletSettlementError`. There is no retry option argument and no timeout/backoff state.

- [ ] **Step 7: Keep the barrel browser-safe**

`src/modules/wallet/index.ts` exports only shared types plus `submitWalletSettlement` and `WalletSettlementError`. Server code imports `settleWalletRound` from `src/modules/wallet/settle.ts` directly so browser bundles do not pull D1 code.

- [ ] **Step 8: Run tests and build**

```bash
bun test src/modules/wallet src/pages/api/wallet/settle.test.ts
bun run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/modules/wallet src/pages/api/wallet/settle.ts src/pages/api/wallet/settle.test.ts
git commit -m "feat(wallet): expose round settlement API"
```

---

### Task 3: Migrate Blackjack, Baccarat, and Poker to one completed-event settlement

**Files:**

- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/lib/blackjack/blackjackClient.test.ts`
- Modify: `src/lib/baccarat/baccaratClient.ts`
- Modify: existing Baccarat client tests returned by `git grep -l "baccaratClient" src -- '*test.ts'`
- Modify: `src/lib/poker/PokerGame.ts`
- Modify: `src/lib/poker/PokerGame.test.ts`

**Produces:** every completed authenticated Blackjack/Baccarat/Poker play creates exactly one `SettleRoundCommand`; no next authenticated play begins while that command is unresolved.

- [ ] **Step 1: Add one-command tests before deleting old sync code**

For each game, mock `submitWalletSettlement` and assert one completion creates one command with a stable settlement ID and correct net delta/stats.

Blackjack split example:

```ts
expect(command.stats).toEqual({
  rounds: outcomes.length,
  wins: outcomes.filter((o) => o.result === 'win' || o.result === 'blackjack').length,
  losses: outcomes.filter((o) => o.result === 'loss').length,
  biggestWin: expectedLargestHandProfit,
});
```

Poker must use the existing `humanChipsBefore` hand baseline so fold-outs, side pots, and showdown all settle the human's final net result exactly once.

- [ ] **Step 2: Verify tests fail against the old transport**

```bash
bun test \
  src/lib/blackjack/blackjackClient.test.ts \
  src/lib/poker/PokerGame.test.ts \
  $(git grep -l "baccaratClient" src -- '*test.ts')
```

Expected: new assertions fail because callers still use `/api/chips/update`/old sync state.

- [ ] **Step 3: Simplify Blackjack**

Delete the pending-stat accumulator, `serverSyncedBalance` delta aggregation, sync lock, follow-up sync counter, scheduled retry timer, rate-limit handling, balance mismatch handling, and sync-ID reuse logic.

At round completion:

1. build one settlement ID;
2. compute the completed round's net delta from the round baseline;
3. submit one command;
4. update game/display balance from `result.balance`;
5. dispatch returned fresh achievements;
6. enable **New Round** only after success.

On failure, keep that one command in memory and expose the existing status/new-round surface as **Retry settlement** or require reload/reset; do not schedule retry.

- [ ] **Step 4: Simplify Baccarat**

Apply the same lifecycle: one hand baseline, one settlement ID, one command, no next authenticated hand until settlement success. Remove pending-stat/backoff/rebase/error-classification state. Keep guest bankroll behavior untouched.

- [ ] **Step 5: Simplify Poker**

Replace the current direct `fetch('/api/chips/update')` path behind `syncChips` with a completed-hand settlement helper using `submitWalletSettlement`.

Rules:

- human fold-out settles once as a loss;
- human sole-survivor win settles once;
- showdown uses `players[0].chips - humanChipsBefore`;
- `stats.rounds = 1` for the human hand;
- `wins/losses` follow the final human result;
- do not auto-deal the next authenticated hand until settlement succeeds;
- guest auto-deal stays local.

Do not move poker rules out of `PokerGame` as part of HPA-545.

- [ ] **Step 6: Run focused game tests**

```bash
bun test \
  src/lib/blackjack/blackjackClient.test.ts \
  src/lib/poker/PokerGame.test.ts \
  $(git grep -l "baccaratClient" src -- '*test.ts')
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/blackjack src/lib/baccarat src/lib/poker/PokerGame.ts src/lib/poker/PokerGame.test.ts
git commit -m "refactor(games): use wallet settlement for card games"
```

---

### Task 4: Delete Slots and Keno synchronization subsystems

**Files:**

- Modify: `src/lib/slots/slotsClient.ts`
- Modify: existing Slots client tests
- Delete: `src/lib/slots/chip-sync-coordinator.ts`
- Delete: `src/lib/slots/chip-sync-coordinator.test.ts`
- Delete: `src/lib/slots/balance-sync-state.ts`
- Delete: any test dedicated only to `balance-sync-state.ts`
- Modify: `src/lib/keno/kenoClient.ts`
- Modify: `src/lib/keno/kenoClient.test.ts`
- Delete: `src/lib/keno/outbox.ts`
- Delete: `src/lib/keno/outbox.test.ts`
- Review/delete or trim: `src/lib/keno/review-regressions.test.ts`

- [ ] **Step 1: Add direct settlement tests**

Slots: one completed `SpinResult` sends one command with `rounds: 1`, final net delta, one win/loss/push classification, and the spin's biggest win.

Keno: one completed draw sends one command with `rounds: 1` and a settlement ID generated once for that draw.

Both tests must assert a second spin/draw is disabled while settlement is unresolved.

- [ ] **Step 2: Simplify Slots client**

Replace `ChipSyncCoordinator` construction and callbacks with direct `submitWalletSettlement`. Remove coalescing, network/rate-limit give-up callbacks, `sendBeacon`, and `pagehide` flush.

The existing spin lock remains a gameplay/UI lock; extend its authenticated completion boundary until settlement returns so overlapping wallet commands cannot be created.

- [ ] **Step 3: Delete Slots sync-only files**

Delete the coordinator, balance-sync state, and tests that specify retry/coalescing implementation. Preserve `SlotsGame`, renderer, payout, settings, and gameplay tests.

- [ ] **Step 4: Simplify Keno client**

Delete:

```text
TAB_ID_KEY
heartbeat keys/timers
outbox localStorage scan
orphan absorption
KenoSyncOutbox
persisted drain state
sync-paused recovery loop
```

After a draw reveal, submit one command. Keep the draw locked until settlement succeeds. A failed command may remain only in memory for the existing retry UI; refresh discards it.

- [ ] **Step 5: Delete Keno outbox tests, retain gameplay regressions only**

If `review-regressions.test.ts` contains both gameplay and outbox cases, move/keep only rules/UI regressions that still describe the simplified product. Do not preserve tests solely to assert cross-tab/outbox behavior.

- [ ] **Step 6: Run focused tests**

```bash
bun test src/lib/slots src/lib/keno
```

Expected: PASS with no coordinator/outbox test files.

- [ ] **Step 7: Commit**

```bash
git add -A src/lib/slots src/lib/keno
git commit -m "refactor(games): remove slots and keno sync machinery"
```

---

### Task 5: Make Craps settle resolved wager economics only

**Files:**

- Modify: `src/pages/games/craps.astro`
- Delete: `src/lib/craps/balanceSync.ts`
- Delete: `src/lib/craps/balanceSync.test.ts`
- Modify: `src/lib/craps/CrapsGame.test.ts` only if a wallet-facing balance helper needs a pure regression
- Add/modify: the smallest existing DOM/client test that covers the Craps page settlement callback

**Important balance invariant:** the server wallet balance includes chips currently represented by active Craps bets, while `CrapsGame.getBalance()` represents chips available outside those bets. After a successful wallet settlement:

```ts
const availableBalance = result.balance - game.getTotalAtRisk();
```

Use that value to reconcile the displayed game balance. If it is negative, reset the authenticated table from the authoritative wallet balance instead of adding recovery machinery.

- [ ] **Step 1: Add failing settlement-boundary tests**

Cover all three behaviors:

```text
place bet -> no wallet request
clear refundable bet -> no wallet request
roll with zero resolved wagers -> no wallet request
roll with N resolved wagers -> exactly one wallet request
```

For a resolving roll assert:

```ts
command.delta === result.netDelta
command.stats.rounds === resolvedWagers
command.stats.wins === rollWins
command.stats.losses === rollLosses
command.stats.biggestWin === grossWinAmount
```

- [ ] **Step 2: Remove account sync from bet placement and clearing**

Delete calls to `syncBalance()` from bet-zone clicks, odds placement, and clear-bet actions. These operations already move chips between `chipBalance` and `activeBets` locally; the account wallet has not changed economically yet.

- [ ] **Step 3: Replace roll batching with one settlement**

Delete:

```text
lastSyncedBalance
isSyncInProgress
syncPending
pendingRetryScheduled
pendingRollSyncs
retryDelayMs
PersistedDroppedRollSyncs
buildCrapsSyncBatch
scheduled retry logic
```

After a roll, if `resolvedWagers > 0`, build one settlement command using the roll result and await it before allowing another authenticated roll.

- [ ] **Step 4: Reconcile available balance without a rebase loop**

On success:

```ts
const available = result.balance - game.getTotalAtRisk();
if (available < 0 || !game.setBalance(available)) {
  game.reset(result.balance);
  showMessage('Table reset because the account balance changed in another session.', 'info');
}
```

On ordinary settlement error, retain only the current command in memory and provide manual retry/reload. Do not persist it.

- [ ] **Step 5: Simplify authenticated session persistence**

Do not restore old pending settlements. Keep guest session/bankroll persistence. For authenticated state, either retain only safely reconstructable table presentation or reset unfinished table state on reload; choose the smaller implementation. No old localStorage conversion is allowed.

- [ ] **Step 6: Delete `balanceSync.ts` and its tests**

No replacement batching helper is created.

- [ ] **Step 7: Run Craps tests**

```bash
bun test src/lib/craps
bunx playwright test e2e/craps.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add -A src/pages/games/craps.astro src/lib/craps
git commit -m "refactor(craps): settle resolved rolls through wallet"
```

---

### Task 6: Keep Roulette server-authoritative but remove its second settlement stack

**Files:**

- Modify: `src/pages/api/roulette/spin.ts`
- Modify: `src/lib/roulette/spin-api.test.ts`
- Delete: `src/lib/roulette/spin-batch-sql.ts`
- Delete: `src/lib/roulette/spin-cascade.integration.test.ts`
- Modify: Roulette client/page code only where duplicate response handling currently assumes replayed round data

**Consumes:** `settleWalletRound(d1, userId, command)` from Task 2.

- [ ] **Step 1: Pin server-authoritative roulette tests**

Before editing, preserve tests proving:

```text
bets are validated server-side
winning number is generated server-side
payout is calculated server-side
invalid bets never settle wallet
same settlement ID never changes wallet twice
```

Delete expectations whose only purpose is replaying `roulette_round` payloads or achievement caches.

- [ ] **Step 2: Write a failing wallet-delegation test**

Inject/mock `settleWalletRound` in the route test and assert a valid spin creates:

```ts
{
  settlementId: syncId,
  game: 'roulette',
  delta: evaluatedNetDelta,
  stats: {
    rounds: 1,
    wins: evaluatedNetDelta > 0 ? 1 : 0,
    losses: evaluatedNetDelta < 0 ? 1 : 0,
    biggestWin: Math.max(evaluatedNetDelta, 0),
  },
}
```

The route still returns the server-generated winning number for a fresh request.

- [ ] **Step 3: Replace the cascade**

After normal bet validation, RNG, and payout evaluation, call `settleWalletRound` instead of hand-building user/receipt/stats SQL. Remove `SPIN_*` SQL imports, receipt payload caching, local rate-limit map, canonical replay comparison, and achievement replay code.

- [ ] **Step 4: Define duplicate response behavior**

If `settleWalletRound` returns `duplicate: true`, do not generate a second winning number and do not apply the delta again. Return a response that tells the browser the balance is already settled and that the historical spin result is unavailable after retry, then reset to the next spin.

Do not retain `roulette_round` solely to recover this rare response-loss case.

- [ ] **Step 5: Delete Roulette settlement SQL/cascade tests**

Keep bet evaluator, RNG, game/UI tests, and the route tests that verify normal server-authoritative behavior.

- [ ] **Step 6: Run Roulette tests**

```bash
bun test src/lib/roulette
bunx playwright test e2e/roulette.spec.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A src/pages/api/roulette/spin.ts src/lib/roulette src/pages/games/roulette.astro
git commit -m "refactor(roulette): delegate settlement to wallet"
```

---

### Task 7: Remove the old endpoint, receipt schema, and compatibility surface

**Files:**

- Delete: `src/pages/api/chips/update.ts`
- Delete: `src/lib/chip-sync-batch-sql.ts`
- Delete: `src/lib/chips-update-api.test.ts`
- Modify: `src/db/schema.ts`
- Create: `drizzle/0016_wallet_settlement.sql`
- Modify: `src/server/cleanup.ts`
- Modify: `src/server/cleanup.test.ts`
- Modify: live docs/config references found by preflight grep
- Delete or update: obsolete E2E mocks/intercepts that still target `/api/chips/update`

- [ ] **Step 1: Confirm no runtime caller remains**

```bash
git grep -n "/api/chips/update" -- src e2e ':!docs/superpowers/**'
```

Expected before deletion: only obsolete endpoint/tests/docs references. If a game caller remains, return to its migration task rather than adding an adapter.

- [ ] **Step 2: Delete the legacy endpoint and helper SQL**

Delete `/api/chips/update`, `chip-sync-batch-sql.ts`, and endpoint-specific tests. Do not leave a redirect or compatibility handler.

- [ ] **Step 3: Replace active schema**

Remove `chipSyncReceipt` and `rouletteRound` from `src/db/schema.ts`. Keep `walletSettlement` as the single casual wallet receipt.

`drizzle/0016_wallet_settlement.sql` must be destructive and explicit:

```sql
DROP TABLE IF EXISTS chip_sync_receipt;
DROP TABLE IF EXISTS roulette_round;

CREATE TABLE wallet_settlement (
  userId text NOT NULL,
  settlementId text NOT NULL,
  attemptId text NOT NULL,
  balance integer NOT NULL,
  createdAt integer NOT NULL,
  PRIMARY KEY (userId, settlementId)
);

CREATE INDEX wallet_settlement_created_idx
  ON wallet_settlement (createdAt);
```

Match the exact quoting/naming conventions generated by the repository's current Drizzle migrations.

- [ ] **Step 4: Update cleanup**

Replace receipt cleanup for old settlement tables with retention of `wallet_settlement` only. Do not add a generic retention registry.

- [ ] **Step 5: Remove obsolete browser storage references**

Use the preflight inventory to delete old Keno outbox/heartbeat, Craps dropped-sync, Slots coordinator, and any other settlement recovery keys. Do not read/migrate them.

- [ ] **Step 6: Run a post-delete grep**

```bash
git grep -nE \
  '/api/chips/update|chip_sync_receipt|ChipSyncCoordinator|KenoSyncOutbox|BALANCE_MISMATCH|RATE_LIMITED|statsDelta|previousBalance' \
  -- src e2e scripts CLAUDE.md README.md \
  || true
```

Expected: no active settlement implementation references. Any retained identifier must be demonstrably unrelated or historical.

- [ ] **Step 7: Recreate the local hobby database and run migrations**

Use the repository's normal local setup/reset flow, then:

```bash
bun run db:migrate:local
```

Do not write a receipt data migration.

- [ ] **Step 8: Run tests/build**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(wallet): remove legacy chip sync surface"
```

---

### Task 8: Prove the user journeys and document the breaking reset

**Files:**

- Modify only affected E2E specs/mocks that still encode the old endpoint contract:
  - `e2e/public-single-player-games.spec.ts`
  - `e2e/slots.spec.ts`
  - `e2e/keno.spec.ts`
  - `e2e/craps.spec.ts`
  - `e2e/roulette.spec.ts`
  - existing Blackjack/Baccarat/Poker E2E specs returned by `git grep -lE 'blackjack|baccarat|poker' e2e -- '*.spec.ts'`
- Modify: `README.md` or `CLAUDE.md` only if current setup/architecture guidance needs the wallet endpoint/reset note

- [ ] **Step 1: Update E2E network expectations**

Where an E2E test intercepts `/api/chips/update`, change it to `/api/wallet/settle` and assert the four-field command shape. Do not add test-only compatibility endpoints.

Roulette continues to call `/api/roulette/spin`; its E2E should verify the visible fresh spin path rather than transport uniformity.

- [ ] **Step 2: Add one manual-retry user-flow assertion**

Use the smallest existing authenticated game E2E—prefer Keno or Slots—to force one `/api/wallet/settle` failure, verify the next round remains blocked, then retry the same settlement ID successfully. This proves the allowed in-memory recovery model without reintroducing a queue.

- [ ] **Step 3: Run the representative affected E2E set**

```bash
bunx playwright test \
  e2e/public-single-player-games.spec.ts \
  e2e/slots.spec.ts \
  e2e/keno.spec.ts \
  e2e/craps.spec.ts \
  e2e/roulette.spec.ts
```

Then run any directly affected Blackjack/Baccarat/Poker specs discovered above.

- [ ] **Step 4: Run the full verification gate**

```bash
bun run test
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

Expected: PASS.

- [ ] **Step 5: Verify complexity was actually deleted**

Review `git diff --stat main...HEAD` and the post-delete grep. HPA-545 fails its architectural goal if the implementation merely relocates the old retry/outbox/rebase state under `src/modules/wallet`.

Specifically confirm there is no replacement for:

```text
Keno persisted outbox / heartbeat
Slots batching coordinator / unload beacon
Blackjack follow-up retry state
Craps roll batching / dropped-sync persistence
client previousBalance rebasing
achievement response replay cache
roulette_round replay persistence
/api/chips/update compatibility
```

- [ ] **Step 6: Record the deployment reset**

The implementation PR must state that old receipt/spin rows and pending browser settlement state are intentionally discarded and the hobby D1 database should be recreated before applying the current migration set. Do not add a data backfill.

- [ ] **Step 7: Commit final test/docs adjustments**

```bash
git add -A
git commit -m "test(wallet): verify simplified settlement flows"
```

---

## Final self-review checklist

Before marking HPA-545 implemented, verify every item directly:

- [ ] `src/modules/wallet` has one clear settlement use case and concrete D1 repository, not a framework.
- [ ] All casual authenticated wallet mutations flow through `settleWalletRound`.
- [ ] Client-authoritative games use `/api/wallet/settle`; Roulette remains server-authoritative.
- [ ] Receipt identity is `(userId, settlementId)` and fresh batch effects are guarded by server `attemptId`.
- [ ] Balance, receipt, stats, and mission writes are one D1 batch.
- [ ] Duplicate settlement returns stored balance and does not replay achievement payloads.
- [ ] No game starts overlapping authenticated settlement-dependent rounds.
- [ ] Craps no longer syncs bet placement/refunds and correctly subtracts active at-risk bets when reconciling available balance.
- [ ] `/api/chips/update`, `chip_sync_receipt`, and `roulette_round` are absent from active runtime/schema.
- [ ] No persisted settlement outbox, backoff loop, background drain, cross-tab ownership, or balance-rebase loop remains.
- [ ] Guest game behavior still bypasses account settlement.
- [ ] No backward compatibility or data migration was added.
- [ ] Focused tests, full unit/integration tests, lint, format, build, and representative/full E2E gates pass.
