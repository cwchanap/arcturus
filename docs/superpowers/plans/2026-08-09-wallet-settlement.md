# Small Wallet Settlement Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every casual single-player account chip-sync implementation with one small, idempotent wallet settlement use case and delete the retry/outbox/batching machinery that no longer serves the hobby-project architecture.

**Architecture:** `src/lib/wallet` owns the settlement contract, D1 repository, server use case, and one timed browser request helper. The active receipt table stays in `src/db/schema.ts` with the rest of the D1 schema. Client-authoritative games submit one settlement per completed event through `/api/wallet/settle`; Roulette keeps server-side RNG/bet validation and calls the same settlement use case directly. Browser recovery is intentionally limited to one in-memory failed command and a visible manual retry/reset path.

**Tech Stack:** Astro 5 SSR, Cloudflare Workers, Cloudflare D1, Drizzle ORM, TypeScript, Bun, Vitest/Miniflare where already used, Playwright, Wrangler 4.

## Global Constraints

- Keep one deployable Astro + Cloudflare Worker application.
- Follow the existing repository layout: domain code under `src/lib/<domain>`, active D1 tables in `src/db/schema.ts`.
- Do not introduce `src/modules`, a second schema home, a generic repository framework, event bus, ledger, or workflow engine.
- Use exactly one casual account-settlement application function: `settleWalletRound`.
- Use exactly one browser settlement endpoint for client-authoritative games: `POST /api/wallet/settle`.
- Roulette remains server-authoritative and calls `settleWalletRound` directly from `/api/roulette/spin`.
- A settlement command contains `settlementId`, `game`, `delta`, and `stats { rounds, wins, losses, biggestWin }` only.
- Do not send or retain `previousBalance`, `statsDelta`, retry metadata, canonical payload hashes, rate-limit metadata, or compatibility fields.
- `(userId, settlementId)` is idempotent; a duplicate returns the stored resulting balance and never reapplies balance, stats, or mission progress.
- Balance, receipt, game statistics, and direct mission progress commit atomically in one D1 batch.
- Achievement checks run only after a fresh settlement; duplicate settlement responses do not recreate historical achievement toasts.
- The wallet browser client uses the existing `fetchJsonWithTimeout` helper with a fixed timeout and performs no automatic retry.
- Browser code must not contain persisted settlement outboxes, background retry loops, balance-rebase loops, batching/coalescing coordinators, cross-tab ownership, unload beacons, or sync-election logic.
- A game may retain one failed command in memory for explicit manual retry while the page remains open.
- Do not start another authenticated play that depends on the unsettled balance until the current settlement succeeds or the game is reset/reloaded.
- Craps account settlement happens only when a roll resolves wagers; bet placement/clearing is local game state.
- Guest bankroll behavior remains local and does not use the wallet module.
- Roulette pending-spin reload recovery is removed with `roulette_round`; do not preserve it through another persistence mechanism.
- No backward compatibility, dual endpoint, payload adapter, receipt backfill, old localStorage migration, or feature flag.
- Do not refactor unrelated game rules. Existing payout/legality tests remain authoritative.

---

## Preflight: authoritative deletion and test inventory

Before editing runtime code, capture every old settlement surface. This list is intentionally broader than the first draft because E2E/bootstrap and helper files still teach the old contract.

- [ ] **Step 1: Capture the settlement grep**

```bash
git grep -nE \
  '/api/chips/update|chip_sync_receipt|roulette_round|ChipSyncCoordinator|KenoSyncOutbox|balance-sync-stats|balance-sync-state|balanceSync|syncLimits|previousBalance|statsDelta|pendingStats|pendingRollSyncs|syncPending|BALANCE_MISMATCH|RATE_LIMITED|sendBeacon|pendingSyncId|pendingSyncCreatedAt' \
  -- src e2e scripts drizzle CLAUDE.md README.md \
  | tee /tmp/hpa-545-sync-before.txt
```

- [ ] **Step 2: Classify every match**

Use exactly:

```text
DELETE
MIGRATE_TO_WALLET
KEEP_NON_SETTLEMENT
HISTORICAL_DOC_ONLY
```

No runtime, test, current guidance, migration, or E2E/bootstrap match may remain unclassified.

- [ ] **Step 3: Explicitly verify the known deletion set exists**

```bash
for path in \
  src/pages/api/chips/update.ts \
  src/lib/chip-sync-batch-sql.ts \
  src/lib/chips-update-api.test.ts \
  src/lib/chips-update.test.ts \
  src/lib/blackjack/balance-sync-stats.ts \
  src/lib/blackjack/balance-sync-stats.test.ts \
  src/lib/blackjack/balanceSyncStats.test.ts \
  src/lib/baccarat/balance-sync-state.ts \
  src/lib/baccarat/balance-sync-state.test.ts \
  src/lib/slots/chip-sync-coordinator.ts \
  src/lib/slots/chip-sync-coordinator.test.ts \
  src/lib/slots/balance-sync-state.ts \
  src/lib/slots/balance-sync-state.test.ts \
  src/lib/keno/outbox.ts \
  src/lib/keno/outbox.test.ts \
  src/lib/craps/balanceSync.ts \
  src/lib/craps/balanceSync.test.ts \
  src/lib/craps/syncLimits.ts \
  src/lib/roulette/spin-batch-sql.ts \
  src/lib/roulette/spin-cascade.integration.test.ts; do
  test -e "$path" || { echo "missing expected path: $path"; exit 1; }
done
```

- [ ] **Step 4: Pin the current rule and integration baselines**

