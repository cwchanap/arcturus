# Small Wallet Settlement Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace every casual single-player account chip-sync implementation with one small idempotent wallet settlement use case, one tiny shared in-memory failure gate, and deletion of old retry/outbox/batching/recovery machinery.

**Architecture:** `src/lib/wallet` owns settlement types/IDs, D1 repository, server use case, one timed browser submit function, and one in-memory pending/retry gate. Active D1 tables remain in `src/db/schema.ts`. Client-authoritative games use `/api/wallet/settle`; Roulette remains server-authoritative and calls `settleWalletRound` from `/api/roulette/spin`. During migration, mission prepared statements temporarily support both the old chip receipt and the new wallet receipt so every intermediate commit remains correct; the old branch is deleted with `/api/chips/update`.

**Tech Stack:** Astro 5 SSR, Cloudflare Workers, Cloudflare D1, Drizzle ORM, TypeScript, Bun, Vitest/Miniflare where already used, Playwright, Wrangler 4.

## Global constraints

- Keep domain code under `src/lib/<domain>` and active tables in `src/db/schema.ts`.
- Do not introduce `src/modules`, a second schema home, generic repository/event/workflow abstractions, or a configurable settlement framework.
- Final account settlement function is exactly `settleWalletRound`.
- Final client-authoritative endpoint is exactly `POST /api/wallet/settle`.
- Roulette stays server-authoritative.
- Settlement command fields are exactly `settlementId`, `game`, `delta`, and `stats { rounds, wins, losses, biggestWin }`.
- Settlement ID matches `/^[A-Za-z0-9_-]{1,128}$/` and is generated once per event; manual retry reuses the same command/ID.
- Keep one global `MAX_ABSOLUTE_SETTLEMENT_DELTA = 1_000_000`; delete the per-game cap table/rate limiter.
- The global cap is a sanity bound, not anti-cheat. Do not add additional leaderboard hardening in this ticket.
- `(userId, settlementId)` is idempotent; server-only `attemptId` gates stats/missions for the fresh winning request.
- Balance, receipt, stats, and direct mission progress commit atomically.
- Achievement checks run only after a fresh settlement; duplicate response does not recreate old toasts.
- Browser submit uses existing `fetchJsonWithTimeout` with one fixed timeout and no automatic retry.
- Browser failure policy is shared by `createSettlementGate`; games must not copy pending/retry state machines.
- No persisted settlement queue, background retry/backoff, balance rebase loop, cross-tab election, Web Locks, unload beacon, or old storage migration.
- Guest bankroll remains local and does not use wallet settlement.
- Craps settles only resolved wagers; bet placement/clearing is local.
- Roulette `pendingSyncId` reload resurrection is deleted with `roulette_round`.
- No backward-compatible old endpoint/schema/payload support remains in the final tree.
- Preserve pure game-rule behavior; do not rewrite payout/legality expectations to accommodate the refactor.

---

## Preflight: authoritative inventory and behavior baseline

### Step 1: generate the real file inventory

- [ ] Run from current `main` before editing:

```bash
git grep -lE \
  '/api/chips/update|chip_sync_receipt|roulette_round|ChipSyncCoordinator|KenoSyncOutbox|balance-sync-stats|balance-sync-state|balanceSync|syncLimits|previousBalance|statsDelta|pendingStats|pendingRollSyncs|syncPending|BALANCE_MISMATCH|RATE_LIMITED|sendBeacon|pendingSyncId|pendingSyncCreatedAt|PENDING_SPIN_MAX_AGE_MS' \
  -- src e2e scripts drizzle wrangler.toml CLAUDE.md README.md \
  | sort -u > /tmp/hpa-545-files.txt
```

- [ ] Create `/tmp/hpa-545-classified.tsv` with one line per path:

```text
<path><TAB>DELETE
<path><TAB>MIGRATE_TO_WALLET
<path><TAB>KEEP_NON_SETTLEMENT
<path><TAB>HISTORICAL_ONLY
```

- [ ] Verify no path was missed or invented:

```bash
cut -f1 /tmp/hpa-545-classified.tsv | sort -u > /tmp/hpa-545-classified-files.txt
diff -u /tmp/hpa-545-files.txt /tmp/hpa-545-classified-files.txt
```

Expected: no diff. Do not begin Task 1 until the sets are identical.

### Step 2: explicitly check known high-risk omissions

- [ ] Verify each currently present path has a classification:

```bash
for path in \
  src/pages/games/baccarat.astro \
  src/lib/baccarat/baccaratClient.ts \
  src/lib/baccarat/index.ts \
  src/lib/baccarat/balance-sync-state.ts \
  src/lib/baccarat/balance-sync-state.test.ts \
  src/lib/keno/index.ts \
  src/lib/keno/outbox.ts \
  src/lib/roulette/spin-error-classification.ts \
  src/lib/roulette/spin-error-classification.test.ts \
  src/lib/roulette/constants.ts \
  src/lib/blackjack/constants.ts \
  scripts/setup-local-db.ts \
  e2e/global-setup.ts \
  e2e/isolated-page.ts \
  e2e/public-single-player-games.spec.ts \
  e2e/slots.spec.ts \
  e2e/roulette.spec.ts \
  e2e/craps.spec.ts \
  e2e/ranked-blackjack.spec.ts \
  e2e/authed-user-preservation.spec.ts \
  e2e/blackjack-split.spec.ts; do
  test ! -e "$path" || grep -Fq "$path" /tmp/hpa-545-classified.tsv || {
    echo "unclassified high-risk path: $path"; exit 1;
  }
done
```

