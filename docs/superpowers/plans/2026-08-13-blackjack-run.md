# Blackjack Run Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace parallel Ranked Blackjack and Daily Challenge session stacks with one Blackjack-specific lifecycle while preserving real Ranked stake debits, moving Daily Practice local, and deleting compatibility/security/history machinery.

**Architecture:** Pure Blackjack/Daily behavior and one closed Zod protocol live under `src/lib/blackjack-run`; D1 persistence/service/expiration live under `src/server/blackjack-run`. Ranked initial/additional stakes are atomically debited with run mutations using the existing guarded Ranked pattern; terminal payout uses `settleWalletRound` once with a narrow optional `stats.netProfit` override. Daily never touches the account wallet. New tables are additive first; old runtime/schema/tables are deleted together only after both pages and E2E have migrated.

**Tech Stack:** Astro 5 SSR, Cloudflare Workers, D1, Drizzle ORM, TypeScript, Zod, Bun, Playwright, Wrangler 4.

## Global Constraints

- Keep `src/lib/<domain>`, `src/server/<domain>`, and the single `src/db/schema.ts` convention.
- Support exactly `ranked` and `daily`; no game/session adapter registry or base framework.
- Move/reuse existing Ranked engine/projection, Daily replay/window/seed/scoring/percentile, wallet, timeout, expiration, and Miniflare behavior.
- Public request/response types are inferred from closed Zod schemas; every object-union member is `.strict()`.
- Ranked wager 10–1,000; one deck; up to four split hands; dealer stands soft 17; 3:2 blackjack; 15-minute TTL.
- Ranked initial stake is debited atomically with run creation. Split/double additional stake is debited atomically with command append.
- Ranked terminal wallet `delta` is gross payout; shared `stats.netProfit` is the true `gameNetDelta`.
- `SETTLEMENT_CONFLICT` is retryable and never becomes a skipped payout.
- Daily: starting bankroll 1,000; 10 rounds; wager 10–1,000; 30-minute TTL; entry closes 30 minutes before UTC day end.
- Daily Practice is local-only. Keep current Daily rank/totalEligible/percentile.
- No Daily covering index or separate score/result/history table.
- No localStorage run ownership, durable queue, automatic retry/backoff, compatibility parser, hash/commitment/receipt display, or durable throttling.
- Delete `ranked_debut` and +100 first-Ranked reward.
- Completed Ranked rounds intentionally enter shared `game_stats`, missions, and evaluated achievements.
- Existing active old Ranked stakes are refunded before `ranked_session` is dropped.
- Ranked and Daily E2E must be rewritten/run in the same task that switches each page.
- Final authoritative Ranked/Daily source + tests must be materially smaller than the deleted stacks.

## Risk Controls

- **Atomic stake/run state:** never split a Ranked stake debit from run creation/action append across separate transactions.
- **Transient terminal CAS:** leave the run active on `SETTLEMENT_CONFLICT`; stable settlement ID + explicit reload/next cron converge.
- **Schema sequencing:** add new tables first; drop old tables only with old runtime deletion.
- **Old in-flight stakes:** refund active `committedWager` before dropping old Ranked sessions.
- **Deployment:** deploy the new Worker first, then immediately apply pending D1 migrations; accept the short breaking cutover window instead of dual APIs.

Design reference: `docs/superpowers/specs/2026-08-13-blackjack-run-design.md`.

---

## Preflight: Inventory and Baseline

### Step 0.1: classify the real replacement surface

- [ ] Generate the inventory from current `main`:

```bash
git grep -lE \
  'src/(lib|server)/(ranked|daily-challenge)|/api/ranked|/api/daily-challenge|/api/daily-challenges|ranked_session|ranked_result|ranked_game_stats|ranked_reward_grant|ranked_rate_limit|daily_challenge|dailyChallenge|seedCommitment|configHash|actionLogHash|receiptHash|scoreVersion|rulesetVersion|ranked_debut' \
  -- src e2e scripts drizzle CLAUDE.md README.md \
  | sort -u > /tmp/hpa-553-files.txt
```

- [ ] Create `/tmp/hpa-553-classified.tsv` with exactly one row per path:

```text
<path><TAB>MIGRATE_TO_BLACKJACK_RUN
<path><TAB>DELETE_AT_CUTOVER
<path><TAB>KEEP_UNRELATED
```