```bash
bun test \
  src/lib/chips-update-api.test.ts \
  src/lib/chips-update.test.ts \
  src/lib/blackjack/blackjackClient.test.ts \
  src/lib/blackjack/balance-sync-stats.test.ts \
  src/lib/blackjack/balanceSyncStats.test.ts \
  src/lib/baccarat/balance-sync-state.test.ts \
  src/lib/poker/PokerGame.test.ts \
  src/lib/slots/chip-sync-coordinator.test.ts \
  src/lib/slots/balance-sync-state.test.ts \
  src/lib/keno/outbox.test.ts \
  src/lib/craps/balanceSync.test.ts \
  src/lib/roulette/spin-api.test.ts \
  src/lib/roulette/rouletteClient.test.ts
```

Record any pre-existing failures. Do not change game-rule expected values merely to make the settlement refactor pass.

---

## Final file shape

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/lib/wallet/types.ts` | Small settlement command/result contract |
| Create | `src/lib/wallet/repository.ts` | Concrete D1 receipt/balance/stats/mission batch |
| Create | `src/lib/wallet/repository.test.ts` | D1 idempotency/atomicity/concurrency coverage |
| Create | `src/lib/wallet/settle.ts` | Validation, duplicate lookup, bounded in-request retry, fresh achievement resolution |
| Create | `src/lib/wallet/settle.test.ts` | Application-service contract coverage |
| Create | `src/lib/wallet/client.ts` | Single `fetchJsonWithTimeout` POST helper; no retry policy |
| Create | `src/lib/wallet/client.test.ts` | Request/result/timeout/error contract coverage |
| Create | `src/lib/wallet/index.ts` | Browser-safe public exports |
| Create | `src/pages/api/wallet/settle.ts` | Thin authenticated HTTP adapter |
| Create | `src/pages/api/wallet/settle.test.ts` | Auth/JSON/status mapping coverage |
| Modify | `src/db/schema.ts` | Add `walletSettlement`; later remove old receipt/roulette tables |
| Modify | `src/lib/missions/progress.ts` | Gate atomic mission writes on `{ settlementId, attemptId }` |
| Modify | `src/lib/missions/progress.test.ts` | Wallet receipt gate and ungated-call coverage |
| Create | `drizzle/0016_wallet_settlement.sql` | Breaking receipt transition; no backfill |
| Delete | `src/pages/api/chips/update.ts` | Obsolete generic chip-sync endpoint |
| Delete | `src/lib/chip-sync-batch-sql.ts` | Obsolete old receipt/stats cascade helper |
| Delete | `src/lib/chips-update-api.test.ts` | Replaced by wallet route/repository tests |
| Delete | `src/lib/chips-update.test.ts` | Old endpoint helper tests |
| Modify | `src/lib/blackjack/blackjackClient.ts` | One settlement per completed round |
| Delete | `src/lib/blackjack/balance-sync-stats.ts` | Pending-stat aggregation |
| Delete | `src/lib/blackjack/balance-sync-stats.test.ts` | Old pending-stat tests |
| Delete | `src/lib/blackjack/balanceSyncStats.test.ts` | Duplicate legacy pending-stat tests |
| Modify | `src/lib/blackjack/blackjackClient.test.ts` | One-command/manual-retry/block-next-round coverage |
| Modify | `src/lib/baccarat/baccaratClient.ts` | One settlement per completed hand |
| Create | `src/lib/baccarat/baccaratClient.test.ts` | One-command/manual-retry/block-next-hand coverage |
| Delete | `src/lib/baccarat/balance-sync-state.ts` | Baccarat retry/pending state |
| Delete | `src/lib/baccarat/balance-sync-state.test.ts` | Obsolete helper tests |
| Modify | `src/lib/poker/PokerGame.ts` | Replace direct old endpoint transport with wallet client |
| Modify | `src/lib/poker/PokerGame.test.ts` | Completed-hand settlement tests |
| Modify | `src/lib/slots/slotsClient.ts` | One settlement per spin |
| Delete | `src/lib/slots/chip-sync-coordinator.ts` | Batching/retry coordinator |
| Delete | `src/lib/slots/chip-sync-coordinator.test.ts` | Coordinator-specific tests |
| Delete | `src/lib/slots/balance-sync-state.ts` | Obsolete balance-reconciliation state |
| Delete | `src/lib/slots/balance-sync-state.test.ts` | Obsolete state tests |
| Modify | existing Slots client tests | One-command/manual-retry/block-next-spin coverage |
| Modify | `src/lib/keno/kenoClient.ts` | One settlement per draw |
| Delete | `src/lib/keno/outbox.ts` | Persisted/cross-tab outbox |
| Delete | `src/lib/keno/outbox.test.ts` | Outbox-specific tests |
| Trim/delete | `src/lib/keno/review-regressions.test.ts` | Keep only non-outbox gameplay regressions |
| Create | `src/lib/craps/settlement.ts` | Pure resolved-roll command and available-balance helpers |
| Create | `src/lib/craps/settlement.test.ts` | Pure Craps settlement mapping/reconciliation tests |
| Modify | `src/pages/games/craps.astro` | Thin caller: settle resolved rolls only |
| Delete | `src/lib/craps/balanceSync.ts` | Roll batching/rebase helper |
| Delete | `src/lib/craps/balanceSync.test.ts` | Batch-specific tests |
| Delete | `src/lib/craps/syncLimits.ts` | Caps used only by old sync machinery |
| Modify | `src/pages/api/roulette/spin.ts` | Preserve RNG/bet validation; delegate account mutation |
| Modify | `src/lib/roulette/types.ts` | Remove pending settlement recovery fields |
| Modify | `src/lib/roulette/RouletteGame.ts` | Remove pending-sync persisted-state contract |
| Modify | `src/lib/roulette/rouletteClient.ts` | Remove persisted spin resubmission/replay flow |
| Modify | `src/lib/roulette/rouletteClient.test.ts` | Assert reset/no historical replay on duplicate/lost response |
| Modify/delete | `src/lib/roulette/rouletteClient.integration.test.ts` | Keep only behavior not tied to `roulette_round` recovery |
| Delete | `src/lib/roulette/spin-batch-sql.ts` | Obsolete duplicate settlement SQL |
| Delete | `src/lib/roulette/spin-cascade.integration.test.ts` | Old cascade test |
| Modify | `src/lib/roulette/spin-api.test.ts` | Wallet delegation/idempotency coverage |
| Modify | `src/server/cleanup.ts` and tests | Retain only wallet receipt cleanup needed by active schema |
| Modify | `e2e/global-setup.ts`, `e2e/isolated-page.ts` | Replace old endpoint fixture/bootstrap calls |
| Modify | `e2e/ranked-blackjack.spec.ts`, `e2e/authed-user-preservation.spec.ts`, `e2e/blackjack-split.spec.ts` | Replace old endpoint assumptions |
| Modify | current guidance such as `CLAUDE.md` | Point active architecture to wallet API/module |

Design reference: `docs/superpowers/specs/2026-08-09-wallet-settlement-design.md`.

---

## Delivery risks

| Risk | Required control |
|---|---|
| Two same-ID requests race and a loser sees the winner's receipt | Server-only `attemptId` gates stats/missions; concurrency test proves one application |
| New stats SQL silently changes biggest-win behavior | Port existing positive-candidate CASE semantics; regression proves push cannot erase prior win |
| Mission event loses required information | Derive all six `MissionGameEvent` fields, including `delta`; keep `roundsWon` win-count regression |
| Browser request hangs and permanently blocks next play | Reuse `fetchJsonWithTimeout` with fixed 15s timeout; no automatic retry |
| Craps page remains a second settlement implementation | Keep only pure Craps mapping/reconcile helpers in `src/lib/craps/settlement.ts`; page calls wallet client |
| Roulette table is deleted but browser still restores `pendingSyncId` | Remove types, restore/resubmit code, and recovery-only tests in the same task |
| E2E/bootstrap continues calling `/api/chips/update` | Expanded preflight/post-delete grep includes `e2e/global-setup.ts`, `e2e/isolated-page.ts`, ranked/authed/split specs |
| Destructive cleanup hides game-rule regression | Preserve pure game rules; run affected unit/E2E flows before and after deletion |
| Refactor simply relocates old complexity | Final complexity grep forbids old retry/outbox/rebase concepts in active casual wallet/game code |

---

### Task 1: Build the atomic wallet receipt and repository

**Files:**

- Create: `src/lib/wallet/types.ts`
- Create: `src/lib/wallet/repository.ts`
- Create: `src/lib/wallet/repository.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/lib/missions/progress.ts`
- Modify: `src/lib/missions/progress.test.ts`

**Interfaces:**

```ts
// src/lib/wallet/types.ts
import type { GameType } from '../game-stats/types';

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
// src/lib/wallet/repository.ts
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

