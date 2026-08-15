# HPA-553 Blackjack Run Consolidation Design

**Linear:** HPA-553 — Unify Ranked Blackjack and Daily Challenge into one Blackjack Run module

## Summary

Replace the parallel Ranked Blackjack and Daily Challenge authoritative-session stacks with one Blackjack-specific run lifecycle for exactly two modes: `ranked` and `daily`.

The consolidation remains deletion-first and deliberately concrete:

- Keep repository conventions: shared/domain code under `src/lib/<domain>`, Worker orchestration under `src/server/<domain>`, active Drizzle declarations in `src/db/schema.ts`.
- Move/de-version the existing deterministic Ranked engine and Daily replay/window/seed/scoring behavior rather than rewriting them.
- Use one closed Zod protocol for start, command, and public state.
- Keep one run repository/service, one sequenced command path, one expiration scanner, and one browser transport.
- Preserve Ranked's existing **real stake debit** semantics: initial wager is removed from the account when the run starts, and split/double additional wagers are removed atomically with the command.
- Use the shared wallet settlement once at Ranked terminal to credit the gross payout and record the final gameplay statistics/missions/evaluated achievements.
- Keep Daily Practice browser-local and keep the current-period leaderboard, including current-user rank and percentile.
- Delete adapter/version/hash/commitment/receipt/rate-limit/history/legacy-browser machinery.
- Add the two new tables before page migration; drop old tables only when old runtime is removed.
- Delete `ranked_debut` and its +100-chip bonus instead of preserving a Ranked-only reward path.

This is a Blackjack module, not a generic game-session framework.

## Why the previous terminal-only wallet design is rejected

The current Ranked implementation already debits the wager at start and debits each additional split/double wager with the action. Deferring all chip movement until terminal would change the economics of an authoritative 15-minute run: the same account chips could be spent by another game while the Ranked run still claims them.

That regression is also what created the proposed `walletStatus: 'skipped'` terminal policy. Preserve the simpler shipping invariant instead:

> **Every accepted Ranked wager is paid immediately; terminal settlement only credits payout.**

This is not a wallet escrow/reservation system. It is ordinary game stake movement already present in Ranked today.

A naive attempt to model stake debits as `settleWalletRound(... stats.rounds = 0)` is also rejected. `settleWalletRound` currently couples each settlement to shared game statistics, mission progress, and evaluated achievements. A stake debit is not a completed round and must not trigger those surfaces. It also cannot atomically create/advance the Blackjack run if called as a separate transaction.

Therefore HPA-553 keeps the existing small guarded debit pattern inside the Blackjack Run repository and makes one narrow wallet extension for terminal accounting: `RoundStats` may carry an optional `netProfit` override when wallet movement differs from final game profit.

## Reuse survey

Move or call the existing implementation instead of hand-rolling equivalents:

| Concern | Reuse |
| --- | --- |
| Deterministic Blackjack round | `src/lib/ranked/blackjack/engine.ts` + projection/tests |
| Daily multi-round replay | `src/lib/daily-challenge/replay.ts` |
| Daily UTC window | `src/lib/daily-challenge/config.ts` |
| Period key | `getDailyPeriodKey` from `src/lib/missions/periods.ts` |
| Daily score ordering + percentile | `src/lib/daily-challenge/scoring.ts` |
| Ranked/Daily seed/deck helpers | existing Ranked/Daily random helpers, stripped of version/commitment-only pieces |
| Wallet balance/terminal settlement | `readWalletBalance`, `settleWalletRound` |
| Ranked stake debit | guarded start/action SQL pattern from current Ranked repository |
| Browser timeout | `fetchJsonWithTimeout` |
| Expiration scanner | Ranked cursor pagination, poison-row advance, page size, 25s budget |
| D1 integration harness | current Ranked Miniflare/migration helper |
| Active-owner uniqueness | nullable `activeUserId` pattern already used by Ranked |

No generic reusable dice/game/session/adapter framework is introduced.

