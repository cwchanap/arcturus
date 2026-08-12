# Small Wallet Settlement Module Design

**Status:** Revised after second repository review; ready for implementation  
**Date:** 2026-08-09  
**Issue:** HPA-545  
**Parent roadmap:** HPA-167  
**Scope:** Replace casual single-player chip-sync implementations with one deliberately small wallet settlement boundary while keeping the repository's existing `src/lib/<domain>` layout.

---

## 1. Why this is the next task

HPA-542 is complete, so private-room poker no longer shares the persistent account wallet. HPA-545 is the next unblocked architecture step and blocks Video Poker plus later cleanup/game work.

The current casual settlement concern is fragmented across the repository:

- Blackjack has pending-stat aggregation, follow-up retries, optimistic rebasing, sync IDs, and rate-limit handling.
- **Live Baccarat settlement is inline in `src/pages/games/baccarat.astro`** with pending stats/retries. `src/lib/baccarat/baccaratClient.ts` is dead runtime code: it is exported by the barrel but is not the page implementation.
- Slots has `ChipSyncCoordinator`, balance-sync state, batching/coalescing, backoff, and unload flushing.
- Keno has a durable outbox, tab ownership/heartbeats, orphan recovery, persisted draining, and replay reconciliation.
- Craps keeps settlement orchestration in a large Astro page, batches resolved rolls, syncs unresolved bet placement/refunds, and has retry/rebase state.
- Single-player Poker performs settlement transport from inside `PokerGame`.
- Roulette owns a second server-authoritative settlement cascade plus `roulette_round` and persisted pending-spin resurrection.
- `/api/chips/update` owns game-specific caps, receipt replay comparison, rate limiting, balance matching, statistics, missions, and achievement-response caching.

The goal is deletion, not configuration of those behaviors behind a larger abstraction.

---

## 2. Goals

- One wallet library owns authenticated casual-game account settlement.
- Every completed casual account event uses one server application function: `settleWalletRound`.
- Client-authoritative games use one thin browser transport: `POST /api/wallet/settle`.
- Roulette remains server-authoritative for bets/RNG/result calculation and calls `settleWalletRound` on the server.
- One fresh settlement updates balance, receipt, game statistics, and direct mission progress atomically.
- `(userId, settlementId)` is idempotent under ordinary sequential and concurrent duplicates.
- A server-only `attemptId` proves which request won a same-ID race so a losing request cannot reuse the winner's receipt to apply stats/missions again.
- Browser settlement failure behavior is shared once: at most one in-memory pending command, explicit retry/reset, no background policy.
- Settlement IDs are created consistently once per event and reused unchanged for manual retry.
- The migration remains intentionally breaking: old receipt rows, browser settlement state, and old endpoint compatibility are discarded.
- Net code/test complexity decreases materially.

## 3. Non-goals and accepted exposure

- Server-authoritative outcomes for currently client-authoritative games.
- Financial-grade recovery.
- Durable browser queues, IndexedDB, Web Locks, cross-tab ownership, background drains, exponential retry workers, or unload beacons.
- Payload signing, canonical hashes, audit logging, or anti-cheat.
- Replaying historical achievement toasts after a duplicate request.
- Recovering a historical Roulette wheel result after a committed response is lost.
- Preserving `/api/chips/update`, `chip_sync_receipt`, `roulette_round`, or old settlement-localStorage formats.
- Moving the repository to `src/modules` or splitting the active schema into per-module files.
- A generic ledger/event bus/repository framework/workflow engine.

### Public leaderboard exposure

Casual game outcomes remain client-authored, so **this design does not make the public chip/stat leaderboards cheat-proof**. Removing the old per-game caps and rate limiter would otherwise allow one corrupted or forged request to write an arbitrarily large integer. Keep two deliberately non-configurable sanity bounds:

```ts
export const MAX_ABSOLUTE_SETTLEMENT_DELTA = 1_000_000;
export const MAX_ABSOLUTE_SETTLEMENT_STAT = 1_000_000;
```

Validation rejects `Math.abs(delta) > MAX_ABSOLUTE_SETTLEMENT_DELTA` and rejects any individual statistic (`rounds`, `wins`, `losses`, `biggestWin`) exceeding `MAX_ABSOLUTE_SETTLEMENT_STAT`.