- [ ] **Step 1: Add the contract and `walletSettlement` table**

Add the table directly to `src/db/schema.ts` beside the current settlement receipt:

```ts
export const walletSettlement = sqliteTable(
  'wallet_settlement',
  {
    userId: text('userId')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    settlementId: text('settlementId').notNull(),
    attemptId: text('attemptId').notNull(),
    balance: integer('balance').notNull(),
    createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.userId, table.settlementId] }),
    createdIdx: index('wallet_settlement_created_idx').on(table.createdAt),
  }),
);
```

Do not create `src/lib/wallet/schema.ts`. Do not remove `chipSyncReceipt` yet; Task 7 removes old schema only after every runtime caller is migrated.

- [ ] **Step 2: Write failing repository tests**

Start with:

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

Add fresh win, loss, push, stale expected-balance, and duplicate cases.

- [ ] **Step 3: Run the test and verify failure**

```bash
bun test src/lib/wallet/repository.test.ts
```

Expected: FAIL because the repository does not exist yet.

- [ ] **Step 4: Implement the guarded balance update and receipt**

The first two batch statements use:

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

Return `true` only when the guarded `user` update changed one row.

- [ ] **Step 5: Port the current stats accumulation semantics under the attempt gate**

Gate the upsert on:

```sql
EXISTS (
  SELECT 1 FROM wallet_settlement
  WHERE userId = ? AND settlementId = ? AND attemptId = ?
)
```

Use the current accumulation behavior:

```text
totalWins   += stats.wins
totalLosses += stats.losses
handsPlayed += stats.rounds
netProfit   += command.delta
```

For `biggestWin`, port the intent of `CHIP_SYNC_STATS_UPSERT_SQL`:

```sql
biggestWin = CASE
  WHEN excluded.biggestWin > 0 AND excluded.biggestWin > game_stats.biggestWin
    THEN excluded.biggestWin
  ELSE game_stats.biggestWin
END
```

Add a regression: after a stored biggest win of 250, a push with `biggestWin: 0` leaves 250.

- [ ] **Step 6: Mechanically change the mission gate**

In `src/lib/missions/progress.ts`, replace the receipt gate shape with:

```ts
export interface WalletSettlementGate {
  settlementId: string;
  attemptId: string;
}
```

Change the gated `EXISTS` fragment to:

```sql
WHERE EXISTS (
  SELECT 1 FROM wallet_settlement
  WHERE userId = ? AND settlementId = ? AND attemptId = ?
)
```

Keep ungated `applyMissionProgressBatch` behavior unchanged.

- [ ] **Step 7: Build the exact mission event in the repository**

Use all fields required by the existing type:

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

Call `prepareMissionProgressStatements` before `d1.batch`, then append its attempt-gated statements after the receipt insert/stats upsert.

Add a mission regression where `delta < 0` but `winsIncrement > 0`; an applicable `roundsWon` mission still increments by the win count. This protects mixed-outcome Craps rolls.

- [ ] **Step 8: Add concurrent duplicate coverage**