## Final repository shape

```text
src/lib/blackjack-run/
  protocol.ts        # closed Zod request/response contract + inferred types
  engine.ts          # moved deterministic single-round Blackjack
  ranked.ts          # wager rules, terminal payout/stats mapping, expiry outcome
  daily.ts           # moved Daily window/replay/seed/scoring/percentile behavior
  client.ts          # shared browser transport/recovery
  ranked-ui.ts       # Ranked DOM behavior
  daily-ui.ts        # Daily DOM behavior + local Practice

src/server/blackjack-run/
  repository.ts      # concrete D1 persistence + atomic Ranked stake debit
  service.ts         # shared run lifecycle
  http.ts            # error/response mapping around shared Zod schemas
  expiration.ts      # moved cursor/budget scanner

src/pages/api/blackjack-runs/
  index.ts
  current.ts
  [runId]/index.ts
  [runId]/commands.ts

src/pages/api/blackjack-daily/
  current.ts
  [periodKey]/leaderboard.ts
```

No barrel file is required for `blackjack-run`; callers import the owning file directly.

## Closed protocol

Use Zod as the one runtime/type boundary. Infer TypeScript types from the schemas.

Start input:

```ts
export const blackjackRunStartSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('ranked'),
    requestId: requestIdSchema,
    wager: safeIntegerSchema.min(10).max(1000),
  }).strict(),
  z.object({
    mode: z.literal('daily'),
    requestId: requestIdSchema,
    periodKey: periodKeySchema,
  }).strict(),
]);
```

Command input is also fully strict:

```ts
export const blackjackRunCommandSchema = z.discriminatedUnion('command', [
  z.object({
    sequence: sequenceSchema,
    command: z.literal('start-round'),
    wager: safeIntegerSchema,
  }).strict(),
  z.object({
    sequence: sequenceSchema,
    command: z.enum(['hit', 'stand', 'double-down', 'split']),
  }).strict(),
  z.object({
    sequence: sequenceSchema,
    command: z.literal('forfeit'),
  }).strict(),
]);
```

The public response is a closed `ranked | daily` discriminated union, not `Envelope<TState, TResult>`. The Ranked branch includes the current account balance needed by the UI; the Daily branch includes virtual bankroll/progress. No protocol/ruleset version, hashes, commitments, receipt fields, compatibility parsers, or generic type parameters remain.

## Deterministic core

### Single-round engine

`engine.ts` moves the current Ranked engine/projection and removes Ranked/version vocabulary. It keeps imports from shared Blackjack hand/dealer/payout helpers.

```text
seed + initial wager + ordered Blackjack actions -> state + legal actions + outcome
```

No adapter registry or game dispatch survives.

### Daily replay, window, scoring, and standing

`daily.ts` moves the current useful Daily behavior:

- starting virtual bankroll 1,000;
- 10 rounds;
- wager 10–1,000;
- 30-minute attempt TTL;
- ranked entry closes 30 minutes before UTC day end;
- bankroll-below-minimum is an eligible `completed` terminal;
- explicit forfeit is ineligible;
- expiration is ineligible;
- deterministic distinct per-round seeds;
- calendar-valid UTC period windows;
- `compareDailyScores` ordering;
- `calculateDailyPercentile` current-user standing.

Leaderboard ordering remains:

1. ending bankroll descending;
2. rounds completed descending;
3. settled time ascending;
4. user ID as deterministic final tie-breaker.

The leaderboard response keeps the existing current-user standing shape: `rank`, `totalEligible`, and `percentile`.

## Ranked mode

Ranked remains one authoritative Blackjack round with current game rules and a 15-minute TTL.

### Start: atomic initial stake debit

1. Parse/validate the Ranked start request.
2. Resolve request-id replay before creating anything.
3. Read current account balance for user-facing validation.
4. Generate run ID/seed and replay the opening hand.
5. In one guarded D1 batch, insert the active run and subtract the initial wager from `user.chipBalance`.
6. If the guarded debit loses a balance/active-run race, do not leave a new active row; return the normal balance/active-run error.
7. Return the post-debit balance in the public Ranked state.