- [ ] Prove complete classification:

```bash
cut -f1 /tmp/hpa-553-classified.tsv | sort -u > /tmp/hpa-553-classified-files.txt
diff -u /tmp/hpa-553-files.txt /tmp/hpa-553-classified-files.txt
```

Expected: no diff.

### Step 0.2: record complexity and behavior baseline

- [ ] Record old lifecycle LOC:

```bash
find src/lib/ranked src/server/ranked src/lib/daily-challenge src/server/daily-challenge \
  -type f -name '*.ts' -print0 | xargs -0 wc -l | tail -1 \
  | tee /tmp/hpa-553-before-loc.txt
```

- [ ] Run current focused behavior tests:

```bash
bun test \
  src/lib/ranked/blackjack/engine.test.ts \
  src/lib/ranked/blackjack/projection.test.ts \
  src/lib/daily-challenge/config.test.ts \
  src/lib/daily-challenge/replay.test.ts \
  src/lib/daily-challenge/scoring.test.ts \
  src/server/ranked/coordinator.test.ts \
  src/server/ranked/repository.integration.test.ts \
  src/server/daily-challenge/coordinator.test.ts \
  src/server/daily-challenge/repository.integration.test.ts
```

Record only genuine pre-existing failures.

---

# Task 1: Move the Pure Core and Define the Closed Protocol

**Files:**
- Create: `src/lib/blackjack-run/protocol.ts`
- Create: `src/lib/blackjack-run/engine.ts`
- Create: `src/lib/blackjack-run/ranked.ts`
- Create: `src/lib/blackjack-run/daily.ts`
- Create/move: tests beside those files
- Reference only for now: old Ranked/Daily pure files

**Interfaces:**
- Produces: `blackjackRunStartSchema`, `blackjackRunCommandSchema`, `blackjackRunPublicStateSchema`
- Produces: inferred `BlackjackRunStart`, `BlackjackRunCommand`, `BlackjackRunPublicState`
- Produces: `replayBlackjackRound`, `replayDailyRun`, period/window/scoring/percentile helpers
- Produces: Ranked wager constants, additional-wager mapping, expiry outcome, terminal settlement-command builder

### Step 1.1: move Ranked engine/projection tests first

- [ ] Move behavioral cases into `src/lib/blackjack-run/engine.test.ts` for deterministic deal, hit, stand, double, split/multiple hands, blackjack, bust, push, dealer draw, legal actions, and public projection.

- [ ] Run before implementation:

```bash
bun test src/lib/blackjack-run/engine.test.ts
```

Expected: import/module failure.

- [ ] Move/de-version current implementation into `engine.ts`; keep shared `src/lib/blackjack` rule helpers.

Minimal public shape:

```ts
export function replayBlackjackRound(input: {
  seed: Uint8Array;
  initialWager: number;
  actions: readonly BlackjackAction[];
}): BlackjackRoundReplay;
```

No adapter registry, ruleset version, hashes, commitments, or generic game type.

### Step 1.2: move Daily replay/window/seed/scoring behavior

- [ ] Move useful tests into `daily.test.ts` covering:
  - `getDailyPeriodKey` / real-calendar UTC windows;
  - bankroll 1,000 and 10 rounds;
  - wager 10–1,000;
  - 30-minute TTL/cutoff;
  - deterministic per-round seeds;
  - start-round + Blackjack actions;
  - eligible normal and bankroll-below-minimum completion;
  - forfeit/expiration ineligibility;
  - score comparison;
  - percentile calculation.

- [ ] Move implementation from `config.ts`, `replay.ts`, `random.ts`, and `scoring.ts`, stripping only version/commitment/config wrappers.

Required exports include:

```ts
export function replayDailyRun(seed: Uint8Array, commands: readonly BlackjackRunCommand[]): DailyRunReplay;
export function getDailyWindowForPeriodKey(periodKey: string): DailyWindow;
export { getDailyPeriodKey } from '../missions/periods';
export function compareDailyScores(left: DailyScore, right: DailyScore): number;
export function calculateDailyPercentile(totalEligible: number, playersStrictlyAbove: number): number;
```

### Step 1.3: define strict Zod protocol

