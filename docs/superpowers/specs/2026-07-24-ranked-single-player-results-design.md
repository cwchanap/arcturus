# Server-Verifiable Ranked Single-Player Results — Design

**Status:** Approved (brainstorming phase complete)  
**Date:** 2026-07-24  
**Issue:** HPA-170  
**Scope:** Generic ranked-session platform plus one-hand Blackjack reference implementation.

---

## 1. Context

Arcturus deliberately supports two different trust models:

- Guest and casual authenticated games run locally and may use the existing client-authoritative `POST /api/chips/update` flow.
- Ranked or rewarded games must derive every result from authoritative server state.

The casual path is appropriate for play-money sessions, but it cannot support ranked challenges, seasonal rewards, or competitive missions because callers can submit arbitrary chip deltas and statistics. The new ranked platform creates a separate trust boundary rather than changing the existing casual contract.

Roulette already demonstrates game-specific server settlement, and multiplayer poker already demonstrates server-owned state. HPA-170 adds a reusable single-player session contract: hidden server randomness, deterministic replay, sequenced actions, durable throttling, and exactly-once settlement.

---

## 2. Goals and non-goals

### 2.1 Goals

- Create authenticated ranked sessions with server-stored configuration and hidden randomness.
- Make each accepted player action replayable and deterministic.
- Prevent callers from earning ranked rewards through an arbitrary score, result, or chip delta.
- Settle wagers, payouts, ranked statistics, achievements, and rewards exactly once.
- Return the same immutable receipt for every valid retry of a completed session.
- Reject reuse of an identifier or action sequence with different content.
- Use durable D1 rate limiting that works across Cloudflare Worker isolates.
- Ship Blackjack as the first complete ranked reference implementation.
- Keep guest and authenticated casual Blackjack available independently.
- Establish versioned extension points for future daily challenges and seasonal leagues.

### 2.2 Non-goals

- Converting existing casual games to server authority.
- Treating virtual chips as money or adding cash-value wagering.
- Implementing daily challenge catalogs, attempt quotas, shared challenge seeds, seasons, leagues, or leaderboards.
- Adding a general wallet ledger for every existing game.
- Supporting offline ranked play or end-of-session client-authoritative logs.
- Supporting multiple ranked games in HPA-170.
- Revealing ranked seeds or future deck state to clients.
- Adding a new Durable Object class.

---

## 3. Approved product decisions

| Topic | Decision |
|---|---|
| Reference game | Blackjack |
| Authority model | Live connection; every player action is validated by the server |
| Session scope | One Blackjack round, including any split hands |
| Abandonment | Expiration forfeits every committed wager |
| Route | Authenticated-only `/games/blackjack/ranked` |
| Casual mode | `/games/blackjack` remains guest-safe and explicitly casual |
| Ranked statistics | Separate from existing client-authoritative `game_stats` |
| State store | D1-backed deterministic replay, not a new Durable Object |
| Active sessions | At most one ranked session per user |
| Multiplayer interaction | Ranked sessions and multiplayer escrow are mutually exclusive |
| First ranked reward | `ranked_debut` achievement plus a one-time 100-chip reward |

---

## 4. Architecture

### 4.1 Topology

```text
Ranked Blackjack page
        |
        | POST start / POST action / GET resume
        v
Thin Astro API routes
        |
        v
Ranked session coordinator
   |          |             |
   |          |             +--> durable D1 rate-limit counters
   |          +--> versioned Blackjack ranked adapter
   |                    |
   |                    +--> deterministic deck + pure replay reducer
   |
   +--> transactional D1 persistence
          ranked_session
          ranked_result
          ranked_game_stats
          ranked_reward_grant
          user / user_achievement
```

The browser never owns ranked game state. It renders only the public state returned by the server and sends one sequenced action at a time.

The coordinator owns authentication, idempotency, rate limiting, persistence, wallet effects, terminal settlement, and receipt construction. It delegates only deterministic game rules and public-state projection to a versioned game adapter.

### 4.2 Why D1 replay instead of a Durable Object

A ranked Blackjack round is single-player, short-lived, and strictly turn-based. D1 provides the durability and conditional writes needed for this workload without adding another stateful service, migration class, alarm lifecycle, or recovery protocol.

Each action rebuilds authoritative state from a small immutable input:

```text
ruleset version + hidden seed + canonical configuration + accepted action log
```