### Step 3: pin current behavior

- [ ] Run:

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

Record only pre-existing failures. Existing game-rule expected values are authoritative.

---

## Final file shape

| Action | Path | Responsibility |
|---|---|---|
| Create | `src/lib/wallet/types.ts` | Settlement command/result |
| Create | `src/lib/wallet/settlement-id.ts` | ID regex + generation |
| Create | `src/lib/wallet/repository.ts` | Concrete D1 batch + rows-affected normalization |
| Create | `src/lib/wallet/settle.ts` | Validation/idempotency/bounded conflict retry/achievements |
| Create | `src/lib/wallet/client.ts` | One timed POST, no retry |
| Create | `src/lib/wallet/settlement-gate.ts` | One in-memory pending/block/manual-retry state machine |
| Create | wallet tests beside each module | Shared contract/state tests |
| Create | `src/pages/api/wallet/settle.ts` + test | Thin authenticated adapter |
| Modify | `src/db/schema.ts` | Add wallet receipt, later remove old receipt/Roulette table |
| Modify | `src/lib/missions/progress.ts` + test | Temporary fixed dual receipt gate, then wallet-only |
| Create | `src/lib/baccarat/settlement.ts` + test | Pure live-page Baccarat command builder |
| Delete | `src/lib/baccarat/baccaratClient.ts` | Dead runtime client |
| Modify | `src/lib/baccarat/index.ts` | Remove dead client export |
| Modify | `src/pages/games/baccarat.astro` | Live Baccarat settlement migration |
| Create | `src/lib/craps/settlement.ts` + test | Resolved-roll command + available-balance math |
| Modify | all other current game callers | Use wallet command + shared gate |
| Modify | Roulette route/client/types/tests | Server wallet delegation + delete replay recovery |
| Create | destructive wallet migration | No backfill |
| Delete | old endpoint/cascade/outbox/coordinator/rebase helpers/tests | Remove old architecture |
| Modify | generated E2E/bootstrap/setup/current-guidance inventory | Remove old contract assumptions |

Design reference: `docs/superpowers/specs/2026-08-09-wallet-settlement-design.md`.

---

## Delivery risks

| Risk | Required control |
|---|---|
| Same-ID loser sees winner receipt and applies effects | `attemptId` gate + concurrency test |
| Zero-delta duplicate matches unchanged balance | `NOT EXISTS(wallet_settlement)` in guarded update |
| Task 1 disables all existing mission progress | temporary fixed `ReceiptGate` union; old branch stays until old endpoint deletion |
| Plan edits dead Baccarat code | migrate `baccarat.astro`; delete dead `BaccaratClient` + barrel export |
| Six games reimplement retry/block policy | one `createSettlementGate` tested once |
| Retry mints a different ID | one `newSettlementId(game)` helper; gate retains exact command |
| Browser request hangs | `fetchJsonWithTimeout`, fixed 15 seconds, no auto retry |
| New global client settlement can write enormous values | fixed ±1,000,000 sanity bound; no per-game table |
| Biggest win resets on push | preserve positive-only CASE semantics |
| Roulette unexpectedly changes mission pacing | explicitly intentional + route/integration test |
| Roulette table removed but pending-spin resurrection remains | remove types/client/error branches/tests atomically |
| Keno outbox deleted but barrel still exports it | modify `src/lib/keno/index.ts` in same task |
| Old endpoint references survive in fixtures/setup | exact generated file classification + final set comparison |
| Ranked cross-tab test loses its semantic casual mutation | replace with `/api/wallet/settle`, not DB bootstrap |
| Complexity gate becomes too noisy and skipped | scan wallet + changed files only |

---

# Task 1: Add wallet identity, receipt repository, and migration-safe mission gate

**Files:**

- Create: `src/lib/wallet/types.ts`
- Create: `src/lib/wallet/settlement-id.ts`
- Create: `src/lib/wallet/repository.ts`
- Create: `src/lib/wallet/repository.test.ts`
- Create: `src/lib/wallet/settlement-id.test.ts`
- Modify: `src/db/schema.ts`
- Modify: `src/lib/missions/progress.ts`
- Modify: `src/lib/missions/progress.test.ts`
- Modify: `src/pages/api/chips/update.ts` only to keep its old mission gate working during migration

**Produces:**

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
  newAchievements?: Array<{ id: string; name: string; icon: string }>;
}

export const SETTLEMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
export function newSettlementId(game: GameType): string;

export type ReceiptGate =
  | { kind: 'chip-sync'; syncId: string }
  | { kind: 'wallet'; settlementId: string; attemptId: string };