- [ ] Add `protocol.test.ts` cases proving:
  - only `ranked|daily` starts parse;
  - unknown fields are rejected for every start member;
  - `start-round` requires wager and rejects action-only fields;
  - action command rejects `wager` and other extras;
  - forfeit rejects `wager` and other extras;
  - public Ranked/Daily branches reject version/hash/receipt fields.

- [ ] Define all union members with `.strict()`:

```ts
export const blackjackRunCommandSchema = z.discriminatedUnion('command', [
  z.object({ sequence: sequenceSchema, command: z.literal('start-round'), wager: safeIntegerSchema }).strict(),
  z.object({ sequence: sequenceSchema, command: z.enum(['hit', 'stand', 'double-down', 'split']) }).strict(),
  z.object({ sequence: sequenceSchema, command: z.literal('forfeit') }).strict(),
]);
```

- [ ] Infer TypeScript types from Zod. Do not add `Envelope<TState, TResult>` or a separate handwritten HTTP contract.

### Step 1.4: Ranked pure mapping

- [ ] Add tests for:
  - wager min/max;
  - 15-minute TTL;
  - additional wager amount for split/double;
  - terminal command uses stable `blackjack-run-${runId}`;
  - terminal command uses `delta = payout`;
  - `stats.netProfit = gameNetDelta`;
  - expiration outcome is loss across all committed hands.

- [ ] Implement `buildRankedSettlementCommand`:

```ts
export function buildRankedSettlementCommand(
  runId: string,
  outcome: BlackjackRoundOutcome,
): SettleRoundCommand {
  return {
    settlementId: `blackjack-run-${runId}`,
    game: 'blackjack',
    delta: outcome.payout,
    stats: {
      rounds: 1,
      wins: outcome.result === 'win' ? 1 : 0,
      losses: outcome.result === 'loss' ? 1 : 0,
      biggestWin: Math.max(0, outcome.gameNetDelta),
      netProfit: outcome.gameNetDelta,
    },
  };
}
```

### Step 1.5: verify pure core

```bash
bun test \
  src/lib/blackjack-run/engine.test.ts \
  src/lib/blackjack-run/daily.test.ts \
  src/lib/blackjack-run/protocol.test.ts \
  src/lib/blackjack-run/ranked.test.ts
bunx prettier --write src/lib/blackjack-run
```

**Commit:** `refactor(blackjack): move shared run core`

---

# Task 2: Extend Wallet Stats for Payout-Only Ranked Terminal Settlement

**Files:**
- Modify: `src/lib/wallet/types.ts`
- Modify: `src/lib/wallet/settle.ts`
- Modify: `src/lib/wallet/repository.ts`
- Modify: focused wallet tests

**Interfaces:**
- Extends `RoundStats` with optional `netProfit?: number`
- Existing wallet callers remain source-compatible and keep current semantics
- Ranked terminal can credit gross payout while recording true net profit

### Step 2.1: write failing wallet tests

- [ ] Add tests proving:
  1. omitted `stats.netProfit` still records `command.delta` as net profit;
  2. provided `stats.netProfit` controls `game_stats.netProfit` but wallet balance still changes by `command.delta`;
  3. `delta=0`, `losses=1`, negative `netProfit` produces a loss mission event, not push;
  4. `wins=1` produces win mission classification even when wallet payout differs from net profit;
  5. unsafe/out-of-bound `netProfit` is rejected;
  6. `rounds >= 1` remains enforced.

### Step 2.2: extend the type/validator minimally

- [ ] Change only `RoundStats`:

```ts
export interface RoundStats {
  rounds: number;
  wins: number;
  losses: number;
  biggestWin: number;
  netProfit?: number;
}
```

- [ ] In `settle.ts`, allow the `netProfit` key and validate it when present with the existing safe-integer/stat bound.

Do not add a mode/kind/options object or zero-round settlement concept.

### Step 2.3: use gameplay net profit for stats/missions

- [ ] In wallet repository logic:

```ts
const netProfit = command.stats.netProfit ?? command.delta;
const outcome =
  command.stats.wins > 0 ? 'win' :
  command.stats.losses > 0 ? 'loss' :
  netProfit > 0 ? 'win' :
  netProfit < 0 ? 'loss' : 'push';
```

- [ ] Bind `netProfit` into `game_stats.netProfit` and mission event `delta`.

- [ ] Keep account balance mutation based only on `command.delta`.

### Step 2.4: verify wallet regression surface