These are not anti-cheat: a determined authenticated caller can still submit many forged settlements. They are cheap invariants that prevent one request from exploding shared leaderboard/achievement state while remaining above every current per-request game ceiling (the old largest explicit ceiling is 500,000; Craps is 200,000). Do not rebuild the per-game `GAME_LIMITS` table or rate limiter.

---

## 4. Approaches considered

### A. Recommended: one settlement core plus small reusable browser primitives

Keep one server use case plus three small browser-facing primitives:

1. one timed HTTP submit function;
2. one `newSettlementId(game)` helper;
3. one tiny in-memory `createSettlementGate()` for pending/block/retry/reset state.

Games still build their own domain command because wins/losses/round counts are game semantics, but they do not each reimplement the same pending-settlement state machine.

**Why:** six current client-authoritative consumers need exactly the same failure policy, and Video Poker will be the next consumer. Sharing ~30–40 lines now is smaller than six copies and does not introduce persistence, callbacks, timers, policy configuration, or a framework.

### B. One configurable sync framework

Preserve batching/outboxes/rebases/retry policies behind options.

**Rejected:** recreates the current complexity under a new name.

### C. New `src/modules/wallet` + module-owned schema

**Rejected:** structural novelty unrelated to HPA-545. Current domain code lives under `src/lib`, and active tables live in `src/db/schema.ts`.

### D. Client-authoritative Roulette

**Rejected:** transport uniformity does not justify changing Roulette trust semantics.

### E. Per-game retry gates

Let every game own `pendingCommand`, `isBlocked`, `retry`, and `reset` state independently.

**Rejected:** this is one stable wallet-client policy with six immediate consumers. Duplicating it guarantees drift and makes the next game touch another custom state machine.

---

## 5. Repository boundary and reuse

Final shape:

```text
src/lib/wallet/
  types.ts             # SettleRoundCommand / SettleRoundResult / RoundStats
  settlement-id.ts     # regex validation + newSettlementId(game)
  repository.ts        # D1 balance/receipt/stats/mission batch + rows-affected normalization
  settle.ts            # validation, idempotency, <=2 optimistic attempts, achievements
  client.ts            # one fetchJsonWithTimeout POST; no retry policy
  settlement-gate.ts   # one in-memory pending/block/manual-retry helper
  index.ts             # browser-safe exports only
  *.test.ts

src/db/schema.ts                     # walletSettlement remains in the single active schema
src/pages/api/wallet/settle.ts       # auth + JSON parse + settleWalletRound
src/pages/api/roulette/spin.ts       # Roulette validation/RNG + settleWalletRound

src/lib/baccarat/settlement.ts       # pure roundNetDelta -> command
src/lib/craps/settlement.ts           # pure RollResult -> command + available balance math
```

Reuse:

- `GameType` / `isValidGameType` from game stats.
- `MissionGameEvent` and mission prepared-statement machinery.
- `checkAndGrantAchievements` and `createDb`.
- `fetchJsonWithTimeout` from `src/lib/fetch-with-timeout.ts`.
- the positive-only biggest-win accumulation semantics from `chip-sync-batch-sql.ts`.
- D1 rows-affected normalization currently embedded in `/api/chips/update` (`meta.changes` vs `rowsAffected`).

Do not restore `overallRank` on the new receipt. Achievement evaluation already falls back to `getUserRank` when no rank option is supplied.

---

## 6. Public contract, IDs, and client gate

### Settlement command

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
```

Validation:

- settlement ID matches the **existing** sync-ID character contract exactly: `/^[A-Za-z0-9_-]{1,128}$/`;
- `game` is a current `GameType`;
- all numbers are safe integers;
- `rounds >= 1`;
- `wins >= 0`, `losses >= 0`, `wins + losses <= rounds`;
- `biggestWin >= 0`;
- `Math.abs(delta) <= 1_000_000`;
- resulting wallet balance cannot be negative.

There is no `previousBalance`, `statsDelta`, game cap table, replay payload, retry count, or compatibility field.

### Settlement IDs

```ts
export const SETTLEMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function newSettlementId(game: GameType): string {
  return `${game}-${crypto.randomUUID()}`;
}
```

A command is created once for one completed event. Manual retry resends that exact object/ID. Do not mint a new ID on retry.

Roulette may use the same generated ID as the `/api/roulette/spin` request ID. Existing game-engine-local IDs do not need to become wallet identity unless they already naturally identify the completed event.

### Shared in-memory settlement gate

```ts
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