The replay cost is bounded by one Blackjack round and is small compared with network and database latency. D1's transaction serialization plus explicit session sequence numbers resolve concurrent requests.

### 4.3 Generic platform components

The ranked platform is divided into focused units:

- **Protocol and canonicalization:** validates identifiers, configuration, actions, and canonical JSON hashes.
- **Session coordinator:** starts, resumes, advances, expires, and settles sessions.
- **Game adapter registry:** resolves a `(gameType, rulesetVersion)` pair to immutable rules.
- **Ranked Blackjack adapter:** creates deterministic state, applies actions, derives terminal effects, and projects safe public state.
- **D1 repository:** reads sessions/results and builds conditional transactional batches.
- **Durable rate limiter:** increments fixed-window D1 counters and returns retry metadata.
- **Expiration service:** finalizes expired sessions lazily and from the scheduled Worker.

Astro API handlers remain thin transport adapters around these services.

---

## 5. Deterministic Blackjack

### 5.1 Versioned configuration

The initial ruleset identifier is `blackjack-ranked-v1`. Its canonical configuration contains integer or boolean fields only:

```json
{
  "gameType": "blackjack",
  "rulesetVersion": "blackjack-ranked-v1",
  "deckCount": 1,
  "minimumWager": 10,
  "maximumWager": 1000,
  "maximumHands": 4,
  "dealerHitsSoft17": false,
  "blackjackProfitNumerator": 3,
  "blackjackProfitDenominator": 2,
  "normalWinProfitNumerator": 1,
  "normalWinProfitDenominator": 1,
  "initialWager": 100
}
```

The selected initial wager is part of the per-session configuration and therefore part of the configuration hash. Changing any rule requires a new ruleset version; historical sessions always replay through the version they recorded.

### 5.2 Randomness boundary

The current deck managers use `Math.random` directly. They gain an optional random source while preserving `Math.random` as the casual default:

```ts
type RandomSource = () => number;
```

Ranked start creates a cryptographically random 256-bit seed with `crypto.getRandomValues`. A versioned deterministic generator derives the same `[0, 1)` sequence from that seed on every Worker or Bun runtime. Fisher-Yates consumes that source to create the deck.

The server stores the seed and a SHA-256 seed commitment. Only the commitment may appear in a receipt. The raw seed, generator state, undealt cards, and future draws are never returned or logged.

The generator algorithm and seed encoding are part of `blackjack-ranked-v1`; they cannot change in place.

### 5.3 Rules

Ranked Blackjack intentionally follows current casual behavior except for an explicit four-hand safety limit:

- One 52-card deck, shuffled once at session start.
- Dealer hits 16 or lower and stands on every 17, including soft 17.
- Normal wins return the wager plus 1:1 profit.
- Blackjack returns the wager plus 3:2 profit; fractional profit rounds down to a whole chip.
- A push returns the wager.
- Double-down is available only on an initial two-card total of 9, 10, or 11.
- Double-down commits another equal wager, deals exactly one card, and ends that hand.
- Split requires equal ranks and commits another equal wager.
- Re-splitting is permitted until the session has four player hands.
- Split hands otherwise use the current evaluator and payout behavior.
- The dealer turn runs automatically after the final player hand completes.
- Natural player or dealer Blackjack may settle during the start request.

### 5.4 Pure replay reducer

The ranked reducer does not read D1, inspect the account balance, use the clock, generate identifiers, or emit UI events. It accepts the configuration, deterministic deck, and canonical accepted actions, then returns:

- Complete internal game state.
- Next expected sequence.
- Legal rule actions.
- Additional wager required by each legal action.
- Terminal outcomes and payouts when complete.

Wallet sufficiency is an external coordinator concern. A double or split is appended only after its additional wager has been committed transactionally. During replay, every logged double or split is therefore known to have been funded.

### 5.5 Public-state projection

The public response may contain:

- Session ID, status, ruleset version, expiry, and next sequence.
- Player hands, hand wagers, hand values, and active-hand index.
- Dealer up-card while active; the full dealer hand only after terminal settlement.
- Total committed wager.
- Available actions, further constrained by current account balance.
- Terminal outcomes and the immutable receipt.

It must not contain:

- Raw seed or deterministic generator state.
- Undealt cards or remaining deck order.
- Dealer hole card before reveal.
- Internal action hashes, repository metadata, or other users' data.