```

### Step 1: write ID tests

- [ ] Add tests:

```ts
expect(SETTLEMENT_ID_RE.test('blackjack-123_ABC')).toBe(true);
expect(SETTLEMENT_ID_RE.test('bad id')).toBe(false);
expect(SETTLEMENT_ID_RE.test('x'.repeat(129))).toBe(false);
expect(newSettlementId('blackjack')).toMatch(/^blackjack-[A-Za-z0-9_-]+$/);
```

Generate with `crypto.randomUUID()`; no alternate ID policy or game-specific generator.

### Step 2: add the minimal receipt table

- [ ] Add directly to `src/db/schema.ts`:

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

Do not remove `chipSyncReceipt` or `rouletteRound` yet.

### Step 3: keep both mission receipt gates valid temporarily

- [ ] Replace the old string-only gate input with the fixed union above.

Implement a code-owned gate builder equivalent to:

```ts
function buildReceiptGateSql(gate: ReceiptGate): {
  sql: string;
  values: Array<string>;
} {
  if (gate.kind === 'chip-sync') {
    return {
      sql: 'EXISTS (SELECT 1 FROM chip_sync_receipt WHERE userId = ? AND syncId = ?)',
      values: [gate.syncId],
    };
  }
  return {
    sql: 'EXISTS (SELECT 1 FROM wallet_settlement WHERE userId = ? AND settlementId = ? AND attemptId = ?)',
    values: [gate.settlementId, gate.attemptId],
  };
}
```

The existing SQL builder already binds `userId`; append the gate-specific values in the correct order. Do not accept arbitrary table/column strings.

- [ ] Update the old `/api/chips/update` gate-map construction to pass:

```ts
{ kind: 'chip-sync', syncId }
```

- [ ] Add tests proving **both** gate kinds update missions when their matching receipt exists and no-op when it does not.

This temporary branch is deleted in Task 8.

### Step 4: add repository tests first

- [ ] Cover fresh win/loss/push, stale expected balance, and duplicate lookup.

- [ ] Add rows-affected normalization regression:

```ts
expect(getRowsAffected({ meta: { changes: 1 }, rowsAffected: 0 })).toBe(1);
expect(getRowsAffected({ rowsAffected: 1 })).toBe(1);
expect(getRowsAffected(null)).toBe(0);
```

`getRowsAffected` lives in `repository.ts`; do not lose this current Miniflare/production compatibility when `chips/update.ts` is deleted.

### Step 5: implement guarded update + receipt

- [ ] First statement:

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

- [ ] Receipt insert:

```sql
INSERT INTO wallet_settlement (userId, settlementId, attemptId, balance, createdAt)
SELECT ?, ?, ?, ?, ?
WHERE changes() = 1;
```

`NOT EXISTS` must remain even for a zero delta.

### Step 6: port stats semantics under the attempt gate

- [ ] Gate on exact `(userId, settlementId, attemptId)`.

- [ ] Accumulate wins/losses/hands/net profit. Preserve:

```sql
biggestWin = CASE
  WHEN excluded.biggestWin > 0 AND excluded.biggestWin > game_stats.biggestWin
    THEN excluded.biggestWin
  ELSE game_stats.biggestWin
END
```

- [ ] Regression: existing 250 biggest win + push command with candidate 0 remains 250.

### Step 7: build exact mission event

- [ ] Use:

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

Pass `{ kind: 'wallet', settlementId, attemptId }` to the prepared statements.

- [ ] Regression: negative net delta with `winsIncrement > 0` still increments a matching `roundsWon` mission by the win count.

### Step 8: run focused tests

- [ ] Run:

```bash
bun test \
  src/lib/wallet/repository.test.ts \
  src/lib/wallet/settlement-id.test.ts \
  src/lib/missions/progress.test.ts \
  src/lib/chips-update-api.test.ts
bun run build
```

Expected: PASS, including legacy mission progress through `/api/chips/update`.

### Step 9: commit

- [ ] Commit only Task 1 files:

```bash
git commit -m "feat(wallet): add settlement repository and identity"
```

---

# Task 2: Add use case, timed client, and shared in-memory settlement gate

**Files:**

- Create: `src/lib/wallet/settle.ts`
- Create: `src/lib/wallet/settle.test.ts`
- Create: `src/lib/wallet/client.ts`
- Create: `src/lib/wallet/client.test.ts`
- Create: `src/lib/wallet/settlement-gate.ts`
- Create: `src/lib/wallet/settlement-gate.test.ts`
- Create: `src/lib/wallet/index.ts`
- Create: `src/pages/api/wallet/settle.ts`
- Create: `src/pages/api/wallet/settle.test.ts`

**Produces:**

```ts
export const MAX_ABSOLUTE_SETTLEMENT_DELTA = 1_000_000;
export const WALLET_SETTLEMENT_TIMEOUT_MS = 15_000;

export async function settleWalletRound(
  d1: D1Database,
  userId: string,
  command: SettleRoundCommand,
): Promise<SettleRoundResult>;

export async function submitWalletSettlement(
  command: SettleRoundCommand,
): Promise<SettleRoundResult>;