Move/simplify the current Ranked start transition SQL rather than redesigning it.

### Split/double: atomic additional stake debit

For an action with `additionalWager > 0`, append the sequenced command and subtract that additional wager in the same guarded D1 batch. If the account cannot cover it or the sequence lost a race, neither side applies.

Ordinary hit/stand commands only advance the guarded run command log.

There is no reservation table, escrow record, cross-game account ownership lock, or rate limiter.

### Minimal wallet extension for terminal accounting

Current `SettleRoundCommand.delta` is both wallet movement and the `game_stats.netProfit`/mission delta. After pre-debiting Ranked stakes, those are no longer the same number at terminal:

- wallet movement = gross payout to credit back;
- game net profit = payout minus all committed stakes.

Extend `RoundStats` with one optional field:

```ts
interface RoundStats {
  rounds: number;
  wins: number;
  losses: number;
  biggestWin: number;
  netProfit?: number;
}
```

Wallet behavior:

- existing callers omit it and retain `netProfit = command.delta`;
- when provided, validate it as a bounded safe integer;
- `game_stats.netProfit` and mission `delta` use `stats.netProfit ?? command.delta`;
- mission outcome is derived first from `wins/losses`, then from net-profit sign for push/other callers;
- wallet balance mutation still uses `command.delta`;
- achievement evaluation still happens once for a completed round.

Do **not** relax `rounds >= 1`; stake debits never go through `settleWalletRound`.

### Terminal settlement

A Ranked terminal outcome builds one stable payout settlement:

```ts
{
  settlementId: `blackjack-run-${run.id}`,
  game: 'blackjack',
  delta: outcome.payout,
  stats: {
    rounds: 1,
    wins: outcome.result === 'win' ? 1 : 0,
    losses: outcome.result === 'loss' ? 1 : 0,
    biggestWin: Math.max(0, outcome.gameNetDelta),
    netProfit: outcome.gameNetDelta,
  },
}
```

The terminal wallet delta is always non-negative because stakes were already paid. `INSUFFICIENT_BALANCE` is therefore not a valid normal terminal failure and no `walletStatus: 'skipped'` result exists.

Normal terminal flow:

1. replay and derive terminal outcome;
2. call `settleWalletRound` with the stable run-derived settlement ID;
3. persist terminal result + returned balance and clear `activeUserId`;
4. if wallet settlement committed but run finalization lost a race, retrying the stable settlement ID returns the wallet receipt and converges.

### `SETTLEMENT_CONFLICT` remains retryable

`SETTLEMENT_CONFLICT` means the wallet CAS lost twice; it is a transient concurrency condition, not a reason to delete a payout.

On this error:

- leave the run active;
- return a retryable Blackjack Run error;
- `current`, `loadRun`, or the next expiration tick may call terminal finalization again;
- the stable settlement ID preserves idempotency;
- expiration scanner advances past the row for the current page so it cannot block later rows, then the next cron invocation can reconsider it.

Unexpected wallet errors remain loud.

### Shared progression is an intentional shipping change

The old Ranked stack writes `ranked_game_stats` and a bespoke Ranked debut reward. The unified terminal now uses the shared wallet pipeline, so a completed Ranked round intentionally:

- contributes to normal `game_stats` under `blackjack`;
- advances applicable daily/weekly missions once;
- participates in normal evaluated achievements;
- no longer writes `ranked_game_stats`.

This is a product behavior change, not an incidental implementation detail.

### Ranked Debut cut

Delete `ranked_debut` from achievement IDs/definitions/grant-source types and delete the `ranked_debut_100` +100-chip first-Ranked reward. Do not preserve a one-off `grantAchievement` path.

## Daily mode

### Daily definition

Keep one minimal definition table:

```text
blackjack_daily
  periodKey PRIMARY KEY
  seed      NOT NULL
  createdAt NOT NULL
```