---

## 6. Session and API lifecycle

### 6.1 Start

`POST /api/ranked/sessions`

```json
{
  "requestId": "client-generated-id",
  "gameType": "blackjack",
  "rulesetVersion": "blackjack-ranked-v1",
  "wager": 100
}
```

The server:

1. Authenticates the user.
2. Looks up an existing `(userId, requestId)` before consuming a rate-limit unit.
3. Returns a matching idempotent replay without consuming another unit; mismatched reuse is
   rate-limited and then rejected.
4. Finalizes the user's expired active session, if any.
5. Enforces the durable start limit.
6. Rejects active multiplayer membership or held chips.
7. Validates the ruleset and wager.
8. Generates the session ID, seed, seed commitment, configuration, and opening state.
9. Atomically creates the session and deducts the wager.
10. If the opening deal is terminal, atomically creates the result and returns its receipt.

The client generates and persists `requestId` before sending the request. A retry with the same payload returns the same session or receipt without another deduction.

### 6.2 Action

`POST /api/ranked/sessions/:sessionId/actions`

```json
{
  "sequence": 0,
  "action": "hit"
}
```

Valid actions are `hit`, `stand`, `double-down`, and `split`. The server:

1. Authenticates ownership without revealing whether another user's session exists.
2. Detects an already-recorded sequence before consuming a rate-limit unit.
3. Returns the existing state for the same canonical action without consuming another unit.
4. Rate-limits and then rejects a different action at the same sequence.
5. Enforces expiration and durable action limits.
6. Replays the authoritative state and validates the action.
7. Checks any additional wager against the current account balance.
8. Conditionally applies the wallet effect and appends exactly one canonical action.
9. Settles atomically if the action reaches a terminal state.

No client timestamp, score, card, payout, chip delta, or final-state field is accepted.

### 6.3 Resume

`GET /api/ranked/sessions/:sessionId`

The server authenticates ownership, finalizes the session if it has expired, replays active state, and returns public state or the stored terminal receipt. Resume is safe after a page reload, uncertain network response, or browser restart.

### 6.4 Sequence rules

- The first player action uses sequence `0`.
- Every accepted action increments `nextSequence` by one.
- The same sequence and same canonical action returns the same resulting state or receipt.
- The same sequence with different content returns `409 IDENTIFIER_REUSE_MISMATCH`.
- A sequence greater than `nextSequence` returns `409 SEQUENCE_MISMATCH` with the expected value.
- An action after terminal settlement returns the stored receipt.

### 6.5 Expiration and abandonment

An active session expires 15 minutes after the opening deal. The server clock is authoritative.

Expiration:

- Changes the terminal status to `expired`.
- Treats every committed wager as lost.
- Credits no game payout.
- Updates ranked statistics with one loss and one forfeit.
- Creates an immutable receipt.
- Does not grant Ranked Debut.

Expiration is applied lazily during start, action, or resume. The scheduled Worker also finalizes all overdue sessions as a global backstop. Because every wager is deducted when committed, abandonment cannot release unearned chips or leave an unsettled hold on the account.

---

## 7. Persistence model

### 7.1 `ranked_session`

One row contains the complete replay material and mutable session cursor:

| Field | Purpose |
|---|---|
| `id` | Opaque session primary key |
| `userId` | Authenticated owner |
| `startRequestId` | Client idempotency key |
| `startPayloadHash` | Detects request-ID reuse with different content |
| `activeUserId` | Equals `userId` while active; `NULL` when terminal |
| `gameType` | `blackjack` in v1 |
| `rulesetVersion` | `blackjack-ranked-v1` |
| `configJson` / `configHash` | Canonical immutable configuration |
| `seed` / `seedCommitment` | Server-only replay seed and public-safe commitment |
| `actionLogJson` / `actionLogHash` | Canonical accepted actions and hash |
| `nextSequence` | Optimistic concurrency cursor |
| `initialWager` | Opening wager |
| `committedWager` | Opening plus accepted double/split wagers |
| `status` | `active`, `settled`, or `expired` |
| `expiresAt` | Authoritative expiry |
| `createdAt`, `updatedAt`, `settledAt` | Audit timestamps |

Constraints and indexes:

- Primary key on `id`.
- Unique `(userId, startRequestId)`.
- Unique nullable `activeUserId`, enforcing one active ranked session per user.
- Index on `(status, expiresAt)` for scheduled expiration.
- Index on `(userId, createdAt)` for history and support lookup.

