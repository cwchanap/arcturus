# HPA-421 — Duplicate Wallet Settlement Mission Regression: Implementation Plan

**Goal:** Turn the now-obsolete `/api/chips/update` race report into one focused, executable regression proof for current wallet settlement.

**Design:** [2026-10-25-wallet-duplicate-mission-regression-design.md](../specs/2026-10-25-wallet-duplicate-mission-regression-design.md)  
**Linear:** [HPA-421](https://linear.app/cwchanap/issue/HPA-421/regression-duplicate-wallet-settlements-must-not-double-count-missions)  
**Delivery:** Implement and verify in **this same draft PR** after design review; do not create another implementation PR.

## Reuse survey

| Requirement | Reuse in main | Action |
| --- | --- | --- |
| Real SQL + transactional batch semantics | `src/lib/wallet/repository.test.ts:createDatabase` wraps `bun:sqlite` with a D1 interface | Reuse without a new harness |
| Fresh settlement + duplicate attempt | `applyWalletSettlementBatch` and `findWalletSettlement` | Reuse direct repository calls |
| Balance and game stats reads | `readWalletBalance`, `readGameStats`, `insertUser`, `command` in repository test | Reuse |
| Progress gate | `src/lib/missions/progress.ts:buildReceiptGateSql` | No production edits expected |
| Fixed mission definitions | `src/lib/missions/registry.ts`: `daily-blackjack-5` and `daily-win-3` | Assert concrete progress |
| Zero-delta receipt blocking | `repository.ts` guarded UPDATE `NOT EXISTS` check | Replace the existing duplicate push test with a fresh-push-then-replay test |
| Other wallet behaviors | Existing repository tests | Do not touch |

## Task 1 — Add real-SQL duplicate-win assertion

**Modify only:** `src/lib/wallet/repository.test.ts`.

- [ ] Add a new user ID (e.g. `mission-duplicate-win`) with a 1,000-chip balance.
- [ ] Call `applyWalletSettlementBatch` for a Blackjack win (`settlementId: 'mission-duplicate-win-1'`, `attemptId: 'winning-attempt'`, delta +100, one round/one win); expect `true`.
- [ ] Query current `daily-blackjack-5` and `daily-win-3` progress by user and mission ID; expect `1` each. Assert balance 1,100, one receipt, and game stats `handsPlayed: 1`, `totalWins: 1`, `netProfit: 100`.
- [ ] Call `applyWalletSettlementBatch` again with the **same settlement ID**, `attemptId: 'losing-attempt'`, and a plausible fresh current balance (`expectedBalance: 1100`, `nextBalance: 1200`); expect `false`.
- [ ] Re-query receipt (must retain `winning-attempt`), balance (1,100), stats (same), and both missions (still `1`). This detects a broken `EXISTS` gate that would match a committed winner's receipt even though the new attempt lost.
- [ ] Submit a *distinct* settlement ID with `expectedBalance: 1100` and expect success; both missions and `handsPlayed` become `2`, and balance becomes 1,200. This protects successful ordinary repeat play.

**Test design note:** Avoid testing `prepareMissionProgressStatements` with a stubbed `onRun` callback: its side effects must be validated by executing real SQL from the repository's D1 batch. The existing fixture DB is shared; distinct user IDs keep assertions independent.

## Task 2 — Replace zero-delta duplicate test with full-batch replay

**Same file.** Replace the existing `guards a zero-delta duplicate even though the balance is unchanged` test, which pre-seeds the receipt and misses the batch's initial INSERT-then-gate ordering, with a fresh-push-then-replay test.

- [ ] For a new user, submit a genuine zero-delta Blackjack push (`rounds: 1, wins: 0, losses: 0`) with a unique settlement ID and `attemptId: 'push-winner'`; expect `true`, unchanged wallet, `handsPlayed: 1`, and `daily-blackjack-5: 1`.
- [ ] Replay the same settlement ID with a different attempt ID, unchanged `expectedBalance` and `nextBalance`, and expect `false`.
- [ ] Confirm only one receipt, one hand in `game_stats`, and `daily-blackjack-5` remains at `1` (not `2`). Remove the pre-seeded-receipt setup rather than retaining a weaker overlapping case.

## Task 3 — Verify, then finish on this branch

- [ ] Run focused test: `bun test src/lib/wallet/repository.test.ts`.
- [ ] Run entire unit/integration suite: `bun run test`.
- [ ] Run style + formatting: `bun run lint && bun run format:check`.
- [ ] Run type and production checks: `bunx --bun astro check && bun run build`.
- [ ] Review the final diff to confirm test-only runtime changes, no schema or migrations, no new dependencies, and one PR linked to HPA-421.
- [ ] If tests unexpectedly fail on the unmodified gate, record the failing SQL case and make **the smallest necessary production fix in this same PR**. Reject speculative ledger-based architecture without a demonstrated failure.
- [ ] Update the draft PR description with test outcomes; mark ready for review only when implementation and checks are complete. Move Linear HPA-421 to Done after merge, not on doc-plan creation.

## Explicit exclusions

No new `mission_sync_ledger`, no Miniflare test subsystem, no parallel request orchestration, no web UI/E2E journey, no historical `/api/chips/update` restoration, and no splitting the ticket into multiple PRs.

## Definition of done

- A unique fresh wallet settlement increments relevant wallet-side effects once.
- A duplicate settlement ID, including a zero-delta duplicate, cannot increment mission or stats a second time.
- A different valid settlement ID still works.
- All checks pass or any failure is documented and addressed on this same PR.