Create the current row lazily. Concurrent first accesses race on the
`periodKey` primary key: exactly one insert wins, and losers reload and return
the winning row's seed — every run for the period then replays against one
canonical seed, and the locally generated losing seed is discarded. Derive
starts/entry-close/end timestamps from `periodKey`. Delete persisted Practice
seed and version/config/commitment fields.

### Ranked Daily attempt

- one persisted Daily run per `(userId, periodKey)`;
- virtual bankroll only; never account wallet mutation;
- `completed` means leaderboard-eligible by construction;
- eligible completion writes `dailyEndingBankroll` + `dailyRoundsCompleted`;
- forfeit/expiration keep those projections null.

### Practice

Practice uses a browser-generated seed and the same pure Daily replay. Restart creates a new local seed. No API row, storage key, receipt, history, or cleanup job.

### Retained and deleted Daily surface

Retain:

- today's leaderboard;
- current-user rank;
- total eligible count;
- percentile standing shown in result/leaderboard UI.

Delete:

- exact-ranked replay;
- historical period replay page;
- seven-day history;
- server-backed Practice;
- receipt/hash/commitment/version display and copy.

## Persistence

Final domain tables are `blackjack_run` and `blackjack_daily` only.

### `blackjack_run`

```text
id                    PRIMARY KEY
userId                FK user.id
activeUserId          nullable FK user.id; equals userId only while active
mode                  'ranked' | 'daily'
periodKey             nullable; Daily only
startRequestId        idempotency key
initialWager          nullable; Ranked only
seed                  server-only encoded seed
commandsJson          ordered commands
nextSequence          integer
status                active/completed/forfeited/expired
resultJson            nullable terminal result
dailyEndingBankroll   nullable; Daily completed only
dailyRoundsCompleted  nullable; Daily completed only
expiresAt
createdAt
updatedAt
settledAt              nullable
```

Final indexes/constraints:

- unique `(userId, startRequestId)`;
- unique `(activeUserId, mode)`;
- unique `(userId, mode, periodKey)`;
- `(status, expiresAt)`;
- `(mode, periodKey, status, dailyEndingBankroll, dailyRoundsCompleted)` serving the leaderboard filter and leading sort keys.

No Daily score table, result table, or history table.

Leaderboard query filters `mode='daily'`, period, and `status='completed'`, then orders by the retained score/tie-break rules. The two score projection columns avoid JSON extraction.

### Concrete repository responsibilities

The repository remains one concrete file, but it may expose explicit mode operations rather than a generic options object:

```text
createRankedRunWithStake
createDailyRun
findOwnedRun
findByStartRequest
findActiveRun
findDailyRun
appendRankedCommandWithStake
appendDailyCommand
finishRun
listExpiredPage
getOrCreateDaily
listDailyLeaderboard
```

`createRankedRunWithStake` atomically inserts the run and debits the initial wager. `appendRankedCommandWithStake` atomically appends the command and debits any additional wager. These are moved/simplified from current working Ranked transition SQL.

## Implementation sequencing

Every intermediate commit must remain runnable:

1. Move pure engine/Daily/protocol behavior without deleting old code.
2. Add the small wallet `stats.netProfit` override with wallet tests.
3. Add `blackjack_run` + `blackjack_daily` beside old schema and create them with an additive migration.
4. Build the new service/routes/expiration while old runtime remains intact.
5. Switch Ranked page and its E2E.
6. Switch Daily page and its E2E.
7. Delete old runtime/schema/tables together.

Temporary old/new table coexistence is implementation sequencing only. There is no dual-read/dual-write compatibility path and no historical result migration.

## HTTP surface

Keep six thin routes:

- `POST /api/blackjack-runs`
- `GET /api/blackjack-runs/current?mode=ranked|daily`
- `GET /api/blackjack-runs/:runId`
- `POST /api/blackjack-runs/:runId/commands`
- `GET /api/blackjack-daily/current`
- `GET /api/blackjack-daily/:periodKey/leaderboard`