Behavior:

- `settle(command)` stores the command before submitting;
- success clears it and returns the result;
- failure keeps it and rethrows;
- while a command is pending/in flight, `isBlocked === true`;
- `retry()` resubmits the same pending command only when explicitly called;
- `reset()` only clears the gate; the game is responsible for resetting/reloading its own local state from an authoritative starting balance;
- no timers, persistence, automatic retry, callbacks, game-type branches, queue, or multiple pending commands.

This is the only shared browser settlement policy.

---

## 7. Receipt, atomicity, and transitional mission gating

### Final receipt

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

`attemptId` is not browser-visible. It distinguishes the fresh winning request from a concurrent loser that can see the same `(userId, settlementId)` receipt after the batch commits.

### Idempotency retention

`wallet_settlement` rows are permanent tombstones for the lifetime of this design. There is no automated cleanup or TTL. A delayed browser retry can arrive at any point in the user's session, and the `(userId, settlementId)` receipt must remain available so the duplicate path returns the stored balance rather than re-applying effects.

If retention ever needs pruning (e.g. for D1 row-count hygiene), the rule is: prune only rows older than the maximum supported retry window. Until a bounded retry policy is introduced, that window is unbounded, so do not prune. Any future cleanup must be a background job that never blocks a settlement request.

### Guarded batch

A fresh attempt:

1. reads duplicate receipt;
2. reads current balance;
3. validates `nextBalance`;
4. creates `attemptId`;
5. runs one D1 batch:
   - guarded `UPDATE user ... AND chipBalance = ? AND NOT EXISTS(wallet_settlement...)`;
   - receipt insert only when the update changed one row;
   - stats upsert gated on `(userId, settlementId, attemptId)`;
   - mission statements gated on the same identity;
6. normalizes D1 affected-row metadata via the repository-local `getRowsAffected` helper;
7. on zero updated rows, rechecks duplicate; otherwise retries one unrelated balance conflict once;
8. after a second unrelated conflict, returns a normal settlement conflict.

`NOT EXISTS` is required even for `delta === 0`; without it, the same zero-delta command can match the unchanged balance and apply effects again.

### Keep intermediate commits correct

The existing `prepareMissionProgressStatements` is still called by `/api/chips/update` until the final deletion task. Therefore Task 1 must **not** switch its only gate from `chip_sync_receipt` to `wallet_settlement` globally.

Temporarily use an explicit internal union:

```ts
export type ReceiptGate =
  | { kind: 'chip-sync'; syncId: string }
  | { kind: 'wallet'; settlementId: string; attemptId: string };
```

The SQL builder selects one of two fixed, code-owned `EXISTS` clauses. It must not interpolate an arbitrary table/column name from input.

- Existing `/api/chips/update` passes `{ kind: 'chip-sync', syncId }` and continues to update missions normally while callers are being migrated.
- New wallet repository passes `{ kind: 'wallet', settlementId, attemptId }`.
- The old `chip-sync` branch is deleted atomically with `/api/chips/update` in the final cleanup task, leaving only the wallet gate.

This is migration scaffolding, not a supported compatibility API.

---

## 8. Statistics, missions, achievements

### Statistics

Fresh settlement:

- `totalWins += stats.wins`;
- `totalLosses += stats.losses`;
- `handsPlayed += stats.rounds`;
- `netProfit += delta`;
- `biggestWin` changes only when the incoming candidate is positive and greater than the stored value.

A push/zero candidate cannot erase a previous biggest win.

### Mission event

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

`roundsWon` continues to use `winsIncrement`; this matters for mixed Craps rolls where net delta can be negative while one or more wagers won.

### Intentional Roulette behavior change

Roulette currently writes balance/stats/achievements but does not feed the mission prepared-statement path. After HPA-545, a **fresh Roulette settlement participates in the same generic mission pipeline as other casual games**. This is intentional normalization:

- generic hands/rounds missions can count the spin when their metric applies;
- `gamesTried` can include Roulette;
- `roundsWon` uses the Roulette command's win count;
- duplicate Roulette settlement does not advance missions again because it never wins a fresh `attemptId` gate.

Add explicit Roulette route/integration coverage for this behavior.

### Achievements