```bash
bun test src/lib/wallet
bun run test
```

Existing games must pass unchanged.

**Commit:** `refactor(wallet): separate payout from round net profit`

---

# Task 3: Add Unified Persistence with Atomic Ranked Stake Debits

**Files:**
- Modify: `src/db/schema.ts` — add only new declarations
- Create: `src/server/blackjack-run/repository.ts`
- Create: `src/server/blackjack-run/repository.integration.test.ts`
- Reuse: `src/server/ranked/test-d1.ts`
- Create: next additive Drizzle migration

**Interfaces:**
- Produces one concrete repository
- Ranked start/action methods own atomic run+stake updates
- Daily methods never touch `user.chipBalance`

### Step 3.1: write D1 integration tests first

- [ ] Reuse the existing Ranked Miniflare/migration helper; do not create a third D1 harness.

- [ ] Add failing cases for:
  1. Ranked run creation subtracts initial wager and inserts active row atomically;
  2. insufficient/raced initial stake leaves no run and no balance mutation;
  3. start request uniqueness;
  4. one active run per `(userId, mode)` and Ranked+Daily may coexist;
  5. Daily one-run-per-period uniqueness;
  6. Ranked split/double command + additional stake apply atomically;
  7. insufficient additional stake leaves balance, command log, and sequence unchanged;
  8. non-wager Ranked command advances without balance change;
  9. Daily append never changes account balance;
  10. terminal update clears `activeUserId` once;
  11. Daily completed projections/non-eligible null projections;
  12. leaderboard ordering + current-user standing inputs;
  13. expired page cursor ordering `(expiresAt,id)`.

### Step 3.2: add new tables beside old ones

- [ ] Add `blackjackRun` with fields:

```text
id, userId, activeUserId, mode, periodKey, startRequestId,
initialWager, seed, commandsJson, nextSequence, status, resultJson,
dailyEndingBankroll, dailyRoundsCompleted,
expiresAt, createdAt, updatedAt, settledAt
```

- [ ] Add only these indexes:

```ts
uniqueIndex('blackjack_run_user_start_request_idx').on(table.userId, table.startRequestId);
uniqueIndex('blackjack_run_active_user_mode_idx').on(table.activeUserId, table.mode);
uniqueIndex('blackjack_run_user_mode_period_idx').on(table.userId, table.mode, table.periodKey);
index('blackjack_run_status_expiry_idx').on(table.status, table.expiresAt);
```

- [ ] Add `blackjackDaily(periodKey, seed, createdAt)`.

- [ ] Keep all old Ranked/Daily declarations unchanged in Task 3.

### Step 3.3: implement explicit repository methods

- [ ] Implement:

```ts
createRankedRunWithStake(input)
createDailyRun(input)
findOwnedRun(userId, runId)
findByStartRequest(userId, requestId)
findActiveRun(userId, mode)
findDailyRun(userId, periodKey)
appendRankedCommandWithStake(input)
appendDailyCommand(input)
finishRun(input)
listExpiredPage(nowSeconds, cursor, limit)
getOrCreateDaily(periodKey, seedFactory, nowSeconds)
listDailyLeaderboard(periodKey, limit, userId?)
```

- [ ] Move/simplify current `RANKED_START_WAGER_DEDUCTION_SQL` and `RANKED_ACTION_WAGER_DEDUCTION_SQL` guarded patterns.

- [ ] `createRankedRunWithStake` must make run insert + initial debit one D1 batch outcome. Return a concrete result such as `applied | insufficient | active-exists | duplicate-request` rather than throwing for ordinary races.

- [ ] `appendRankedCommandWithStake` must make additional debit + command append one batch outcome. If `additionalWager=0`, do only the guarded command update.

Do not create an escrow table or generic transaction hook.

### Step 3.4: implement Daily leaderboard/standing

- [ ] Keep SQL eligibility to:

```sql
WHERE mode='daily' AND periodKey=? AND status='completed'
```

- [ ] Return entries in bankroll/rounds/settledAt/userId order and preserve current-user standing:

```ts
{
  rank: number;
  totalEligible: number;
  percentile: number;
}
```

Reuse the moved score comparator/percentile semantics rather than inventing a new score.

### Step 3.5: create additive migration only

- [ ] Generate/inspect a migration that creates only:
  - `blackjack_run`;
  - `blackjack_daily`;
  - four listed indexes.