The by-ID route has a concrete consumer: after a command/start response is lost, `client.loadRun(runId)` fetches the exact run—including a terminal Ranked result that may no longer be returned by an active-only `current` lookup. This keeps uncertain-request recovery small and explicit.

`SEQUENCE_MISMATCH` also returns `expectedSequence`; the client calls `loadRun(runId)` to adopt server state.

No old endpoint compatibility, localStorage ownership, persisted queue, automatic backoff, or legacy parser remains.

## Browser client

`client.ts` reuses `fetchJsonWithTimeout` and exposes only:

```text
loadCurrent(mode)
loadRun(runId)
startRanked(...)
startDaily(...)
command(runId, ...)
```

One request may be in flight. Network/timeout/conflict errors are surfaced; explicit `loadRun`/retry recovers. Ranked/Daily DOM code remains separate.

## Expiration

Move the robust Ranked scanner:

- stable `(expiresAt, id)` cursor;
- page-size reuse;
- cursor advance after every attempted row, including failures;
- 25-second wall-clock budget and pre-row deadline check;
- fresh scan next scheduled invocation.

For Ranked expiration, derive the all-committed-wagers loss outcome. Stake has already been debited, so terminal wallet settlement has `delta = 0`, `stats.losses = 1`, and `stats.netProfit = -committedWager`. A transient `SETTLEMENT_CONFLICT` leaves the run active for a later invocation; the cursor prevents head-of-line blocking in the current invocation.

Daily expiration simply stores `expired` with null leaderboard projections.

Delete Ranked rate cleanup and Daily retention/reaping.

## Destructive cutover and in-flight old Ranked wagers

Historical Ranked/Daily results are not migrated, but already-debited **active Ranked stakes are live wallet state**, not history.

Before dropping `ranked_session`, the destructive migration refunds every active old session's `committedWager` to its owner, then drops the old Ranked/Daily tables. No session/result row is copied into the new model.

This one-time refund is intentionally small and prevents the cutover from silently deleting chips already removed by the shipping Ranked implementation.

## Deployment order

The release remains intentionally breaking and accepts a short maintenance
window, structured as expand → deploy → contract:

1. apply the additive D1 migrations (new `blackjack_run`/`blackjack_daily`
   tables and their indexes) **before** deploying — the old Worker ignores the
   new tables, so this is safe while old traffic is live;
2. deploy the new Worker code and move traffic to it — the new Worker runs
   against the additive schema while the old tables still exist;
3. once the new Worker is confirmed healthy and owns traffic, apply the
   destructive cutover migration: refund every active old Ranked stake, then
   drop the old Ranked/Daily tables;
4. verify Ranked start/action/terminal and Daily current/leaderboard paths.

Never apply the destructive drop while the old Worker is still serving
requests. Do not build dual-read/dual-write compatibility solely to eliminate
the short cutover window.

## Risks and mitigations

### Stake/run atomicity

**Risk:** separating an account debit from run creation/action append can either lose chips or create an unfunded run.

**Mitigation:** move the current guarded D1 batch pattern so initial debit + run insert and additional debit + command append are atomic operations.

### Terminal wallet CAS conflict

**Risk:** concurrent casual wallet writes may make the terminal payout CAS lose twice.

**Mitigation:** keep the gameplay run active and return a retryable conflict; stable settlement ID + `loadRun`/next cron tick converge. Do not convert a transient conflict into a skipped payout.

### Schema cutover

**Risk:** old code cannot run after old tables are dropped.

**Mitigation:** add new tables first during implementation; delete/drop old runtime/storage only in the final task. Production deploys the new Worker before running the destructive migration.

### In-flight old stake

**Risk:** active old Ranked sessions have already debited `committedWager`.

**Mitigation:** refund active committed wagers immediately before dropping `ranked_session`.

## Testing strategy

### Pure/protocol