After a fresh atomic wallet batch, run `checkAndGrantAchievements`. Do not store achievement payload on the receipt. Duplicate settlements return stored balance only and do not reconstruct old toast payloads.

Achievement evaluation is **best-effort**: if `checkAndGrantAchievements` throws (transient D1 error) after the batch commits, the settlement result is still returned successfully. The committed receipt prevents a client retry from re-entering the fresh path, which would permanently block the achievement. Instead, the error is logged and the achievement is naturally re-evaluated on the user's next completed round because `checkAndGrantAchievements` reads current state each time. This closes the "committed receipt + thrown error = permanently lost achievement" gap without introducing replay infrastructure.

Do not restore `overallRank` to `wallet_settlement`; the existing achievement service can compute current rank when no explicit rank is passed.

---

## 9. Game migration rules

| Game | New behavior | Delete/simplify |
|---|---|---|
| Blackjack | Build one command at round completion; shared gate owns pending/retry/block state. | pending-stat helpers, follow-up retry/backoff/rebase state |
| Baccarat | **Modify the live Astro page**, using a pure command builder + shared gate. | inline pending/retry state, `balance-sync-state`, dead `baccaratClient.ts` and barrel export |
| Poker | Build one command when the human hand completes; shared gate blocks auto-deal while pending. | direct old endpoint/retry state |
| Slots | One command per spin via shared gate. | coordinator, batching, balance-sync state, unload flush |
| Keno | One command per draw via shared gate. | outbox, heartbeats, tab ownership, orphan/drain state; remove barrel export |
| Craps | Command only when a roll resolves wagers; shared gate blocks next roll while pending. | bet-placement sync, batching, dropped-sync persistence, rebase/backoff, `syncLimits` |
| Roulette | Server result -> `settleWalletRound`; duplicate returns balance only. | second cascade, rate limit, `roulette_round`, pending-spin resurrection, obsolete error-classification branches |

### Baccarat boundary

Do not create or test a new `BaccaratClient`. The page does not instantiate it.

Create only:

```ts
export function buildBaccaratSettlementCommand(
  settlementId: string,
  roundNetDelta: number,
): SettleRoundCommand;
```

It returns one Baccarat round with sign-derived wins/losses and `biggestWin = max(roundNetDelta, 0)`.

`baccarat.astro` imports this helper plus `createSettlementGate`/`newSettlementId`. It deletes inline pending stats, follow-up timers, balance rebase, and `/api/chips/update`. `baccaratClient.ts` and its barrel exports are deleted as dead code.

### Craps boundary

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

No resolved wager -> no command. Otherwise command fields derive only from that roll's resolved evaluations and `result.netDelta`.

Bet placement/clearing remains local. After settlement:

```text
available in-game balance = wallet balance - active at-risk bets
```

### Roulette boundary

Delete `pendingSyncId` / `pendingSyncCreatedAt`, reload resubmission, and `roulette_round` together. A duplicate response adopts authoritative balance, clears unresolved spin state, and returns to betting without inventing a winning number.

Keep ordinary current-page request timeout/error UX where it remains useful, but delete `spin-error-classification` branches/tests whose producer disappears with old rate-limit/recovery semantics.

---

## 10. Breaking DB/browser transition

Create `wallet_settlement`; later drop `chip_sync_receipt` and `roulette_round`. No backfill.

Old browser settlement state is not migrated. Keno outboxes, Craps dropped-sync state, Roulette pending spin recovery, and old coordinator state disappear.

The implementation may use temporary internal migration scaffolding such as the dual fixed receipt gate, but the final merged runtime exposes no old endpoint/schema/client compatibility surface.

### Ordered rollout protocol

Because Worker deployment and remote D1 migration are independent operations, the destructive migration (`DROP TABLE chip_sync_receipt`, `DROP TABLE roulette_round`) must follow an ordered sequence:

1. **Deploy the new Worker** (`wallet_settlement` table + dual mission gate) **before** applying the destructive migration remotely. The Worker code must tolerate the old tables still existing — it does not read them, but their presence is harmless.
2. **Observe completion**: confirm no production traffic hits `/api/chips/update` (check `wrangler tail` for at least one full traffic cycle). The dual gate means old receipts are ignored once all callers use the wallet path.
3. **Apply the destructive migration remotely** (`bun run db:migrate:remote`). This drops `chip_sync_receipt` and `roulette_round`.
4. **Forward recovery**: if the Worker deploys but the remote migration fails:
   - The Worker still functions — it never reads the dropped tables at runtime.
   - Re-run `bun run db:migrate:remote` safely; the `statement-breakpoint` markers let each statement apply independently. If only the `DROP` failed (e.g. table already gone from a partial run), the `IF EXISTS` guard makes re-application idempotent.
   - If migration tracking itself is non-atomic (apply succeeds, `_migrations` record fails), the script prints a manual `INSERT INTO _migrations` command. Run it, then re-run the script to confirm "all migrations applied."
5. **Resume after failure**: there is no rollback path — the migration is intentionally breaking. If the destructive drop fails, old-table rows are simply still present but unused. Re-apply until tracked; verify via `wrangler d1 execute arcturus-db --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"`.

---

## 11. Deletion inventory policy

A handwritten subset is not authoritative. The implementation starts by generating the complete file list from current `main`:

```bash
git grep -lE \
  '/api/chips/update|chip_sync_receipt|roulette_round|ChipSyncCoordinator|KenoSyncOutbox|balance-sync-stats|balance-sync-state|balanceSync|syncLimits|previousBalance|statsDelta|pendingStats|pendingRollSyncs|syncPending|BALANCE_MISMATCH|RATE_LIMITED|sendBeacon|pendingSyncId|pendingSyncCreatedAt|PENDING_SPIN_MAX_AGE_MS' \
  -- src e2e scripts drizzle wrangler.toml CLAUDE.md README.md \
  | sort -u > /tmp/hpa-545-files.txt
```

Every generated path must be classified as `DELETE`, `MIGRATE_TO_WALLET`, `KEEP_NON_SETTLEMENT`, or `HISTORICAL_ONLY`, and the classified path set must exactly equal the grep path set before implementation continues.

Known high-risk paths that must appear in that classification when present include:

```text
src/pages/games/baccarat.astro
src/lib/baccarat/baccaratClient.ts
src/lib/baccarat/index.ts
src/lib/baccarat/balance-sync-state.ts
src/lib/baccarat/balance-sync-state.test.ts

src/lib/keno/index.ts
src/lib/keno/outbox.ts
src/lib/keno/outbox.test.ts

src/lib/roulette/spin-error-classification.ts
src/lib/roulette/spin-error-classification.test.ts
src/lib/roulette/constants.ts
src/lib/roulette/types.ts
src/lib/roulette/RouletteGame.ts
src/lib/roulette/rouletteClient.ts
src/lib/roulette/rouletteClient.test.ts
src/lib/roulette/rouletteClient.integration.test.ts
src/pages/api/roulette/spin.ts

src/lib/blackjack/constants.ts
src/lib/blackjack/balance-sync-stats.ts
src/lib/blackjack/balance-sync-stats.test.ts
src/lib/blackjack/balanceSyncStats.test.ts

src/lib/slots/chip-sync-coordinator.ts
src/lib/slots/chip-sync-coordinator.test.ts
src/lib/slots/balance-sync-state.ts
src/lib/slots/balance-sync-state.test.ts

src/lib/craps/balanceSync.ts
src/lib/craps/balanceSync.test.ts
src/lib/craps/syncLimits.ts
src/pages/games/craps.astro

src/pages/api/chips/update.ts
src/lib/chip-sync-batch-sql.ts
src/lib/chips-update-api.test.ts
src/lib/chips-update.test.ts
src/lib/missions/progress.ts
src/db/schema.ts
src/server/cleanup.ts
src/server/cleanup.test.ts
scripts/setup-local-db.ts
wrangler.toml
CLAUDE.md

e2e/global-setup.ts
e2e/isolated-page.ts
e2e/public-single-player-games.spec.ts
e2e/slots.spec.ts
e2e/roulette.spec.ts
e2e/craps.spec.ts
e2e/ranked-blackjack.spec.ts
e2e/authed-user-preservation.spec.ts
e2e/blackjack-split.spec.ts
```

Historical dated specs/migrations may remain historical where required, but active setup/runtime/current guidance cannot teach the deleted contract.

---

## 12. Testing strategy

### Wallet core

Cover:

- ID regex and uniqueness format;
- absolute delta bound at ±1,000,000;
- safe-integer/stat validation;
- positive/negative/zero delta;
- negative resulting balance;
- sequential and concurrent duplicate idempotency;
- zero-delta duplicate safety via `NOT EXISTS`;
- one unrelated balance conflict retry, then bounded failure;
- `meta.changes` vs `rowsAffected` normalization;
- biggest-win non-regression;
- both temporary mission receipt gate kinds during migration;
- final wallet-only gate after old endpoint deletion;
- achievement result only on fresh settlement;
- settlement gate pending/success/failure/retry/reset behavior;
- timed browser submit with no automatic retry.

### Per-game tests

Per-game settlement tests focus on **command mapping and integration only**. Do not retest the shared pending/retry state machine six times.

- Blackjack: exact split-hand command.
- Baccarat: pure builder + live page integration; no test for dead `BaccaratClient`.
- Poker: final human delta command and auto-deal blocked via shared gate state.
- Slots: one command per spin; no batching/pagehide flush.
- Keno: one command per draw and no outbox/heartbeat state; barrel no longer exports outbox.
- Craps: resolved-roll mapping + available balance math + no wallet call on placement/clear.
- Roulette: server RNG/bet validation retained, fresh wallet settlement advances missions once, duplicate does not reroll/reapply missions, no reload resurrection.

### E2E semantics

Not every old endpoint call is fixture setup. Preserve test intent:

- `e2e/ranked-blackjack.spec.ts` contains a casual account mutation specifically to prove another casual wallet write changes the account while a ranked session exists. Replace that request with `/api/wallet/settle`; do **not** turn it into a direct DB bootstrap.
- `e2e/global-setup.ts` currently posts without `syncId`; its replacement must supply a valid settlement ID or use the existing direct test bootstrap only if the test is strictly fixture setup.
- route intercepts in public single-player, Slots, Craps, Roulette, Blackjack split, and other grep results must be migrated deliberately, not merely URL-renamed.

---

## 13. Complexity acceptance gate

Do not grep entire game directories for generic words and manually review hundreds of unrelated AI/LLM hits.

Check the wallet library plus files actually changed by HPA-545:

```bash
git diff --name-only main...HEAD -- '*.ts' '*.astro' '*.js' \
  | while read -r file; do
      [ -f "$file" ] || continue
      grep -nE 'backoff|outbox|heartbeat|orphan|sendBeacon|BALANCE_MISMATCH|RATE_LIMITED|previousBalance|pendingSyncId|pendingRollSyncs|syncPending' "$file" || true
    done

git grep -nE \
  'backoff|outbox|heartbeat|orphan|sendBeacon|BALANCE_MISMATCH|RATE_LIMITED|previousBalance|pendingSyncId|pendingRollSyncs|syncPending' \
  -- src/lib/wallet
```

Every hit in the changed settlement surface must be intentional (for example a migration-deletion comment or user-facing Retry label). The final wallet must not contain configurable old policies.

---

## 14. Definition of done

- `src/lib/wallet` is the only casual authenticated settlement implementation.
- The wallet includes only the small ID helper, timed client, in-memory settlement gate, server use case, and concrete repository needed by current consumers.
- `walletSettlement` remains in `src/db/schema.ts`.
- `/api/chips/update`, `chip_sync_receipt`, and `roulette_round` are gone from active runtime/schema.
- The temporary `chip-sync` mission gate branch is removed before merge.
- `BaccaratClient` dead code and barrel export are removed; live Baccarat page uses the new boundary.
- All casual games use one stable settlement ID per event and shared in-memory failure gate.
- `MissionGameEvent.delta` is preserved.
- Roulette intentionally joins generic mission progress and duplicates cannot advance it twice.
- A zero/push biggest-win candidate cannot erase an earlier biggest win.
- A global ±1,000,000 sanity bound replaces the per-game cap table; no claim is made that casual leaderboards are cheat-proof.
- Keno barrel, Roulette error classification/constants/setup, E2E/bootstrap, and every other generated grep path are explicitly migrated/deleted/classified.
- Ranked cross-tab E2E semantics remain intact by using the new wallet API for the intentional casual mutation.
- Overall rank is not restored to the receipt; achievements compute rank when needed.
- Focused tests, full tests, lint, formatting, build, and affected/full Playwright gates pass.
- Net code/test complexity decreases and no compatibility framework or new repository-wide structural convention is introduced.