It must not drop/copy old data.

### Step 3.6: verify intermediate tree

```bash
bun test src/server/blackjack-run/repository.integration.test.ts
bun run setup:db
bun run test
bun run build
```

Confirm local D1 contains both old and new tables at this stage.

**Commit:** `refactor(blackjack): add unified run persistence`

---

# Task 4: Build One Blackjack Run Service

**Files:**
- Create: `src/server/blackjack-run/service.ts`
- Create: `src/server/blackjack-run/service.test.ts`
- Reuse: Task 1 core/protocol, Task 2 wallet extension, Task 3 repository

**Interfaces:**

```ts
createBlackjackRunService({ repository, db, now, randomBytes, settleWallet, readBalance })
```

Methods:

```ts
start(userId, input)
current(userId, mode)
get(userId, runId)
command(userId, runId, command)
expire(runId)
currentDaily(userId | null)
leaderboard(periodKey, userId | null, limit)
```

### Step 4.1: write Ranked lifecycle tests

- [ ] Cover:
  1. valid/invalid start wager;
  2. same request ID returns same run without second debit;
  3. mismatched request-ID reuse is invalid;
  4. second active Ranked run rejected;
  5. start subtracts initial stake exactly once;
  6. opening natural terminal settles payout once;
  7. hit/stand advances sequence;
  8. split/double subtract additional stake exactly once;
  9. insufficient additional stake does not append command;
  10. sequence mismatch returns expected sequence;
  11. terminal uses stable settlement ID, `delta=payout`, `stats.netProfit=gameNetDelta`;
  12. wallet commit + failed `finishRun` converges on later call;
  13. `SETTLEMENT_CONFLICT` leaves run active and retryable;
  14. later call after conflict converges and clears active ownership;
  15. expiration uses payout 0 + negative true net profit and same retry policy.

There are no skipped-wallet tests.

### Step 4.2: write Daily lifecycle tests

- [ ] Cover current period/window, one attempt, virtual bankroll actions, no wallet call, eligible completion, bankroll-below-minimum completion, forfeit, expiration, current-after-terminal, rank/percentile standing.

### Step 4.3: implement service dispatch with one switch

- [ ] Use one concrete replay switch:

```ts
switch (record.mode) {
  case 'ranked': return replayBlackjackRound(...);
  case 'daily': return replayDailyRun(...);
}
```

No mode adapter interface.

### Step 4.4: implement Ranked start/action around atomic repository methods

- [ ] Start flow:

```text
resolve request-id replay
read wallet for user-facing validation
createRankedRunWithStake(run + expected/current balance)
reload/replay run
if opening gameplay already terminal -> finalizeRankedTerminal
return public state with post-debit balance
```

- [ ] Action flow:

```text
load/replay active run
validate command/sequence/legal action
derive additionalWager
appendRankedCommandWithStake(command + additionalWager)
reload/replay
if terminal -> finalizeRankedTerminal
return state
```

### Step 4.5: terminal convergence

- [ ] Implement one Ranked finalizer:

```text
replay terminal
buildRankedSettlementCommand(runId, outcome)
settleWalletRound(DB, userId, command)   # no requiredFunds; delta >= 0
finishRun(terminal + returned balance)
if finish lost race -> reload stored run
```

- [ ] Error behavior:
  - `SETTLEMENT_CONFLICT`: throw retryable service error, leave run active;
  - `USER_NOT_FOUND` / `INVALID_COMMAND` / unknown: loud internal/domain failure;
  - no `INSUFFICIENT_BALANCE` normal terminal branch.

- [ ] `get`, `current`, and `loadRun` service reads call terminal finalization when replay says an active Ranked row is gameplay-terminal. This lets a later explicit read converge after a transient conflict.

### Step 4.6: verify service

```bash
bun test src/server/blackjack-run/service.test.ts
bun run test
```

**Commit:** `refactor(blackjack): add unified run service`

---

# Task 5: Add Thin HTTP Routes and Move the Expiration Scanner

**Files:**
- Create: `src/server/blackjack-run/http.ts`
- Create: `src/server/blackjack-run/http.test.ts`
- Create: `src/server/blackjack-run/expiration.ts`
- Create: `src/server/blackjack-run/expiration.test.ts`
- Create: six API routes
- Modify: `src/server/cleanup.ts`
- Modify: `src/worker.ts`
- Keep old jobs/routes live until Task 8