Run two attempts with the same `(userId, settlementId)` and distinct server-generated attempt IDs. Assert:

```text
one receipt row
one balance mutation
one stats increment
one mission increment
```

- [ ] **Step 9: Run focused tests**

```bash
bun test src/lib/wallet/repository.test.ts src/lib/missions/progress.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/wallet/types.ts src/lib/wallet/repository.ts \
  src/lib/wallet/repository.test.ts src/db/schema.ts \
  src/lib/missions/progress.ts src/lib/missions/progress.test.ts
git commit -m "feat(wallet): add atomic settlement repository"
```

---

### Task 2: Add the small settlement use case, route, and timed browser client

**Files:**

- Create: `src/lib/wallet/settle.ts`
- Create: `src/lib/wallet/settle.test.ts`
- Create: `src/lib/wallet/client.ts`
- Create: `src/lib/wallet/client.test.ts`
- Create: `src/lib/wallet/index.ts`
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
export const WALLET_SETTLEMENT_TIMEOUT_MS = 15_000;

export class WalletSettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletSettlementError';
  }
}

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

- [ ] **Step 2: Write duplicate and optimistic-conflict tests**

Assert:

```ts
const first = await settleWalletRound(d1, 'u1', command);
const duplicate = await settleWalletRound(d1, 'u1', command);
expect(first).toMatchObject({ balance: 1100, duplicate: false });
expect(duplicate).toEqual({ balance: 1100, duplicate: true });
```

Also simulate one unrelated balance write between read and batch: the use case rereads once and succeeds on its second in-request attempt. A second unrelated conflict returns one ordinary conflict error; there is no loop.

- [ ] **Step 3: Implement validation and bounded settlement**

Pseudo-flow must remain exactly:

```ts
validate(command);

for (let attempt = 0; attempt < 2; attempt++) {
  const receipt = await findWalletSettlement(d1, userId, command.settlementId);
  if (receipt) return { balance: receipt.balance, duplicate: true };

  const balance = await readWalletBalance(d1, userId);
  if (balance === null) throw new WalletSettlementDomainError('USER_NOT_FOUND');

  const nextBalance = balance + command.delta;
  if (!Number.isSafeInteger(nextBalance) || nextBalance < 0) {
    throw new WalletSettlementDomainError('INSUFFICIENT_BALANCE');
  }

  const attemptId = crypto.randomUUID();
  if (await applyWalletSettlementBatch(d1, {
    userId,
    attemptId,
    expectedBalance: balance,
    nextBalance,
    command,
    nowSeconds: Math.trunc(Date.now() / 1000),
  })) {
    // fresh path; achievements below
    break;
  }

  const racedReceipt = await findWalletSettlement(d1, userId, command.settlementId);
  if (racedReceipt) return { balance: racedReceipt.balance, duplicate: true };
}
```

After two failed unrelated optimistic attempts, throw `SETTLEMENT_CONFLICT`.

- [ ] **Step 4: Reuse existing achievement service only on the fresh path**

After the atomic batch succeeds:

```ts
const db = createDb(d1);
const earned = await checkAndGrantAchievements(db, userId, nextBalance, {
  recentWinAmount: command.stats.biggestWin > 0 ? command.stats.biggestWin : undefined,
  gameType: command.game,
});
```

Map the returned definitions to `{ id, name, icon }`. Do not persist this response on the receipt. A duplicate returns only `{ balance, duplicate: true }`.

- [ ] **Step 5: Implement the route as a thin adapter**

`src/pages/api/wallet/settle.ts` does only:

```text
require locals.user
require locals.runtime.env.DB
parse request JSON
call settleWalletRound(DB, locals.user.id, body)
map domain validation -> 400
map insufficient balance -> 409
map bounded conflict -> 409
map unexpected error -> 500
```

Do not put game-specific validation, retries, rate limits, stats SQL, or achievement logic in the route.

- [ ] **Step 6: Write the browser-client tests first**

Mock `fetchJsonWithTimeout` and assert:

```text
POST /api/wallet/settle
Content-Type application/json
body is exactly the SettleRoundCommand
one helper call only
success payload returned unchanged
timeout/AbortError -> WalletSettlementError
non-2xx -> WalletSettlementError
no retry after timeout or HTTP error
```

- [ ] **Step 7: Implement `submitWalletSettlement` using the existing timeout helper**

Use:

```ts
const { response, data } = await fetchJsonWithTimeout<SettleRoundResult | { message?: string }>(
  '/api/wallet/settle',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  },
  WALLET_SETTLEMENT_TIMEOUT_MS,
);
```

If `response.ok` is false, throw one `WalletSettlementError`. Do not catch and retry.

- [ ] **Step 8: Keep `index.ts` browser-safe**

Export `types` and browser `client` only. Do not export server repository/settle modules from the browser barrel.

- [ ] **Step 9: Run focused tests and build**

```bash
bun test src/lib/wallet src/pages/api/wallet/settle.test.ts
bun run build
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/lib/wallet src/pages/api/wallet/settle.ts src/pages/api/wallet/settle.test.ts
git commit -m "feat(wallet): add settlement use case and client"
```

---

### Task 3: Migrate Blackjack, Baccarat, and single-player Poker

**Files:**

- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/lib/blackjack/blackjackClient.test.ts`
- Delete: `src/lib/blackjack/balance-sync-stats.ts`
- Delete: `src/lib/blackjack/balance-sync-stats.test.ts`
- Delete: `src/lib/blackjack/balanceSyncStats.test.ts`
- Modify: `src/lib/baccarat/baccaratClient.ts`
- Create: `src/lib/baccarat/baccaratClient.test.ts`
- Delete: `src/lib/baccarat/balance-sync-state.ts`
- Delete: `src/lib/baccarat/balance-sync-state.test.ts`
- Modify: `src/lib/poker/PokerGame.ts`
- Modify: `src/lib/poker/PokerGame.test.ts`

**Consumes:** `submitWalletSettlement`, `SettleRoundCommand` from Task 2.

- [ ] **Step 1: Add failing Blackjack settlement tests**

For one completed normal hand, assert one command equivalent to:

```ts
{
  settlementId: expect.any(String),
  game: 'blackjack',
  delta: expectedRoundDelta,
  stats: {
    rounds: outcomes.length,
    wins: outcomes.filter((o) => o.result === 'win' || o.result === 'blackjack').length,
    losses: outcomes.filter((o) => o.result === 'loss').length,
    biggestWin: expectedLargestIndividualHandProfit,
  },
}
```

Add: failed settlement keeps the same command ID for manual retry and disables starting the next authenticated round until success/reset.

- [ ] **Step 2: Replace Blackjack's pending-stat/retry machinery**

Delete imports/state for pending stats, follow-up timers, rate-limit handling, current/previous balance rebasing, and old error classification. On round completion:

```text
compute one final command
call submitWalletSettlement once
on success adopt result.balance and clear pending command
on failure store that exact command in memory and show retry/reset state
```

Do not aggregate a later round into the failed command.

- [ ] **Step 3: Delete Blackjack sync-only helpers/tests and run focused tests**

```bash
rm src/lib/blackjack/balance-sync-stats.ts \
  src/lib/blackjack/balance-sync-stats.test.ts \
  src/lib/blackjack/balanceSyncStats.test.ts
bun test src/lib/blackjack
```

Expected: PASS.

- [ ] **Step 4: Create failing Baccarat client tests**

There is no existing `baccaratClient.test.ts`; create it. Assert one completed hand sends:

```ts
{
  settlementId: expect.any(String),
  game: 'baccarat',
  delta: expectedDelta,
  stats: {
    rounds: 1,
    wins: expectedDelta > 0 ? 1 : 0,
    losses: expectedDelta < 0 ? 1 : 0,
    biggestWin: Math.max(expectedDelta, 0),
  },
}
```

Also assert manual retry reuses the same command and next authenticated hand is blocked while pending.

- [ ] **Step 5: Replace Baccarat pending/retry state and delete its helper**

Remove `balance-sync-state.ts`, exponential follow-up behavior, balance mismatch recovery, and old endpoint transport. Keep game rules/UI behavior outside settlement unchanged.

```bash
rm src/lib/baccarat/balance-sync-state.ts src/lib/baccarat/balance-sync-state.test.ts
bun test src/lib/baccarat
```

Expected: PASS.

- [ ] **Step 6: Add Poker settlement assertions before editing `PokerGame`**

Cover both:

```text
human folds -> one loss command when the hand's human delta is negative
showdown -> one command based on final human chips - humanChipsBefore
```

The command uses `rounds: 1`, outcome counts from the sign of the final human delta, and positive human delta as `biggestWin`.

- [ ] **Step 7: Replace Poker's direct old-endpoint fetch**

Keep `PokerGame`'s existing game flow. Replace only settlement transport/state with `submitWalletSettlement`. On failure keep one pending command and do not auto-deal another authenticated hand until success/reset.

- [ ] **Step 8: Run focused tests and build**

```bash
bun test src/lib/blackjack src/lib/baccarat src/lib/poker/PokerGame.test.ts
bun run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/blackjack src/lib/baccarat src/lib/poker/PokerGame.ts src/lib/poker/PokerGame.test.ts
git commit -m "refactor(games): use wallet settlement for card games"
```

---

### Task 4: Migrate Slots and Keno and delete durable/browser sync policies

**Files:**

- Modify: `src/lib/slots/slotsClient.ts`
- Modify: existing Slots client tests
- Delete: `src/lib/slots/chip-sync-coordinator.ts`
- Delete: `src/lib/slots/chip-sync-coordinator.test.ts`
- Delete: `src/lib/slots/balance-sync-state.ts`
- Delete: `src/lib/slots/balance-sync-state.test.ts`
- Modify: `src/lib/keno/kenoClient.ts`
- Delete: `src/lib/keno/outbox.ts`
- Delete: `src/lib/keno/outbox.test.ts`
- Modify/delete: `src/lib/keno/review-regressions.test.ts`

- [ ] **Step 1: Add failing Slots client assertions**

One finished spin sends exactly:

```ts
{
  settlementId: spin.syncId,
  game: 'slots',
  delta: spin.netDelta,
  stats: {
    rounds: 1,
    wins: spin.netDelta > 0 ? 1 : 0,
    losses: spin.netDelta < 0 ? 1 : 0,
    biggestWin: Math.max(spin.netDelta, 0),
  },
}
```

Assert there is no batching across spins, no pagehide flush, and a failed command blocks the next authenticated spin until retry/reset.

- [ ] **Step 2: Replace Slots coordinator usage and delete sync-only files**

Remove `ChipSyncCoordinator`, timer/backoff dependencies, coalescing state, unload beacon, and balance-rebase state.

```bash
rm src/lib/slots/chip-sync-coordinator.ts \
  src/lib/slots/chip-sync-coordinator.test.ts \
  src/lib/slots/balance-sync-state.ts \
  src/lib/slots/balance-sync-state.test.ts