export interface SettlementGate {
  readonly pending: SettleRoundCommand | null;
  readonly isBlocked: boolean;
  settle(command: SettleRoundCommand): Promise<SettleRoundResult>;
  retry(): Promise<SettleRoundResult | null>;
  reset(): void;
}

export function createSettlementGate(args?: {
  submit?: typeof submitWalletSettlement;
}): SettlementGate;
```

### Step 1: validation tests

- [ ] Cover invalid ID chars/length, unknown game, unsafe ints, `rounds < 1`, negative win/loss/biggestWin, `wins + losses > rounds`, insufficient balance, and global delta bound:

```ts
expect(() => validate({ ...command, delta: 1_000_001 })).toThrow();
expect(() => validate({ ...command, delta: -1_000_001 })).toThrow();
expect(() => validate({ ...command, delta: 1_000_000 })).not.toThrow();
```

Do not restore per-game caps or rate limits.

### Step 2: implement bounded server settlement

- [ ] Keep exactly two optimistic attempts:

```ts
for (let attempt = 0; attempt < 2; attempt++) {
  const receipt = await findWalletSettlement(d1, userId, command.settlementId);
  if (receipt) return { balance: receipt.balance, duplicate: true };

  const balance = await readWalletBalance(d1, userId);
  if (balance === null) throw new WalletSettlementDomainError('USER_NOT_FOUND');

  const nextBalance = balance + command.delta;
  validateNextBalance(nextBalance);

  const attemptId = crypto.randomUUID();
  const applied = await applyWalletSettlementBatch(d1, {
    userId,
    attemptId,
    expectedBalance: balance,
    nextBalance,
    command,
    nowSeconds: Math.trunc(Date.now() / 1000),
  });

  if (applied) {
    return await buildFreshResult(d1, userId, command, nextBalance);
  }

  const racedReceipt = await findWalletSettlement(d1, userId, command.settlementId);
  if (racedReceipt) return { balance: racedReceipt.balance, duplicate: true };
}

throw new WalletSettlementDomainError('SETTLEMENT_CONFLICT');
```

### Step 3: fresh achievements only

- [ ] On the fresh path:

```ts
const earned = await checkAndGrantAchievements(createDb(d1), userId, nextBalance, {
  recentWinAmount: command.stats.biggestWin > 0 ? command.stats.biggestWin : undefined,
  gameType: command.game,
});
```

Do not pass/store `overallRank`; existing achievement logic calculates rank when absent.

### Step 4: thin route

- [ ] Route does only auth, DB presence, JSON parse, use-case call, and status mapping. No game branch/rate limit/retry SQL.

### Step 5: timed browser client

- [ ] Test exactly one `fetchJsonWithTimeout` call and no retries on timeout/non-2xx.

- [ ] Implement:

```ts
const { response, data } = await fetchJsonWithTimeout<
  SettleRoundResult | { message?: string }