### 7.2 `ranked_result`

The receipt is immutable and keyed by `sessionId`:

| Field | Purpose |
|---|---|
| `sessionId` | Primary key and one-result-per-session guard |
| `userId`, `gameType`, `rulesetVersion` | Ownership and rules identity |
| `seedCommitment`, `configHash`, `actionLogHash` | Verification inputs |
| `outcomeJson` | Canonical per-hand result |
| `initialWager`, `committedWager` | Stake accounting |
| `payout` | Returned stake plus game profit |
| `gameNetDelta` | `payout - committedWager` |
| `rewardDelta` | Non-game ranked reward, 100 only for first Ranked Debut |
| `balanceAfter` | Account snapshot after this settlement batch |
| `statsEffectsJson` | Exact ranked aggregate effects |
| `achievementEffectsJson` | Newly granted achievement IDs |
| `rewardEffectsJson` | Newly granted reward IDs and amounts |
| `receiptHash` | SHA-256 of canonical receipt fields |
| `settledAt` | Authoritative settlement time |

The session's seed remains server-only. A stored result plus its session replay material lets the server independently reproduce and audit the receipt.

### 7.3 `ranked_game_stats`

Ranked aggregates are separate from casual `game_stats` and keyed by `(userId, gameType)`:

- `sessionsPlayed`
- `totalWins`
- `totalLosses`
- `totalPushes`
- `totalForfeits`
- `netProfit`
- `biggestWin`
- `updatedAt`

A split round counts as one ranked session. Its overall classification is:

- `win` when total payout exceeds total committed wager.
- `loss` when total payout is lower.
- `push` when equal.
- `expired` always increments loss and forfeit.

Per-hand outcomes remain in the immutable receipt.

### 7.4 `ranked_reward_grant`

The one-time reward table is keyed by `(userId, rewardId)` and records:

- `sourceSessionId`
- `achievementId`
- `chipAmount`
- `grantedAt`

The v1 reward ID is `ranked_debut_100`. The associated achievement ID is `ranked_debut`. A normally completed first ranked hand qualifies regardless of win, loss, or push; an expired hand does not.

### 7.5 `ranked_rate_limit`

Durable fixed-window counters are keyed by `(userId, operation, windowStart)`:

- `count`
- `expiresAt`

The increment uses a single conditional upsert. If the limit is already reached, no row is returned and the API responds with `429` and `Retry-After`.

Initial limits:

- `ranked_start`: 6 requests per user per 60 seconds.
- `ranked_action`: 120 requests per user per 60 seconds.
- `ranked_resume`: 120 requests per user per 60 seconds.

Valid idempotent replays are resolved before incrementing a counter so a lost response cannot make recovery impossible.

---

## 8. Transaction and idempotency model

### 8.1 Start transaction

The start D1 batch:

1. Inserts the session only if the user has enough chips and no multiplayer escrow.
2. Deducts the initial wager only for the newly inserted session.
3. For an opening natural, closes the session and applies terminal effects in the same batch.

Unique constraint failure rolls back the whole batch. The handler then reads the winner:

- Matching start payload returns the existing session.
- Different payload returns `409 IDENTIFIER_REUSE_MISMATCH`.
- A different active session returns `409 ACTIVE_SESSION_EXISTS`.
- A zero-row balance guard returns `409 INSUFFICIENT_BALANCE`.

### 8.2 Action transaction

Before writing, the coordinator replays the stored session and computes the next canonical state. The D1 batch predicates wallet and session changes on the same active status and prior sequence.

For double or split, the relative wallet deduction executes only if the account has enough chips and the session still has the expected sequence. The subsequent session update records the action and committed wager in the same transaction.

A competing request that loses the sequence race changes no wallet or session state. It re-reads the stored action:

- Same payload returns the winning result.
- Different payload returns a conflict.

### 8.3 Terminal transaction

One D1 batch:

1. Applies any final additional wager and game payout.
2. Applies Ranked Debut reward only if no grant exists.
3. Changes the session to `settled` or `expired` and clears `activeUserId`.
4. Inserts the immutable `ranked_result`.
5. Upserts `ranked_game_stats`.
6. Inserts eligible achievements with conflict-ignore semantics.
7. Inserts the unique reward grant.