**Interfaces:**
- Start/command parse through Task 1 Zod schemas
- By-ID GET supports `client.loadRun(runId)` uncertain-response recovery
- New expiration job runs beside old scheduled jobs temporarily

### Step 5.1: HTTP/error tests

- [ ] Cover auth, invalid JSON/schema, not found/ownership, sequence mismatch payload, retryable `SETTLEMENT_CONFLICT`, and closed response parsing.

- [ ] Implement six routes:

```text
POST /api/blackjack-runs
GET  /api/blackjack-runs/current?mode=ranked|daily
GET  /api/blackjack-runs/:runId
POST /api/blackjack-runs/:runId/commands
GET  /api/blackjack-daily/current
GET  /api/blackjack-daily/:periodKey/leaderboard
```

Do not add a route barrel or generic API helper framework.

### Step 5.2: move robust expiration mechanics

- [ ] Move tests/implementation for:
  - `(expiresAt,id)` cursor;
  - page size;
  - 25s wall-clock budget;
  - cursor advance after every attempted row;
  - transient conflict does not stop later rows;
  - next invocation can retry a still-active conflict row.

- [ ] Point scanner at `repository.listExpiredPage` and `service.expire`.

### Step 5.3: temporary scheduled wiring

- [ ] Add `blackjackRunExpiration` while keeping old Ranked/Daily jobs for old rows until Task 8.

No new run-retention job.

### Step 5.4: verify

```bash
bun test \
  src/server/blackjack-run/http.test.ts \
  src/server/blackjack-run/expiration.test.ts \
  src/server/cleanup.test.ts
bun run test
bun run build
```

**Commit:** `refactor(blackjack): add unified run APIs`

---

# Task 6: Migrate Ranked Page and E2E Together

**Files:**
- Create: `src/lib/blackjack-run/client.ts`
- Create: `src/lib/blackjack-run/client.test.ts`
- Create: `src/lib/blackjack-run/ranked-ui.ts`
- Create: `src/lib/blackjack-run/ranked-ui.test.ts`
- Modify: `src/pages/games/blackjack/ranked.astro`
- Rewrite: `e2e/ranked-blackjack.spec.ts`
- Keep old Ranked runtime/routes until Task 8

### Step 6.1: shared client tests

- [ ] Cover:
  - `loadCurrent('ranked')`;
  - `loadRun(runId)` exact-run recovery;
  - one request ID per explicit start;
  - command uses current sequence;
  - one in-flight guard;
  - response parsed through shared Zod schema;
  - sequence mismatch calls `loadRun(runId)`;
  - timeout/network/conflict surfaces error and later explicit load can recover;
  - no localStorage or automatic backoff.

- [ ] Implement using `fetchJsonWithTimeout` only.

### Step 6.2: Ranked UI behavior

- [ ] Move only wager/cards/actions/countdown/pending/error/result DOM behavior.

- [ ] Reflect server account balance after initial/additional stake debit.

- [ ] Terminal Result shows gameplay outcome, committed wager, payout/net, final account balance. There is no `walletStatus` warning.

- [ ] Delete receipt/hash/commitment/version/reward-effect UI and stale multiplayer wallet-lock copy.

### Step 6.3: switch `ranked.astro`

- [ ] Initialize the new UI/client and remove old client script from the live page. Keep old server code/routes for one more task boundary.

### Step 6.4: rewrite and run Ranked E2E now

- [ ] E2E must prove:
  1. authenticated start with known balance;
  2. initial stake immediately lowers server/header balance;
  3. at least one command uses new endpoint;
  4. split/double additional stake is reflected when fixture allows;
  5. reload resumes active run from server;
  6. terminal credits payout once and Result is shown;
  7. second Ranked run can start after terminal;
  8. old receipt/hash/localStorage behavior is absent.

- [ ] Run in this task:

```bash
bun test \
  src/lib/blackjack-run/client.test.ts \
  src/lib/blackjack-run/ranked-ui.test.ts
bun run build
bunx playwright test e2e/ranked-blackjack.spec.ts
```

Do not defer the first new-page E2E run until after deletion.

**Commit:** `refactor(blackjack): migrate ranked experience`

---

# Task 7: Migrate Daily Challenge and E2E Together