bun test src/lib/slots
```

Expected: PASS.

- [ ] **Step 3: Add failing Keno client assertions**

One completed draw sends one command using the draw's stable sync ID. Assert:

```text
no localStorage outbox key
no tab-id/heartbeat key
no orphan scan/drain
failed command retained only in memory
next authenticated draw blocked until retry/reset
```

- [ ] **Step 4: Replace Keno outbox usage and delete outbox files**

Delete `KenoSyncOutbox`, `getTabId`, heartbeat/orphan recovery, persisted drain state, sync-paused recovery UI whose only purpose was durable settlement recovery, and old endpoint error classification.

```bash
rm src/lib/keno/outbox.ts src/lib/keno/outbox.test.ts
```

Trim `review-regressions.test.ts` to gameplay regressions that still exist; delete tests whose subject is the removed outbox/rebase contract.

- [ ] **Step 5: Run focused tests and build**

```bash
bun test src/lib/slots src/lib/keno
bun run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/slots src/lib/keno
git commit -m "refactor(games): simplify slots and keno settlement"
```

---

### Task 5: Make Craps resolved-roll settlement explicit and testable

**Files:**

- Create: `src/lib/craps/settlement.ts`
- Create: `src/lib/craps/settlement.test.ts`
- Modify: `src/pages/games/craps.astro`
- Delete: `src/lib/craps/balanceSync.ts`
- Delete: `src/lib/craps/balanceSync.test.ts`
- Delete: `src/lib/craps/syncLimits.ts`
- Modify: `e2e/craps.spec.ts` as needed for the new failure UX

**Interfaces:**

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

- [ ] **Step 1: Write failing pure mapping tests**

Construct a `RollResult` with no `win | lose | push` evaluation and assert:

```ts
expect(buildCrapsSettlementCommand('roll-1', result)).toBeNull();
```

Construct a mixed roll with two wins, one loss, and one continuing wager. Assert:

```ts
expect(buildCrapsSettlementCommand('roll-2', result)).toEqual({
  settlementId: 'roll-2',
  game: 'craps',
  delta: result.netDelta,
  stats: {
    rounds: 3,
    wins: 2,
    losses: 1,
    biggestWin: grossWinningPayout,
  },
});
```

`grossWinningPayout` is the sum of positive payout amounts for winning evaluations, preserving the current mixed-outcome-roll biggest-win intent.

- [ ] **Step 2: Write failing available-balance tests**

```ts
expect(getAvailableCrapsBalance(1_000, 250)).toBe(750);
expect(getAvailableCrapsBalance(1_000, 0)).toBe(1_000);
expect(() => getAvailableCrapsBalance(100, 150)).toThrow();
```

Use safe non-negative integers only.

- [ ] **Step 3: Implement only these pure helpers**

Do not create a Craps settlement service/client abstraction. The helpers map Craps domain data to the shared wallet command and reconcile wallet balance with still-active local bets.

- [ ] **Step 4: Remove bet-placement/refund account sync from the page**

Delete `syncBalance()` calls from:

```text
place bet
add odds
clear/refund bets
other unresolved local bet mutations
```

Those operations change only the local `CrapsGame` available balance/active-bet state.

- [ ] **Step 5: Settle only after a roll resolves wagers**

After `game.roll()`:

```ts
const command = buildCrapsSettlementCommand(makeSettlementId(), result);
if (command && shouldSyncAccountChips({ isGuestMode })) {
  const settled = await submitWalletSettlement(command);
  const available = getAvailableCrapsBalance(settled.balance, game.getTotalAtRisk());
  game.setBalance(available);
}
```

On failure retain `command` in memory, block another authenticated roll, and show retry/reset. Guest mode keeps existing local bankroll behavior.

- [ ] **Step 6: Remove old session state that exists only for settlement recovery**

Delete:

```text
pendingRollSyncs
isSyncInProgress
syncPending
pendingRetryScheduled
retryDelayMs
dropped-roll-sync persistence
server previous-balance/rebase bookkeeping
```

An unfinished authenticated table may reset on reload. Do not recreate pending settlement persistence.

- [ ] **Step 7: Delete obsolete Craps sync files**

```bash
rm src/lib/craps/balanceSync.ts src/lib/craps/balanceSync.test.ts src/lib/craps/syncLimits.ts
```

- [ ] **Step 8: Run focused tests and E2E**

```bash
bun test src/lib/craps
bunx playwright test e2e/craps.spec.ts
bun run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/craps src/pages/games/craps.astro e2e/craps.spec.ts
git commit -m "refactor(craps): settle resolved rolls only"
```

---

### Task 6: Delegate Roulette wallet writes and delete historical spin recovery

**Files:**

- Modify: `src/pages/api/roulette/spin.ts`
- Modify: `src/lib/roulette/spin-api.test.ts`
- Modify: `src/lib/roulette/types.ts`
- Modify: `src/lib/roulette/RouletteGame.ts`
- Modify: `src/lib/roulette/RouletteGame.test.ts`
- Modify: `src/lib/roulette/rouletteClient.ts`
- Modify: `src/lib/roulette/rouletteClient.test.ts`
- Modify/delete: `src/lib/roulette/rouletteClient.integration.test.ts`
- Delete: `src/lib/roulette/spin-batch-sql.ts`
- Delete: `src/lib/roulette/spin-cascade.integration.test.ts`

- [ ] **Step 1: Pin server-authoritative behavior in route tests**

Keep assertions that the route validates bets and generates/evaluates the winning number on the server. Add a mocked wallet dependency and assert a valid spin delegates:

```ts
await settleWalletRound(d1, userId, {
  settlementId: syncId,
  game: 'roulette',
  delta: netDelta,
  stats: {
    rounds: 1,
    wins: netDelta > 0 ? 1 : 0,
    losses: netDelta < 0 ? 1 : 0,
    biggestWin: Math.max(netDelta, 0),
  },
});
```

Do not move RNG or bet evaluation into the browser.

- [ ] **Step 2: Define the new duplicate response contract**

A duplicate wallet settlement means the monetary effect already happened, but `roulette_round` no longer exists to reconstruct a number. Return a response shape that includes:

```ts
{
  duplicate: true,
  newBalance: walletResult.balance,
}
```

and omits a fabricated `winningNumber`/`results` historical payload. A fresh response retains the normal winning-number/result fields.

- [ ] **Step 3: Replace the route cascade with `settleWalletRound`**

Delete direct `user` balance mutation, old receipt SQL, separate stats SQL, rate-limit map, achievement-payload replay, and `roulette_round` writes. Keep only Roulette request validation, RNG, bet evaluation, result construction, and wallet delegation.

- [ ] **Step 4: Write failing browser recovery-deletion tests**

Assert restored/persisted Roulette state no longer contains:

```text
pendingSyncId
pendingSyncCreatedAt
```

Assert reload does not automatically resubmit a previously `spinning` snapshot.

Assert a duplicate response:

```text
adopts newBalance
clears unresolved active/spinning settlement state
returns to betting
shows no invented historical number
```

- [ ] **Step 5: Remove the persisted pending-spin recovery implementation**

From `types.ts`, `RouletteGame.ts`, and `rouletteClient.ts`, delete:

```text
pendingSyncId / pendingSyncCreatedAt
PENDING_SPIN_MAX_AGE_MS recovery use
restoreSession spinRecovery result
recoverPendingSpin
applyRecoverySettlement
recovery-specific retry/rejection branches
historical replay achievement handling
```

Keep ordinary current-page spin timeout/error handling only where it is still needed for the live `/api/roulette/spin` request. Do not replace reload recovery with another storage key.

- [ ] **Step 6: Delete old Roulette cascade helpers/tests**

```bash
rm src/lib/roulette/spin-batch-sql.ts src/lib/roulette/spin-cascade.integration.test.ts
```

Trim/delete `rouletteClient.integration.test.ts` cases that exist solely for `roulette_round`/pendingSync resurrection.

- [ ] **Step 7: Run focused tests and E2E**

```bash
bun test src/lib/roulette
bunx playwright test e2e/roulette.spec.ts
bun run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/pages/api/roulette/spin.ts src/lib/roulette e2e/roulette.spec.ts
git commit -m "refactor(roulette): share wallet settlement"
```

---

### Task 7: Remove the old endpoint/schema and update fixtures, cleanup, and current guidance

**Files:**

- Create: `drizzle/0016_wallet_settlement.sql`
- Modify: `src/db/schema.ts`
- Delete: `src/pages/api/chips/update.ts`
- Delete: `src/lib/chip-sync-batch-sql.ts`
- Delete: `src/lib/chips-update-api.test.ts`
- Delete: `src/lib/chips-update.test.ts`
- Modify: `src/server/cleanup.ts` and tests
- Modify: `e2e/global-setup.ts`
- Modify: `e2e/isolated-page.ts`
- Modify: `e2e/ranked-blackjack.spec.ts`
- Modify: `e2e/authed-user-preservation.spec.ts`
- Modify: `e2e/blackjack-split.spec.ts`
- Modify: other fresh grep matches in current tests/fixtures/guidance
- Modify: `CLAUDE.md` if it still documents the old endpoint as active

- [ ] **Step 1: Write the destructive migration**

`drizzle/0016_wallet_settlement.sql` must create the minimal new table and remove disposable old receipt/replay data. Use the project's actual current table names from `src/db/schema.ts`/migrations. The resulting active schema is equivalent to:

```sql
CREATE TABLE wallet_settlement (
  userId TEXT NOT NULL,
  settlementId TEXT NOT NULL,
  attemptId TEXT NOT NULL,
  balance INTEGER NOT NULL,
  createdAt INTEGER NOT NULL,
  PRIMARY KEY (userId, settlementId),
  FOREIGN KEY (userId) REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX wallet_settlement_created_idx ON wallet_settlement(createdAt);

DROP TABLE IF EXISTS chip_sync_receipt;
DROP TABLE IF EXISTS roulette_round;
```

No `INSERT ... SELECT` backfill is allowed.

- [ ] **Step 2: Remove old tables from `src/db/schema.ts`**

Delete the active `chipSyncReceipt` and `rouletteRound` definitions/exports after Task 6 no longer imports them. Keep `walletSettlement` in this one schema file.

- [ ] **Step 3: Replace cleanup behavior**

Remove cleanup branches that exist only for `chip_sync_receipt`/`roulette_round`. If wallet receipts retain the existing bounded retention policy, target only `wallet_settlement.createdAt`; do not preserve old per-table recovery semantics.

- [ ] **Step 4: Update E2E/bootstrap callers of the old endpoint**

For each old POST used to seed or mutate a test account, choose the smallest valid replacement:

```text
wallet settlement API when the test intentionally exercises casual account settlement
DB/bootstrap helper when the test merely needs fixture balance and is not testing settlement
```

Do not make ranked tests depend on a fake casual game event solely to seed a balance when their existing fixture bootstrap can update test data directly.

Explicitly inspect:

```text
e2e/global-setup.ts
e2e/isolated-page.ts
e2e/ranked-blackjack.spec.ts
e2e/authed-user-preservation.spec.ts
e2e/blackjack-split.spec.ts
```

- [ ] **Step 5: Delete old endpoint/test/helper files**

```bash
rm src/pages/api/chips/update.ts \
  src/lib/chip-sync-batch-sql.ts \
  src/lib/chips-update-api.test.ts \
  src/lib/chips-update.test.ts
```

- [ ] **Step 6: Run the authoritative post-delete grep**

```bash
git grep -nE \
  '/api/chips/update|chip_sync_receipt|roulette_round|ChipSyncCoordinator|KenoSyncOutbox|balance-sync-stats|balance-sync-state|balanceSync|syncLimits|previousBalance|statsDelta|pendingStats|pendingRollSyncs|BALANCE_MISMATCH|RATE_LIMITED|sendBeacon|pendingSyncId|pendingSyncCreatedAt' \
  -- src e2e scripts drizzle CLAUDE.md README.md \
  | tee /tmp/hpa-545-sync-after.txt
```

Expected runtime/current-test/current-guidance matches:

```text
wallet implementation references to its own settlementId/attemptId only
historical migration text only where required by the destructive DROP
unrelated use of generic words such as previousBalance only if classified KEEP_NON_SETTLEMENT
```

Every remaining line must have a written classification. There must be no active caller of `/api/chips/update`, no `pendingSyncId` Roulette recovery, and no old sync-only helper import.

- [ ] **Step 7: Recreate the local hobby DB and migrate**

Use the repository's existing DB setup scripts rather than adding a migration framework:

```bash
rm -rf .wrangler/state
bun run setup:db
bun run db:migrate:local
```

If `setup:db` already applies migrations, follow its current behavior and do not duplicate work merely to satisfy this command list.

- [ ] **Step 8: Run the full unit/integration suite and build**

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

Expected: PASS.

- [ ] **Step 9: Commit**

Stage only the reviewed HPA-545 deletion/migration/guidance surface and commit:

```bash
git commit -m "refactor(wallet): remove legacy chip sync"
```

---

### Task 8: End-to-end verification and complexity acceptance gate

**Files:**

- Modify only affected E2E specs where assertions need to reflect the intentional manual-retry/reset behavior.
- No new runtime architecture is allowed in this task.

- [ ] **Step 1: Run focused authenticated game journeys**

```bash
bunx playwright test \
  e2e/public-single-player-games.spec.ts \
  e2e/slots.spec.ts \
  e2e/keno.spec.ts \
  e2e/craps.spec.ts \
  e2e/roulette.spec.ts \
  e2e/blackjack-split.spec.ts
```

Run the existing Baccarat/Poker authenticated specs returned by:

```bash
git grep -lE 'baccarat|/games/poker' e2e/*.spec.ts
```

Exclude multiplayer-only Poker specs from the wallet acceptance set.

- [ ] **Step 2: Run the fixture-sensitive flows**

```bash
bunx playwright test \
  e2e/ranked-blackjack.spec.ts \
  e2e/authed-user-preservation.spec.ts
```

These do not become wallet features; this verifies their setup no longer relies on the deleted endpoint.

- [ ] **Step 3: Run the entire repository verification gate**

```bash
bun run test
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

Expected: PASS, subject only to already-documented environment-specific skips.

- [ ] **Step 4: Verify the architecture actually got smaller**

Run:

```bash
git diff --stat main...HEAD
git diff --numstat main...HEAD | awk '{ add += $1; del += $2 } END { print "added=" add, "deleted=" del, "net=" add-del }'
```

Then audit active code:

```bash
git grep -nE \
  'retry|backoff|outbox|heartbeat|orphan|sendBeacon|BALANCE_MISMATCH|RATE_LIMITED|previousBalance|pendingSyncId|pendingRollSyncs|syncPending' \
  -- src/lib/wallet src/lib/blackjack src/lib/baccarat src/lib/slots src/lib/keno src/lib/craps src/lib/roulette src/lib/poker src/pages/api/wallet src/pages/api/roulette src/pages/games/craps.astro
```

Review every hit. Allowed examples are user-facing wording such as **Retry settlement** or unrelated game behavior. Disallowed hits include:

```text
a generic retry strategy in wallet
persistent settlement queues
balance rebase loops
cross-tab settlement ownership
unload settlement flushing
Roulette pending-spin persistence
per-game transport compatibility flags
```

If the refactor adds a configurable abstraction that reproduces old policies, HPA-545 is not complete even if tests pass.

- [ ] **Step 5: Verify current architecture docs**

```bash
git grep -n '/api/chips/update' -- CLAUDE.md README.md src e2e
```

Expected: no active/current usage.

Historical dated specs/plans may keep old references because they describe prior architecture.

- [ ] **Step 6: Record destructive deployment notes in the implementation PR**

State explicitly:

```text
old chip_sync_receipt and roulette_round data are discarded
old browser settlement state is not migrated
local/hobby-remote D1 must be recreated or migrated destructively before deploy
there is no old-client compatibility window
```

- [ ] **Step 7: Final commit if E2E-only corrections were needed**

```bash
git commit -m "test(wallet): verify settlement migration"
```

Skip this commit when verification required no file changes.

---

## Definition of complete implementation

The implementation branch is ready only when all of these are true:

- `src/lib/wallet` is the only casual authenticated account-settlement implementation.
- `src/db/schema.ts` is still the single active schema home and contains the minimal `walletSettlement` table.
- `/api/chips/update`, `chip_sync_receipt`, and `roulette_round` are gone from active runtime/schema.
- `src/lib/blackjack/balance-sync-stats.ts`, Baccarat/Slots balance-sync helpers, Slots coordinator, Keno outbox, Craps balanceSync/syncLimits, and Roulette second cascade are deleted.
- `MissionGameEvent` mapping includes `delta` and uses the existing mission semantics.
- Existing positive-only biggest-win behavior is preserved under the new stats gate.
- The wallet browser client uses `fetchJsonWithTimeout` and has no retry policy.
- Baccarat has a real client settlement test rather than a reference to a nonexistent test file.
- Craps settlement mapping/reconciliation is testable outside the Astro page; bet placement/clearing is local only.
- Roulette no longer persists/resubmits `pendingSyncId` after reload and does not invent a historical wheel result on a duplicate.
- E2E/bootstrap/current guidance no longer posts `/api/chips/update`.
- No casual game contains a persisted settlement outbox, batching coordinator, background retry loop, balance-rebase loop, unload settlement flush, or receipt replay protocol.
- Balance, receipt, statistics, and direct mission progress are atomic and idempotent.
- Focused tests, full tests, lint, formatting, build, and representative/full Playwright gates pass.
- Net code/test complexity decreases and no repository-wide structural migration is introduced.