- move engine/projection behavior tests;
- move Daily replay/window/seed/scoring/percentile tests;
- test all command Zod members are `.strict()`;
- test Ranked terminal command maps `delta=payout` and `stats.netProfit=gameNetDelta`.

### Wallet

Add focused tests for optional `stats.netProfit`:

- omitted field preserves existing behavior;
- provided field controls `game_stats.netProfit` and mission delta while `delta` still controls wallet balance;
- loss with payout `delta=0`, `losses=1`, negative `netProfit` is classified as a loss event;
- invalid/unbounded override is rejected.

### Repository/service

- start stake debit and run creation apply atomically;
- failed start debit leaves no run;
- split/double stake debit and command append apply atomically;
- failed additional debit leaves sequence/command unchanged;
- terminal payout + stats use stable settlement ID;
- `SETTLEMENT_CONFLICT` leaves active row and later retry converges;
- wallet receipt followed by failed `finishRun` converges on retry;
- Daily one-attempt/replay/completion/standing/expiration behavior.

### E2E timing

Rewrite and run each mode's E2E **in the same task that swaps its page**:

- Ranked Task: start, stake debit, action, reload/resume, terminal payout/result, second run.
- Daily Task: local Practice without POST, one ranked attempt, reload/resume, completion, rank/percentile + leaderboard, no history/replay UI.

Final cutover task reruns the full suite but does not postpone first E2E discovery until after deletion.

## Explicit shipping changes

- Ranked no longer grants `ranked_debut` or +100 first-Ranked chips.
- Ranked completed rounds now contribute to shared `game_stats`, applicable missions, and evaluated achievements instead of `ranked_game_stats`/Ranked-only reward plumbing.
- Daily Practice becomes browser-local.
- Exact Ranked Replay, historical Daily replay, and seven-day history are removed.
- Daily rank/percentile is **retained**.

## Non-goals

- generic game session/event/workflow framework;
- another game mode/type;
- historical result migration;
- replay/history UI;
- weekly leaderboard;
- provably-fair/commitment/receipt displays;
- anti-cheat/tamper evidence;
- durable rate limits;
- wallet escrow/reservation/account lock tables;
- special Ranked achievement/reward pipeline;
- financial-grade recovery;
- backward-compatible APIs/browser state.

## Acceptance criteria

- Ranked and Daily use one Blackjack Run service and concrete repository.
- Closed Zod schemas own the public contract; command union members reject unknown fields.
- Existing engine/Daily/window/scoring/seed/expiration/D1-test behavior is moved/reused.
- Ranked initial and additional wagers are real atomic account debits, preserving current stake semantics.
- Ranked terminal credits gross payout through `settleWalletRound`; shared stats/missions use the true net result through the one optional `stats.netProfit` override.
- No skipped-wallet terminal policy exists; transient `SETTLEMENT_CONFLICT` remains retryable.
- Final persistence is only `blackjack_run` + `blackjack_daily`, with no separate Daily score/history table (a plain leaderboard index on `blackjack_run` is allowed).
- Daily current-user rank/percentile remains available.
- Old active Ranked committed wagers are refunded before old table drop.
- `ranked_debut`/+100 is removed and Ranked now participates in shared stats/missions/evaluated achievements.
- Ranked and Daily E2E are green in their respective page-migration tasks and again at final verification.
- Old parallel protocol/coordinator/repository/rate/hash/commitment/history/browser machinery is deleted.
- Final authoritative source + tests are materially smaller than the two old stacks.

## Design self-review

- **Placeholder scan:** no unresolved placeholders.
- **Consistency:** real stake debit removes the prior insufficient-funds terminal failure; wallet settlement is payout-only but shared stats retain true net profit.
- **Scope:** one small wallet field is introduced only because there is a concrete Ranked consumer; no zero-round or transaction-hook abstraction is added.
- **Cutover:** in-flight old stakes are explicitly refunded; Worker deploy precedes destructive migration.
- **Recovery:** by-ID fetch has a concrete uncertain-terminal consumer and transient wallet conflicts remain retryable.