**Files:**
- Create: `src/lib/blackjack-run/daily-ui.ts`
- Create: `src/lib/blackjack-run/daily-ui.test.ts`
- Modify: `src/pages/games/daily-challenge.astro`
- Delete live page: `src/pages/games/daily-challenge/[periodKey].astro`
- Rewrite: `e2e/daily-challenge.spec.ts`
- Keep old Daily server/routes until Task 8

### Step 7.1: Daily UI tests

- [ ] Cover:
  - guest Practice + sign-in CTA;
  - current period/attempt load;
  - Practice never POSTs a run;
  - Practice restart makes fresh local seed;
  - ranked start/commands/forfeit;
  - terminal attempt cannot restart same period;
  - leaderboard entries;
  - current-user `rank`, `totalEligible`, `percentile` rendering;
  - no exact replay/history requests.

### Step 7.2: local Practice

- [ ] Implement:

```text
seed = crypto.getRandomValues(new Uint8Array(32))
commands = []
on action -> append local sequenced command -> replayDailyRun -> render
restart -> fresh seed + []
```

No API, localStorage, practice run ID, or persisted practice seed.

### Step 7.3: simplify live page

- [ ] Keep current period/reset, Practice/Ranked switch, virtual bankroll/progress/actions, forfeit, terminal result, leaderboard, rank/percentile.

- [ ] Remove exact-ranked replay, historical replay, seven-day history, receipt/hash/commitment/version copy.

- [ ] Remove the historical `[periodKey]` page with no compatibility redirect.

### Step 7.4: rewrite and run Daily E2E now

- [ ] Prove:
  1. guest current Daily/leaderboard load;
  2. Practice works with zero `POST /api/blackjack-runs`;
  3. authenticated one-attempt start;
  4. new command endpoint works;
  5. reload resumes run;
  6. eligible terminal appears in leaderboard;
  7. rank/percentile/current-user standing renders;
  8. second attempt unavailable;
  9. old history/replay UI absent.

- [ ] Run:

```bash
bun test \
  src/lib/blackjack-run/daily.test.ts \
  src/lib/blackjack-run/client.test.ts \
  src/lib/blackjack-run/daily-ui.test.ts
bun run build
bunx playwright test e2e/daily-challenge.spec.ts
```

**Commit:** `refactor(blackjack): migrate daily challenge`

---

# Task 8: Delete Old Stacks, Refund Active Old Stakes, and Prove Simplification

**Files:**
- Delete old Ranked/Daily runtime/routes/tests classified for removal
- Modify: `src/db/schema.ts`
- Modify: `src/worker.ts`
- Modify: `src/server/cleanup.ts`
- Modify: setup/global E2E/docs references returned by inventory
- Modify: achievement files for `ranked_debut` deletion
- Create: destructive cutover migration

### Step 8.1: delete old runtime/routes only after both E2E flows are green

- [ ] Delete old roots/callers:

```text
src/lib/ranked/
src/server/ranked/
src/lib/daily-challenge/
src/server/daily-challenge/
src/pages/api/ranked/
src/pages/api/daily-challenges/
src/pages/api/daily-challenge-attempts/
```

Keep unrelated generic Blackjack rules.

- [ ] Remove old scheduled jobs and keep only `blackjackRunExpiration` for this domain.

### Step 8.2: delete Ranked Debut product plumbing

- [ ] Remove `ranked_debut` from:
  - achievement ID union/list;
  - achievement definitions;
  - special grant-source type if no other consumer remains;
  - tests/profile fixtures/copy.

- [ ] Delete old `ranked_debut_100` reward assumptions with the old repository.

### Step 8.3: create destructive migration with active-stake refund

- [ ] Before dropping `ranked_session`, refund active committed wagers:

```sql
UPDATE user
SET chipBalance = chipBalance + (
  SELECT ranked_session.committedWager
  FROM ranked_session
  WHERE ranked_session.userId = user.id
    AND ranked_session.status = 'active'
  LIMIT 1
),
updatedAt = unixepoch()
WHERE EXISTS (
  SELECT 1
  FROM ranked_session
  WHERE ranked_session.userId = user.id
    AND ranked_session.status = 'active'
);
```

The current active-owner unique constraint means at most one active old Ranked session per user.

- [ ] Then drop old Ranked/Daily tables/indexes. Do not copy any session/result/history row into Blackjack Run.