>(
  '/api/wallet/settle',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
  },
  WALLET_SETTLEMENT_TIMEOUT_MS,
);
```

### Step 6: shared settlement-gate tests

- [ ] Test once:

```text
settle: pending becomes command before submit
settle success: pending clears, isBlocked false
settle failure: exact command remains, isBlocked true
retry: submits exact same object/ID and clears only on success
reset: clears pending without submitting
second settle while pending/in-flight: rejected
no timer, persistence, queue, callbacks, or automatic retry
```

### Step 7: implement the gate

- [ ] Minimal shape:

```ts
export function createSettlementGate({
  submit = submitWalletSettlement,
}: {
  submit?: typeof submitWalletSettlement;
} = {}): SettlementGate {
  let pending: SettleRoundCommand | null = null;
  let inFlight = false;

  const run = async (command: SettleRoundCommand) => {
    if (inFlight) throw new WalletSettlementError('Settlement already in progress');
    inFlight = true;
    pending = command;
    try {
      const result = await submit(command);
      pending = null;
      return result;
    } finally {
      inFlight = false;
    }
  };

  return {
    get pending() { return pending; },
    get isBlocked() { return pending !== null || inFlight; },
    settle(command) {
      if (pending !== null) throw new WalletSettlementError('Settlement pending');
      return run(command);
    },
    retry() {
      return pending ? run(pending) : Promise.resolve(null);
    },
    reset() { pending = null; },
  };
}
```

### Step 8: browser-safe exports

- [ ] `index.ts` exports types, ID helper, client, and settlement gate only. Server repository/use-case are imported directly by server code.

### Step 9: verify

- [ ] Run:

```bash
bun test src/lib/wallet src/pages/api/wallet/settle.test.ts
bun run build
```

### Step 10: commit

- [ ] Commit:

```bash
git commit -m "feat(wallet): add settlement use case and client gate"
```

---

# Task 3: Migrate Blackjack and single-player Poker

**Files:**

- Modify: `src/lib/blackjack/blackjackClient.ts`
- Modify: `src/lib/blackjack/blackjackClient.test.ts`
- Delete: `src/lib/blackjack/balance-sync-stats.ts`
- Delete: `src/lib/blackjack/balance-sync-stats.test.ts`
- Delete: `src/lib/blackjack/balanceSyncStats.test.ts`
- Modify: `src/lib/blackjack/constants.ts` if it documents old `GAME_LIMITS`
- Modify: `src/lib/poker/PokerGame.ts`
- Modify: `src/lib/poker/PokerGame.test.ts`

### Step 1: Blackjack command test

- [ ] For a completed round assert one command:

```ts
{
  settlementId: expect.stringMatching(/^blackjack-/),
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

Per-game test does **not** retest retry internals; assert the page/client consults `gate.isBlocked` before a new authenticated round and wires Retry to `gate.retry()`.

### Step 2: replace Blackjack sync machinery

- [ ] Build ID with `newSettlementId('blackjack')`, create command once, and call `gate.settle(command)`.
- [ ] On success adopt `result.balance`.
- [ ] On failure show retry/reset UI; no custom pending stats/timers/backoff/rebase.
- [ ] Delete all Blackjack sync-only helper files/tests.

### Step 3: Poker command tests

- [ ] Cover human fold-out and showdown final human delta. Build ID with `newSettlementId('poker')` and one-round stats.
- [ ] Ensure auto-deal does not begin while shared gate is blocked.

### Step 4: replace Poker direct old-endpoint transport

- [ ] Keep game rules and AI behavior unchanged; only replace settlement transport/state.

### Step 5: verify

- [ ] Run:

```bash
bun test src/lib/blackjack src/lib/poker/PokerGame.test.ts
bun run build
```

### Step 6: commit

- [ ] Commit:

```bash
git commit -m "refactor(games): migrate blackjack and poker settlement"
```

---

# Task 4: Migrate the live Baccarat page and delete dead Baccarat client code

**Files:**

- Create: `src/lib/baccarat/settlement.ts`
- Create: `src/lib/baccarat/settlement.test.ts`
- Modify: `src/pages/games/baccarat.astro`
- Delete: `src/lib/baccarat/balance-sync-state.ts`
- Delete: `src/lib/baccarat/balance-sync-state.test.ts`
- Delete: `src/lib/baccarat/baccaratClient.ts`
- Modify: `src/lib/baccarat/index.ts`
- Modify: Baccarat E2E spec(s) returned by preflight inventory as needed

**Produces:**

```ts
export function buildBaccaratSettlementCommand(
  settlementId: string,
  roundNetDelta: number,
): SettleRoundCommand;
```

### Step 1: pure builder tests

- [ ] Test:

```ts
expect(buildBaccaratSettlementCommand('baccarat-win', 120)).toEqual({
  settlementId: 'baccarat-win',
  game: 'baccarat',
  delta: 120,
  stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 120 },
});

expect(buildBaccaratSettlementCommand('baccarat-loss', -50).stats).toEqual({
  rounds: 1,
  wins: 0,
  losses: 1,
  biggestWin: 0,
});
```

### Step 2: modify the actual live page

- [ ] Delete imports/state for `balance-sync-state`, `pendingStats`, `syncPending`, retry timer, sync guard, follow-up attempts, `lastSyncedBalance`, and inline `/api/chips/update` flow.

- [ ] Create one page-local shared gate:

```ts
const settlementGate = createSettlementGate();
```

- [ ] At completed round:

```ts
const command = buildBaccaratSettlementCommand(
  newSettlementId('baccarat'),
  roundNetDelta,
);
const result = await settlementGate.settle(command);
game.setBalance(result.balance);
```

Wire Retry to `settlementGate.retry()` and block the next authenticated deal while `settlementGate.isBlocked`.

### Step 3: delete dead client code

- [ ] Delete `src/lib/baccarat/baccaratClient.ts`.
- [ ] Remove these barrel exports:

```ts
export { BaccaratClient } from './baccaratClient';
export type { BaccaratClientConfig } from './baccaratClient';
```

Do not replace them with a new class.

### Step 4: verify

- [ ] Run:

```bash
bun test src/lib/baccarat
bun run build
```

- [ ] Run the existing Baccarat Playwright flow returned by:

```bash
git grep -lE 'baccarat|/games/baccarat' e2e/*.spec.ts
```

### Step 5: commit

- [ ] Commit:

```bash
git commit -m "refactor(baccarat): migrate live settlement path"
```

---

# Task 5: Migrate Slots and Keno

**Files:**

- Modify: `src/lib/slots/slotsClient.ts`
- Delete: `src/lib/slots/chip-sync-coordinator.ts` + test
- Delete: `src/lib/slots/balance-sync-state.ts` + test
- Modify: existing Slots client/E2E tests
- Modify: `src/lib/keno/kenoClient.ts`
- Modify: `src/lib/keno/index.ts`
- Delete: `src/lib/keno/outbox.ts` + test
- Trim/delete: `src/lib/keno/review-regressions.test.ts`

### Step 1: Slots one-command mapping

- [ ] One spin uses `newSettlementId('slots')` and sends:

```ts
{
  settlementId,
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

- [ ] Replace coordinator with shared gate. Remove batching/pagehide flush/custom retry/rebase.

### Step 2: Keno one-command mapping

- [ ] One draw uses one generated wallet ID; no outbox/tab/heartbeat/orphan/drain state.
- [ ] Replace sync-paused recovery UI whose only purpose is durable settlement with shared manual retry/reset state.
- [ ] Remove Keno outbox export from `src/lib/keno/index.ts` in the same commit that deletes the file.

### Step 3: verify

- [ ] Run:

```bash
bun test src/lib/slots src/lib/keno
bunx playwright test e2e/slots.spec.ts e2e/keno.spec.ts
bun run build
```

### Step 4: commit

- [ ] Commit:

```bash
git commit -m "refactor(games): simplify slots and keno settlement"
```

---

# Task 6: Make Craps resolved-roll settlement explicit and testable

**Files:**

- Create: `src/lib/craps/settlement.ts`
- Create: `src/lib/craps/settlement.test.ts`
- Modify: `src/pages/games/craps.astro`
- Delete: `src/lib/craps/balanceSync.ts` + test
- Delete: `src/lib/craps/syncLimits.ts`
- Modify: `e2e/craps.spec.ts`

**Produces:**

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

### Step 1: command tests

- [ ] No resolved `win|lose|push` evaluation -> `null`.
- [ ] Mixed resolved roll:

```ts
expect(buildCrapsSettlementCommand('craps-1', result)).toEqual({
  settlementId: 'craps-1',
  game: 'craps',
  delta: result.netDelta,
  stats: {
    rounds: resolvedCount,
    wins: winCount,
    losses: lossCount,
    biggestWin: grossPositiveWinningPayout,
  },
});
```

### Step 2: balance tests

- [ ] Test:

```ts
expect(getAvailableCrapsBalance(1000, 250)).toBe(750);
expect(getAvailableCrapsBalance(1000, 0)).toBe(1000);
expect(() => getAvailableCrapsBalance(100, 150)).toThrow();
```

### Step 3: remove unresolved account writes

- [ ] Delete wallet sync from place-bet/add-odds/clear-refund and other unresolved local mutations.

### Step 4: settle only resolved rolls

- [ ] After `game.roll()`:

```ts
const command = buildCrapsSettlementCommand(
  newSettlementId('craps'),
  result,
);
if (command && shouldSyncAccountChips({ isGuestMode })) {
  const settled = await settlementGate.settle(command);
  game.setBalance(
    getAvailableCrapsBalance(settled.balance, game.getTotalAtRisk()),
  );
}
```

Shared gate blocks the next authenticated roll until success/reset.

### Step 5: delete old sync-only state/files

- [ ] Delete pending roll arrays, sync/retry/rebase state, dropped-roll persistence, `balanceSync.ts`, and `syncLimits.ts`.

### Step 6: verify

- [ ] Run:

```bash
bun test src/lib/craps
bunx playwright test e2e/craps.spec.ts
bun run build
```

### Step 7: commit

- [ ] Commit:

```bash
git commit -m "refactor(craps): settle resolved rolls only"
```

---

# Task 7: Delegate Roulette wallet writes and delete historical spin recovery

**Files:**

- Modify: `src/pages/api/roulette/spin.ts`
- Modify: `src/lib/roulette/spin-api.test.ts`
- Modify: `src/lib/roulette/types.ts`
- Modify: `src/lib/roulette/RouletteGame.ts` + tests
- Modify: `src/lib/roulette/rouletteClient.ts` + tests/integration tests
- Modify/delete: `src/lib/roulette/spin-error-classification.ts` + test
- Modify: `src/lib/roulette/constants.ts`
- Delete: `src/lib/roulette/spin-batch-sql.ts`
- Delete: `src/lib/roulette/spin-cascade.integration.test.ts`
- Modify: `e2e/roulette.spec.ts`

### Step 1: preserve server-authoritative route behavior

- [ ] Route tests keep bet validation and server-generated winning number/evaluation.

- [ ] Fresh spin delegates:

```ts
const walletResult = await settleWalletRound(d1, userId, {
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

### Step 2: explicitly test the intended mission normalization

- [ ] Fresh Roulette spin advances applicable generic mission progress once.
- [ ] Duplicate same ID returns the wallet balance and **does not** advance mission progress again.

This is an intentional behavior change from current Roulette.

### Step 3: define duplicate response

- [ ] Duplicate monetary settlement has no stored historical number:

```ts
{
  duplicate: true,
  newBalance: walletResult.balance,
}
```

Do not fabricate `winningNumber` or `results`.

### Step 4: replace server cascade

- [ ] Remove direct user balance mutation, separate receipt/stats SQL, rate-limit map, `roulette_round`, achievement replay cache, tombstone replay logic, and old per-route delta caps now covered by the shared global sanity bound.

### Step 5: delete browser resurrection

- [ ] Remove:

```text
pendingSyncId
pendingSyncCreatedAt
PENDING_SPIN_MAX_AGE_MS recovery semantics
restoreSession spinRecovery result
recoverPendingSpin
applyRecoverySettlement
recovery-specific retry/rejection paths
```

A duplicate/lost-response recovery adopts balance, clears unresolved state, returns to betting, and shows no historical number.

### Step 6: trim obsolete error classification

- [ ] Inspect `spin-error-classification.ts`. Delete RATE_LIMITED/replay-expiry branches and tests whose producer disappeared. Keep only live current-page error mapping that still has a concrete producer/consumer; delete the whole helper if nothing focused remains.

### Step 7: verify

- [ ] Run:

```bash
bun test src/lib/roulette
bunx playwright test e2e/roulette.spec.ts
bun run build
```

### Step 8: commit

- [ ] Commit:

```bash
git commit -m "refactor(roulette): share wallet settlement"
```

---

# Task 8: Remove old endpoint/schema, collapse mission gate, and migrate every inventory path

**Files:** all `DELETE` / `MIGRATE_TO_WALLET` paths from `/tmp/hpa-545-classified.tsv`, including the explicit setup/E2E/current-guidance files below.

### Step 1: create destructive migration

- [ ] Create `drizzle/0016_wallet_settlement.sql` equivalent to:

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

No backfill.

### Step 2: remove active old schema/cascade

- [ ] Delete `chipSyncReceipt` / `rouletteRound` from `src/db/schema.ts`.
- [ ] Delete `/api/chips/update`, `chip-sync-batch-sql.ts`, and their old tests.
- [ ] Remove old receipt/Roulette cleanup; keep only any simple bounded `wallet_settlement.createdAt` cleanup that current policy needs.

### Step 3: collapse the temporary mission gate

- [ ] Delete `ReceiptGate`'s `chip-sync` branch and old SQL.

Final gate is:

```ts
export interface WalletSettlementGate {
  settlementId: string;
  attemptId: string;
}
```

- [ ] Delete tests for the temporary old gate and retain wallet attempt-gate coverage.

### Step 4: migrate setup and build-breaking references

- [ ] Explicitly inspect/update as classified:

```text
src/lib/keno/index.ts
src/lib/roulette/constants.ts
src/lib/blackjack/constants.ts
scripts/setup-local-db.ts
wrangler.toml
src/server/cleanup.ts
src/server/cleanup.test.ts
CLAUDE.md
```

Do not leave current comments/constants/setup checks pinned to deleted tables/endpoints.

### Step 5: preserve E2E intent, not just compilation

- [ ] `e2e/ranked-blackjack.spec.ts`: the casual mutation around the live ranked session must become `/api/wallet/settle`, because the test is proving a **real casual wallet write** changes the account. Do not replace it with direct DB fixture mutation.

Use a valid command, for example:

```ts
await casualPage.request.post('/api/wallet/settle', {
  data: {
    settlementId: newTestSettlementId,
    game: 'blackjack',
    delta: -Math.min(firstResume.balance, MAX_ABSOLUTE_SETTLEMENT_DELTA),
    stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0 },
  },
});
```

If the test specifically needs balance zero and the current balance can exceed the global bound, perform multiple legitimate distinct wallet settlements in the test rather than bypassing the wallet semantics it is asserting.

- [ ] `e2e/global-setup.ts`: current old request has no sync ID. For pure fixture balance seeding, prefer existing direct test bootstrap/DB setup if available. If using wallet API, generate a valid unique `settlementId` and provide the full stats object; do not merely rename the URL.

- [ ] Migrate route intercepts/calls in every classified E2E file, including public single-player, Slots, Roulette, Craps, Blackjack split, isolated page, and authed preservation.

### Step 6: enforce exact inventory completion

- [ ] Regenerate the grep path list using the same preflight command to `/tmp/hpa-545-files-after.txt`.

- [ ] For every final remaining path, classify only `KEEP_NON_SETTLEMENT` or `HISTORICAL_ONLY`. There must be no active `/api/chips/update`, old receipt, old pending/rebase/outbox, or deleted helper import.

- [ ] Verify all originally classified `DELETE`/`MIGRATE_TO_WALLET` paths were actually handled:

```bash
while IFS=$'\t' read -r path action; do
  case "$action" in
    DELETE)
      test ! -e "$path" || { echo "still exists: $path"; exit 1; }
      ;;
    MIGRATE_TO_WALLET)
      test -e "$path" || { echo "missing migrated file: $path"; exit 1; }
      ;;
  esac
done < /tmp/hpa-545-classified.tsv
```

For files intentionally deleted after being initially marked MIGRATE, update the classification before this final check and keep the sets exact.

### Step 7: recreate/migrate local hobby DB

- [ ] Follow current repository setup behavior:

```bash
rm -rf .wrangler/state
bun run setup:db
bun run db:migrate:local
```

If `setup:db` already applies migrations, do not add a second migration framework or redundant bootstrap.

### Step 8: full non-E2E gate

- [ ] Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
```

### Step 9: commit

- [ ] Commit:

```bash
git commit -m "refactor(wallet): remove legacy chip sync"
```

---

# Task 9: E2E verification and complexity acceptance gate

**Files:** E2E-only corrections if verification reveals an intentional behavior assertion that must be updated. No new runtime architecture is allowed here.

### Step 1: focused game journeys

- [ ] Run:

```bash
bunx playwright test \
  e2e/public-single-player-games.spec.ts \
  e2e/slots.spec.ts \
  e2e/keno.spec.ts \
  e2e/craps.spec.ts \
  e2e/roulette.spec.ts \
  e2e/blackjack-split.spec.ts
```

- [ ] Run Baccarat and single-player Poker specs returned by:

```bash
git grep -lE 'baccarat|/games/poker' e2e/*.spec.ts
```

Exclude multiplayer-only Poker from wallet acceptance.

### Step 2: fixture-sensitive journeys

- [ ] Run:

```bash
bunx playwright test \
  e2e/ranked-blackjack.spec.ts \
  e2e/authed-user-preservation.spec.ts
```

### Step 3: full repository gate

- [ ] Run:

```bash
bun run test
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

Expected: PASS subject only to already-documented environment-specific skips.

### Step 4: focused complexity audit

- [ ] Record size:

```bash
git diff --stat main...HEAD
git diff --numstat main...HEAD \
  | awk '{ add += $1; del += $2 } END { print "added=" add, "deleted=" del, "net=" add-del }'
```

- [ ] Scan wallet + changed source files only:

```bash
git diff --name-only main...HEAD -- '*.ts' '*.astro' '*.js' \
  | while read -r file; do
      [ -f "$file" ] || continue
      grep -nE \
        'backoff|outbox|heartbeat|orphan|sendBeacon|BALANCE_MISMATCH|RATE_LIMITED|previousBalance|pendingSyncId|pendingRollSyncs|syncPending' \
        "$file" || true
    done

git grep -nE \
  'backoff|outbox|heartbeat|orphan|sendBeacon|BALANCE_MISMATCH|RATE_LIMITED|previousBalance|pendingSyncId|pendingRollSyncs|syncPending' \
  -- src/lib/wallet
```

Review each hit in this **changed settlement surface**, not unrelated AI/LLM code. Allowed examples are historical deletion comments or user-facing Retry copy. Disallowed: generic retry strategy, persisted queues, rebase loops, cross-tab ownership, unload settlement flushes, pending Roulette resurrection, or per-game compatibility flags.

### Step 5: current architecture grep

- [ ] Run:

```bash
git grep -n '/api/chips/update' -- src e2e scripts CLAUDE.md README.md
git grep -nE 'chip_sync_receipt|roulette_round' -- src e2e scripts CLAUDE.md README.md
```

Expected: no active/current usage. Dated historical migrations/specs may remain historical.

### Step 6: destructive deployment note

- [ ] Implementation PR states:

```text
old chip_sync_receipt and roulette_round data are discarded
old browser settlement state is not migrated
local/hobby-remote D1 must use the destructive/fresh schema before deploy
there is no old-client compatibility window
global ±1,000,000 delta bound is a sanity bound, not anti-cheat
Roulette now participates in generic mission progress
```

### Step 7: final E2E-only commit when needed

- [ ] If verification changed files:

```bash
git commit -m "test(wallet): verify settlement migration"
```

Skip when no corrections are required.

---

## Definition of complete implementation

The implementation is complete only when:

- `src/lib/wallet` is the only casual authenticated settlement implementation.
- Shared wallet code consists only of current-consumer concepts: types, ID helper, concrete repository/use case, timed client, and one in-memory settlement gate.
- `walletSettlement` stays in `src/db/schema.ts`.
- `/api/chips/update`, `chip_sync_receipt`, and `roulette_round` are absent from active runtime/schema.
- Temporary `chip-sync` mission gate support is removed.
- `attemptId` gates fresh stats/missions and `NOT EXISTS` protects zero-delta duplicates.
- `getRowsAffected` behavior survives in the wallet repository.
- IDs use the existing safe regex and manual retry never mints a new ID.
- One global ±1,000,000 sanity bound replaces `GAME_LIMITS`; there is no claim of cheat-proof casual leaderboards.
- Blackjack, Poker, live Baccarat, Slots, Keno, and Craps use `createSettlementGate` rather than custom pending/retry state machines.
- Dead `BaccaratClient` and barrel export are deleted.
- Baccarat/Craps domain-to-command math is pure/testable outside Astro pages.
- Keno barrel no longer exports the deleted outbox.
- Roulette remains server-authoritative, joins generic mission progress intentionally, and cannot advance missions twice on duplicate.
- Roulette pending-spin resurrection/error branches disappear with `roulette_round`.
- Positive-only biggest-win semantics remain.
- Receipt does not regain payload hashes, achievement replay data, or `overallRank`.
- Every path from the authoritative preflight classification is handled.
- Ranked cross-tab E2E still exercises a real casual wallet mutation.
- Global setup payload is deliberately rewritten, not URL-swapped.
- Focused tests, full tests, lint, format, build, affected E2E, and full Playwright gates pass.
- Final changed settlement code contains no old outbox/backoff/rebase/unload/cross-tab policy.
- Net code/test complexity decreases and no compatibility framework or repository-wide structural migration is introduced.