Every downstream effect is conditioned on the winning session transition or unique result. A retry reads and returns the existing receipt rather than recalculating effects.

The response is built from the stored result row, not from transient in-memory calculations.

### 8.4 Receipt identity

Canonical receipt JSON uses a fixed key order and excludes presentation-only text. `receiptHash` covers all monetary, statistical, achievement, reward, ruleset, configuration, action-log, and timestamp fields.

Replaying the same settlement request always returns byte-equivalent canonical receipt data. Reusing the session ID with a different payload is impossible through the public API because the server never accepts terminal result fields.

---

## 9. Ranked and multiplayer exclusion

Ranked sessions and multiplayer escrow cannot overlap:

- Ranked start rejects an existing `mp_membership` row or non-zero `heldChips`.
- Multiplayer room create/join/lock rejects a non-null active ranked-session key.
- Resume and terminal settlement remain available even if unrelated casual activity has changed the account balance.

Casual games remain independently available. A ranked wallet write may make a casual optimistic sync stale; the existing casual reconciliation path handles that conflict. Casual outcomes never enter ranked result or ranked statistics tables.

---

## 10. Client experience

### 10.1 Ranked page

`/games/blackjack/ranked` is authenticated-only and contains:

- Ranked-mode explanation and link back to Casual Blackjack.
- Wager selector constrained to 10–1,000 and current available balance.
- Start button.
- Authoritative expiry countdown.
- Player hands and dealer up-card.
- Active-hand indicator and total committed wager.
- Server-provided action availability.
- Pending-request state that disables action controls.
- Terminal result, receipt ID/hash, balance, ranked-stat summary, and achievement toast.

The client does not instantiate the casual `BlackjackGame` and never predicts cards, actions, payouts, or balances.

### 10.2 Recovery

- Persist the pending start request ID before the first start call.
- Persist the active session ID after start.
- Send one action at a time with the current server sequence.
- On timeout or uncertain response, retry the same action once and then resume with `GET`.
- On reload, resume the stored session before enabling start.
- Clear local session references only after reading a terminal receipt.

The displayed countdown may reach zero before the next network call, but only the server decides whether the session has expired.

### 10.3 Casual page

`/games/blackjack` gains:

- An explicit `Casual` mode label.
- A Ranked Blackjack link for authenticated users.
- A sign-in-safe ranked prompt for guests.

No casual game logic, guest bankroll behavior, account sync contract, or local settlement order changes.

---

## 11. Error contract

All endpoints return structured JSON with stable error codes:

| HTTP | Code | Meaning |
|---|---|---|
| 400 | `INVALID_REQUEST` | Malformed JSON or unsupported fields |
| 400 | `INVALID_WAGER` | Wager outside the ruleset range |
| 400 | `INVALID_ACTION` | Action is not legal in replayed state |
| 401 | `UNAUTHORIZED` | No authenticated user |
| 404 | `SESSION_NOT_FOUND` | Missing session or session owned by another user |
| 409 | `ACTIVE_SESSION_EXISTS` | User already has a live ranked session |
| 409 | `IDENTIFIER_REUSE_MISMATCH` | Same request ID or sequence, different canonical payload |
| 409 | `SEQUENCE_MISMATCH` | Gap or stale sequence that does not match a stored action |
| 409 | `INSUFFICIENT_BALANCE` | Initial or additional wager cannot be funded |
| 409 | `MULTIPLAYER_CONFLICT` | Ranked and multiplayer escrow would overlap |
| 429 | `RATE_LIMITED` | Durable operation limit reached |
| 500 | `INTERNAL_ERROR` | Unexpected server failure |

`SEQUENCE_MISMATCH` includes the expected sequence. `RATE_LIMITED` includes `Retry-After`. Internal errors never expose SQL, seeds, configuration internals, raw logs, or stack traces.

---

## 12. Scheduled work, retention, and observability

The existing scheduled Worker adds two ranked jobs:

1. Finalize active sessions whose `expiresAt` is in the past.
2. Delete expired rate-limit buckets.

Lazy expiration keeps users unblocked immediately; scheduled finalization is the global backstop. Historical ranked sessions and results are retained in HPA-170 so later competitive features can audit them. A future retention policy must preserve result and season requirements before deleting replay material.

Structured logs use redacted user/session identifiers and event names:

- `ranked_session_started`
- `ranked_action_accepted`
- `ranked_action_rejected`
- `ranked_session_replayed`
- `ranked_session_settled`
- `ranked_session_expired`
- `ranked_rate_limited`

Seeds, deck state, complete action logs, emails, and raw account IDs are never logged.

---

## 13. Testing strategy

### 13.1 Pure unit tests

- Same seed, configuration, and actions produce byte-equivalent state, outcomes, and hashes.
- Different accepted actions produce their expected deterministic branches.
- Dealer stands on soft 17.
- Blackjack, push, win, loss, double, split, re-split, and four-hand cap follow v1 rules.
- Public projection hides the dealer hole card, seed, and undealt cards.
- Configuration and action canonicalization rejects unknown or ambiguous fields.
- Payload tampering changes hashes and is rejected.

### 13.2 Repository and API integration tests

Tests run against the real migration schema and cover:

- Insufficient initial balance.
- Insufficient double/split balance without sequence advancement.
- Duplicate start returning the same session without another wager.
- Start request ID reused with a different wager.
- Duplicate action returning the same state.
- Same sequence reused with a different action.
- Concurrent actions allowing one sequence winner.
- Natural settlement during start.
- Terminal action retry returning the same receipt.
- Expiration and scheduled expiration producing one forfeit receipt.
- Ranked statistics updated exactly once.
- Ranked Debut achievement and 100-chip reward granted exactly once.
- Durable rate limits shared by fresh handler instances.
- Active ranked-session uniqueness.
- Ranked/multiplayer exclusion in both directions.
- Transaction rollback after injected persistence failure.

### 13.3 End-to-end tests

Playwright proves:

- An authenticated player can start, resume, act, and receive a ranked receipt.
- Reload during an active hand resumes authoritative state.
- A lost/retried start does not create another wager.
- A retried terminal action returns the same receipt and reward.
- No response or rendered markup contains seed or dealer hole-card data before reveal.
- Guest Casual Blackjack still plays and settles locally.
- Authenticated Casual Blackjack still works independently of ranked mode.

The ranked E2E test does not require a production seed override. It can always complete the server-generated hand by standing or following server-provided actions; exact card-order assertions remain in deterministic unit tests.

### 13.4 Verification ladder

1. Focused ranked engine, repository, API, and scheduled-job tests.
2. Ranked Blackjack and public casual Playwright specs.
3. Full `bun run test`.
4. `bun run lint`.
5. `bun run format:check`.
6. `bun run build`.

---

## 14. Acceptance-criteria mapping

| HPA-170 acceptance criterion | Design proof |
|---|---|
| Arbitrary positive delta or score cannot earn ranked rewards | Public APIs accept only start configuration and legal actions; server replay derives all outcomes and effects |
| Same settlement request is idempotent | Unique result, conditional terminal transition, and stored receipt |
| Session ID reused with different payload is rejected | Server-issued session IDs plus canonical request/action hashes and sequence conflicts |
| At least one end-to-end ranked reference game | Authenticated Ranked Blackjack route and API |
| Tests cover deterministic replay | Seeded engine and byte-equivalent replay tests |
| Tests cover payload tampering | Canonical hash and identifier-reuse integration tests |
| Tests cover duplicate submission | Duplicate start/action/terminal concurrency tests |
| Tests cover expiration | Lazy and scheduled forfeiture tests |
| Tests cover insufficient balance | Initial, double, and split funding tests |
| Casual play remains independent | Existing guest/authenticated route plus dedicated casual E2E coverage |
| Durable rate limiting | D1 fixed-window counters tested across handler instances |
| Chips, stats, achievements, and rewards settle once | One terminal batch, immutable receipt, ranked aggregates, unique achievement/reward grants |

---

## 15. Implementation boundaries

Implementation planning should preserve these boundaries:

- Generic ranked coordination must not import browser code or a concrete Blackjack UI.
- The ranked Blackjack reducer must remain pure and independent of D1.
- API routes must not duplicate game rules or settlement calculations.
- Casual game logic must not call ranked endpoints.
- Existing `/api/chips/update` remains explicitly casual and client-authoritative.
- Ranked statistics must never read or merge existing casual `game_stats`.
- Every schema change must have a generated migration and updated repository migration command.
- Future games must add a new immutable adapter/ruleset version rather than branching on ad hoc payload fields inside the coordinator.