- [ ] Remove old Drizzle declarations in the same task.

### Step 8.4: inventory/deletion/anti-abstraction gates

- [ ] Rerun the preflight classification and inspect every surviving old identifier.

- [ ] Runtime grep excluding historical docs:

```bash
git grep -nE \
  'src/(lib|server)/(ranked|daily-challenge)|/api/ranked|/api/daily-challenge|ranked_session|ranked_result|ranked_game_stats|ranked_reward_grant|ranked_rate_limit|daily_challenge_attempt|daily_challenge_result|seedCommitment|configHash|actionLogHash|receiptHash|scoreVersion|ranked_debut' \
  -- src e2e scripts drizzle CLAUDE.md README.md \
  ':!docs/superpowers/**' || true
```

Expected: no obsolete HPA-553 runtime references.

- [ ] Ensure generic machinery did not reappear:

```bash
git grep -nE 'Adapter|Registry|rate.?limit|seed.?commit|receipt.?hash|config.?hash|ruleset.?version|score.?version|legacy|compat' \
  -- src/lib/blackjack-run src/server/blackjack-run || true
```

Inspect any match; expected architecture matches are empty.

### Step 8.5: final verification

- [ ] Run full quality suite:

```bash
bun run test
bun run lint
bun run format:check
bun run build
bun run test:e2e
```

- [ ] Re-run both focused E2E specs explicitly if the full runner filters/skips either one:

```bash
bunx playwright test e2e/ranked-blackjack.spec.ts e2e/daily-challenge.spec.ts
```

### Step 8.6: prove runtime got smaller

- [ ] Count final module LOC:

```bash
find src/lib/blackjack-run src/server/blackjack-run \
  -type f -name '*.ts' -print0 | xargs -0 wc -l | tail -1
```

Compare to `/tmp/hpa-553-before-loc.txt`. If the new authoritative module approaches/exceeds the deleted stacks, stop and simplify.

- [ ] Inspect net runtime diff:

```bash
git diff --stat origin/main...HEAD
git diff --numstat origin/main...HEAD | awk '{ added += $1; deleted += $2 } END { print "added", added, "deleted", deleted, "net", added-deleted }'
```

Documentation does not justify runtime growth.

### Step 8.7: deployment order

The release is intentionally breaking; do not add dual-read/dual-write support.

- [ ] Deploy the new Worker first:

```bash
bun run deploy
```

- [ ] Confirm deployment health/build completed successfully. A short window where new DB-backed game routes are unavailable before migration is accepted for this hobby project.

- [ ] Immediately apply pending production migrations:

```bash
bun run db:migrate:remote
```

This creates new tables if not already present, refunds active old Ranked stakes, and drops old tables only after the new Worker owns traffic.

- [ ] Verify Ranked and Daily live smoke flows after migration.

**Commit:** `refactor(blackjack): delete legacy run stacks`

---

## Final Acceptance Checklist

- [ ] One concrete Blackjack Run service/repository owns Ranked and Daily.
- [ ] Closed strict Zod protocol; no generic envelope/adapter/session framework.
- [ ] Ranked initial/additional stakes debit atomically with run mutation.
- [ ] Terminal wallet settlement credits gross payout and records true net profit through optional `stats.netProfit`.
- [ ] Existing wallet callers retain prior behavior when `netProfit` is omitted.
- [ ] `SETTLEMENT_CONFLICT` stays retryable; no skipped-wallet result/UI exists.
- [ ] Ranked contributes once per completed run to shared game stats/missions/evaluated achievements.
- [ ] `ranked_debut` and +100 reward are gone.
- [ ] Daily Practice is local and Daily rank/percentile remains.
- [ ] Final persistence is only `blackjack_run` + `blackjack_daily` for this domain; no covering leaderboard index/score/history table.
- [ ] Ranked E2E passed in Task 6 before old deletion.
- [ ] Daily E2E passed in Task 7 before old deletion.
- [ ] Active old Ranked committed wagers are refunded before old table drop.
- [ ] New Worker deploy precedes destructive production migration.
- [ ] Old protocols/hashes/commitments/receipts/rate/history/browser recovery are deleted.
- [ ] Full tests/lint/format/build/E2E pass after cutover.
- [ ] Final authoritative source + tests are materially smaller than the old two stacks.
