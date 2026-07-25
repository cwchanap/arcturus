# Server-Verifiable Ranked Single-Player Results — Design

**Status:** Approved (brainstorming phase complete; D1 balance-snapshot clarification added 2026-07-25)
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

The replay cost is bounded by one Blackjack round and is small compared with network and database latency. Explicit conditional writes, inspected mutation counts, and session sequence numbers resolve concurrent requests; atomic batching alone is not treated as a compare-and-swap guarantee.

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

### 4.4 Canonical bytes and hashes

All persisted or compared hashes use the UTF-8 bytes of RFC 8785 JSON Canonicalization Scheme (JCS) output. Inputs are schema-validated before canonicalization, unknown fields are rejected, and every numeric field in a hashed structure must be a finite JavaScript safe integer. Floating-point values, `NaN`, `Infinity`, negative zero, and numeric strings standing in for integer fields are invalid.

Configuration objects, accepted action objects, action-log arrays, result effects, and receipt data each have a versioned schema. Hashes are lowercase hexadecimal SHA-256 digests of the canonical bytes. `receiptHash` is computed from the receipt schema with the `receiptHash` field omitted. Implementations must use one shared canonicalization module rather than relying on insertion order or plain `JSON.stringify`.

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

The selected initial wager is part of the per-session issued configuration and therefore part of `configHash`. The hash protects the complete issued configuration for one session; it is not the ruleset's version identity. `rulesetVersion` identifies the immutable rule implementation. Changing any rule requires a new ruleset version; historical sessions always replay through the version they recorded.

### 5.2 Randomness boundary

The current casual deck manager may gain an injected random source while preserving `Math.random` as its default. Ranked play does not use floating-point randomness. Its versioned source exposes bounded integers:

```ts
interface RankedRandomSource {
	nextInt(exclusiveUpperBound: number): number;
}
```

Ranked start creates exactly 32 seed bytes with `crypto.getRandomValues`. D1 stores those bytes as unpadded RFC 4648 base64url; decoding must reproduce exactly 32 bytes, and malformed or non-canonical encodings are rejected. `blackjack-ranked-v1` defines the stream byte-for-byte:

- HMAC-SHA-256 uses the 32-byte seed as its key.
- The message is the UTF-8 bytes of `arcturus:blackjack-ranked-v1:deck`, followed by an unsigned 64-bit big-endian counter starting at zero.
- Successive 32-byte digests are concatenated. Each four-byte chunk is interpreted as an unsigned big-endian 32-bit integer.
- `nextInt(n)` requires an integer `1 <= n <= 2^32`. It computes `limit = floor(2^32 / n) * n`, rejects values greater than or equal to `limit`, and returns the next accepted value modulo `n`. This rejection step avoids modulo bias.
- The initial ordered deck is suits `hearts`, `diamonds`, `clubs`, `spades`, with ranks `A`, `2` through `10`, `J`, `Q`, `K` inside each suit. Fisher-Yates iterates from index 51 down to 1 and swaps with index `nextInt(i + 1)`. Cards are dealt from the end of the shuffled array, matching the current Blackjack deck manager.

Deck derivation may be asynchronous, but it completes before the synchronous pure reducer runs. The HMAC algorithm, domain separator, counter encoding, unsigned integer decoding, rejection sampling, initial deck order, shuffle direction, and deal direction are all immutable parts of `blackjack-ranked-v1`.

The seed commitment is lowercase hexadecimal SHA-256 over the UTF-8 bytes of `arcturus:blackjack-ranked-v1:seed:` followed by the 32 raw seed bytes. Only this commitment may appear in a receipt. It is an audit fingerprint that lets trusted server-side tooling detect seed substitution; HPA-170 does not claim player-verifiable or provably fair shuffling because the commitment is not opened publicly. The raw seed, HMAC state, undealt cards, and future draws are never returned or logged.

### 5.3 Rules

Ranked Blackjack intentionally follows current casual behavior with two explicit v1 differences: a four-hand safety limit and a corrected dealer transition after the final split hand.

- One 52-card deck, shuffled once at session start.
- Dealer hits 16 or lower and stands on every 17, including soft 17.
- Normal wins return the wager plus 1:1 profit.
- Blackjack returns the wager plus 3:2 profit; fractional profit rounds down to a whole chip.
- A push returns the wager.
- Double-down is available only on a hand's first two cards totaling 9, 10, or 11, including an eligible post-split hand.
- Double-down commits another equal wager, deals exactly one card, and ends that hand.
- Split requires equal ranks and commits another equal wager.
- Re-splitting is permitted until the session has four player hands.
- A split action that would create a fifth hand is unavailable and is rejected if submitted.
- Split hands otherwise use the current evaluator and payout behavior. Any two-card 21, including Ace plus a ten-value card after a split, is Blackjack and returns the wager plus 3:2 profit.
- If every player hand is bust after the final hand completes, the round settles immediately without drawing for the dealer.
- If at least one player hand is not bust after the final hand completes, the dealer turn runs automatically. This corrects the current casual mixed-split edge case where a bust on the last hand can skip the dealer even though an earlier hand stood.
- Natural player or dealer Blackjack may settle during the start request.

### 5.4 Pure replay reducer

The ranked reducer does not read D1, inspect the account balance, use the clock, generate identifiers, or emit UI events. It accepts the configuration, deterministic deck, and canonical accepted actions, then returns:

- Complete internal game state.
- Next expected sequence.
- Legal rule actions.
- Additional wager required by each legal action.
- Terminal outcomes and payouts when complete.

Wallet sufficiency is an external coordinator concern. A double or split is appended only after its additional wager has been committed transactionally. During replay, every logged double or split is therefore known to have been funded.

The canonical `blackjack-ranked-v1` action-log entry is:

```ts
interface RankedBlackjackActionLogEntryV1 {
	sequence: number;
	action: 'hit' | 'stand' | 'double-down' | 'split';
}
```

`sequence` is a non-negative safe integer and must equal the session's expected sequence when accepted. The persisted action log is a JCS-canonicalized array of these entries in ascending sequence order. Entries contain no timestamp, hand index, balance, score, payout, client state, or unknown fields. The wire action spelling and stored action spelling are both kebab-case.

### 5.5 Public-state projection

The public response may contain:

- Session ID, status, ruleset version, expiry, and next sequence.
- Player hands, hand wagers, structured hand values shaped as `{ value, isSoft, isBust }`, and active-hand index.
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
2. Looks up an existing `(userId, requestId)` before consuming a transition rate-limit unit.
3. Returns a matching idempotent replay through the replay-rate bucket; mismatched reuse consumes a start-rate unit and is then rejected.
4. Finalizes the user's expired active session, if any.
5. Enforces the durable start limit.
6. Runs the shared multiplayer resolver, rejecting a live/unknown membership conflict or orphaned escrow.
7. Validates the ruleset and wager.
8. Generates the session ID, seed, seed commitment, configuration, and opening state.
9. Atomically creates the session and deducts the wager.
10. If the opening deal is terminal, atomically creates the result and returns its receipt.

The client generates and persists `requestId` before sending the request. A retry with the same payload returns the same session or receipt without another deduction.

`requestId` must match `^[A-Za-z0-9_-]{16,128}$`; UUIDs and unpadded base64url identifiers are valid. The server generates each opaque session ID from 16 cryptographically random bytes encoded as exactly 22 unpadded base64url characters. Malformed or out-of-range identifiers and unknown or unsupported `(gameType, rulesetVersion)` pairs return `400 INVALID_REQUEST`.

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
2. Detects an already-recorded sequence before consuming an action transition-rate unit.
3. Returns current authoritative state or the terminal receipt for the same canonical action through the replay-rate bucket.
4. Rate-limits and then rejects a different action at the same sequence.
5. Enforces expiration and durable action limits.
6. Replays the authoritative state and validates the action.
7. Checks any additional wager against the current account balance.
8. Conditionally applies the wallet effect and appends exactly one canonical action.
9. Settles atomically if the action reaches a terminal state.

No client timestamp, score, card, payout, chip delta, or final-state field is accepted.

### 6.3 Resume

`GET /api/ranked/sessions/:sessionId`

The server authenticates ownership, increments the durable resume-rate bucket, finalizes the session if it has expired, replays active state, and returns public state or the stored terminal receipt. Resume is safe after a page reload, uncertain network response, or browser restart. This intentionally makes `GET` resume a D1-writing operation, bounded at 120 requests per user per minute.

### 6.4 Sequence rules

- The first player action uses sequence `0`.
- Every accepted action increments `nextSequence` by one.
- For `sequence < nextSequence`, the server compares the submitted action with the stored entry at that sequence. A match returns current authoritative public state, not a historical state snapshot; a mismatch returns `409 IDENTIFIER_REUSE_MISMATCH`.
- For `sequence = nextSequence`, an active session attempts a new transition and a terminal session returns its stored receipt.
- A sequence greater than `nextSequence` returns `409 SEQUENCE_MISMATCH` with the expected value, including after settlement.
- Recorded-sequence payload comparison takes precedence over the general terminal-receipt rule, so settlement never hides identifier reuse with different content.

### 6.5 Expiration and abandonment

An active session expires exactly 15 minutes after the opening deal. `expiresAt` is immutable and accepted actions do not extend it. The server clock is authoritative.

Expiration:

- Changes the terminal status to `expired`.
- Treats every committed wager as lost.
- Credits no game payout.
- Updates ranked statistics with one loss and one forfeit.
- Creates an immutable receipt.
- Does not grant Ranked Debut.

Expiration is applied lazily during start, action, or resume. The scheduled Worker also finalizes overdue sessions in bounded batches as a global backstop. Because every wager is deducted when committed, abandonment cannot release unearned chips or leave an unsettled hold on the account.

An action or resume request that discovers expiration returns the stored terminal receipt as a successful response. Expiration is a game result, not a `SESSION_EXPIRED` transport error.

The absolute deadline is deliberate: ranked Blackjack is a bounded, normally short round, and a fixed expiry prevents one session from retaining the user's single ranked-session slot and multiplayer exclusion indefinitely. The client shows the authoritative countdown before play begins and throughout the round. Sliding inactivity extension is outside `blackjack-ranked-v1`.

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
| `seed` / `seedCommitment` | Server-only replay seed and audit fingerprint |
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

`balanceAfter` is a receipt-time snapshot established by an exact-balance compare-and-swap in the settlement batch. Before building the batch, the coordinator reads the account balance, computes the complete terminal wallet delta and expected post-settlement balance, and canonicalizes the receipt with that value. The batch first verifies the pre-read balance with a no-op guarded account update, applies any relative wallet delta, and requires the result insert to observe the expected post-settlement balance. This is necessary because D1 SQLite has no SHA-256 function with which to construct `receiptHash` from an intra-batch query result. A stale pre-read changes zero rows and causes no result-affecting mutation; the coordinator re-reads and retries with a newly canonicalized receipt. The stored value is not a permanent account balance and may differ from a later balance after unrelated casual or ranked activity.

The session's seed remains server-only. A stored result plus its session replay material lets trusted server-side tooling independently reproduce and audit the receipt. `seedCommitment` is an audit-only fingerprint in HPA-170; because the seed is never disclosed to the player, it is not evidence of public provable fairness.

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

These counters are intentionally overlapping rather than mutually exclusive: expiration increments `sessionsPlayed`, `totalLosses`, and `totalForfeits` once each. Per-hand outcomes remain in the immutable receipt.

Aggregate monetary fields use only game economics:

- `netProfit` adds `gameNetDelta` for every terminal session and never includes `rewardDelta`. An expired session therefore subtracts its committed wager.
- `biggestWin` is the maximum positive `gameNetDelta` from normally settled, non-expired sessions. Losses, pushes, expiration, and Ranked Debut rewards do not change it.

### 7.4 `ranked_reward_grant`

The one-time reward table is keyed by `(userId, rewardId)` and records:

- `sourceSessionId`
- `achievementId`
- `chipAmount`
- `grantedAt`

The v1 reward ID is `ranked_debut_100`. The associated achievement catalog entry is:

- ID: `ranked_debut`
- Name: `Ranked Debut`
- Description: `Complete your first ranked game.`
- Category: `milestone`
- Icon: `🎖️`
- Grant source: `ranked-terminal`

`AchievementDefinition` gains a required `grantSource: 'evaluated' | 'ranked-terminal'` field. Existing definitions use `evaluated`; Ranked Debut uses `ranked-terminal`. Implementation adds the ID and definition to the shared achievement types/catalog, filters the definitions passed to `checkAndGrantAchievements` to `grantSource === 'evaluated'`, and keeps profile views and receipt toasts catalog-driven so both sources render correctly. The ranked terminal transaction is the only granter for Ranked Debut and uses the existing `(userId, achievementId)` primary key. A normally completed first ranked hand qualifies regardless of win, loss, or push; an expired hand does not.

### 7.5 `ranked_rate_limit`

Durable fixed-window counters have a composite primary key on `(userId, operation, windowStart)`:

- `count`
- `expiresAt`

The increment uses a single conditional upsert. If the limit is already reached, no row is returned and the API responds with `429` and `Retry-After`.

Initial limits:

- `ranked_start`: 6 requests per user per 60 seconds.
- `ranked_action`: 30 requests per user per 60 seconds.
- `ranked_resume`: 120 requests per user per 60 seconds.
- `ranked_replay`: 120 matching start/action replays per user per 60 seconds.

Valid idempotent replays are identified before incrementing the start/action transition bucket so a lost response does not consume another scarce transition unit. A matching replay then consumes the separate, generous `ranked_replay` bucket before the server reconstructs and returns current state or the receipt. Mismatched identifier reuse consumes the applicable start/action bucket before rejection.

For new starts and actions, the transition rate-limit upsert is the first statement in the same D1 transition batch. This keeps enforcement durable without adding a second database round trip. A denied upsert reports zero changes, and every following mutation in that batch, including an account-snapshot or wallet statement, is explicitly gated by `WHERE changes() = 1`.

---

## 8. Transaction and idempotency model

### 8.1 Start transaction

The start D1 batch:

1. Conditionally upserts the start rate bucket.
2. Establishes an exact account snapshot with `UPDATE user SET chipBalance = chipBalance` gated by `WHERE changes() = 1`, the coordinator's pre-read balance, sufficient chips, `heldChips = 0`, no active ranked session, and no multiplayer membership. Workerd D1 reports one changed row for this matched no-op update, so it is a valid compare-and-swap gate.
3. Inserts the session with `INSERT ... SELECT ... WHERE changes() = 1 ... ON CONFLICT DO NOTHING`, repeating the ownership and exclusion predicates.
4. Deducts the initial wager with a relative `UPDATE user SET chipBalance = chipBalance - ?` gated by the newly inserted session, the exact pre-read balance, `heldChips = 0`, and `WHERE changes() = 1`.
5. For an opening natural, applies the same terminal cascade described below in this batch.

Putting the harmless account snapshot before the session insert prevents an account race from leaving an active session whose wager was not deducted. Start idempotency and active-session conflicts are deliberately conflict-tolerant rather than statement errors. A conflict makes the account snapshot or session insert and all following mutations report zero changes while the rate-limit increment commits. The handler inspects the mutation counts and reads the winner:

- Matching start payload returns the existing session.
- Different payload returns `409 IDENTIFIER_REUSE_MISMATCH`.
- A different active session returns `409 ACTIVE_SESSION_EXISTS`.
- A zero-row balance guard returns `409 INSUFFICIENT_BALANCE`.
- A sufficient balance that changed after preflight is re-read and retried with the same request ID; repeated contention returns the retriable `409 ACCOUNT_BALANCE_CHANGED`.

### 8.2 Action transaction

Before writing, the coordinator replays the stored session and computes the next canonical state. The D1 batch uses the repository's established sequential `WHERE changes() = 1` cascade; a successful zero-row statement is never assumed to roll back a batch.

The action rate-limit upsert runs first. For a non-terminal action with a non-zero wallet delta, the next statement is a relative wallet update guarded by `WHERE changes() = 1`, `heldChips = 0`, an `EXISTS` subquery for the owned, active session at the expected sequence, and, when another wager is being committed, sufficient balance. The session compare-and-swap repeats the ownership, status, and sequence predicates and additionally requires `changes() = 1`. When a non-terminal action has no wallet delta, the session compare-and-swap follows the rate upsert directly and requires `changes() = 1`. It records the canonical action, action-log hash, committed wager, and next sequence.

A terminal action follows section 8.3 instead: after the rate upsert it establishes the exact account snapshot needed to precompute `balanceAfter` and `receiptHash`, then appends the terminal cascade in the same batch.

Every required `D1Result.meta.changes` value is inspected. A rate result of zero becomes `RATE_LIMITED`; a wallet result of zero is classified by re-reading balance and session state; and a session result other than one after a successful wallet mutation is an internal invariant failure. The SQL text for these safety-critical cascades is exported from shared repository constants so handlers and integration tests execute the same statements.

Because D1 batch statements execute sequentially in one transaction, a competing request serialized after the winner no longer satisfies the active-session/sequence predicate. Its wallet and session statements both report zero changes. The handler re-reads the stored action:

- Same payload returns the winning result.
- Different payload returns a conflict.

### 8.3 Terminal transaction

Before constructing a terminal batch, the coordinator establishes `expectedWalletBalance` as the account value immediately before the terminal wallet delta, computes `balanceAfter = expectedWalletBalance - finalAdditionalWager + payout + rewardDelta`, chooses `settledAt`, and computes `receiptHash` from the complete canonical receipt. For an action or expiration, `expectedWalletBalance` is the account balance read during terminal preflight. For an opening natural, it is the pre-read start balance minus the successfully deducted initial wager. The batch must prove that account snapshot before it can reserve a reward or mutate the session.

The source-specific prefix is:

1. **Terminal action:** successful action-rate upsert, then `UPDATE user SET chipBalance = chipBalance` guarded by `WHERE changes() = 1`, the exact expected balance, `heldChips = 0`, and the owned active session at the expected sequence.
2. **Opening natural:** the start prefix from section 8.1, whose exact-balance account snapshot and successful opening-wager deduction establish the known post-wager balance.
3. **Expiration:** the exact-balance no-op account update runs first, guarded by `heldChips = 0` and the owned active expired-at-or-before-now session; because it is statement one, it deliberately has no predecessor `changes()` predicate. The expiration session compare-and-swap follows it with `WHERE changes() = 1` and clears `activeUserId`. No rate statement precedes expiration.

The shared suffix is:

1. For a qualifying first completion, insert `ranked_debut_100` with a strict unique `INSERT ... SELECT ... WHERE changes() = 1`. This statement does not use conflict-ignore. An unexpected uniqueness conflict is a statement error and rolls back the entire batch.
2. For a non-zero terminal wallet delta, apply the final additional wager, game payout, and reward credit in one relative wallet update guarded by `WHERE changes() = 1`, `heldChips = 0`, the exact expected pre-update balance, and the owned active session at the expected sequence. The reward credit is included only in the branch where the strict grant insert succeeded. An opening natural uses its known post-opening-wager balance as the pre-update value.
3. For normal settlement, change the session to `settled`, clear `activeUserId`, repeat the ownership/status/sequence predicates, and require `changes() = 1` from the preceding account, reward, or wallet gate. Expiration already performed this compare-and-swap in its prefix.
4. Insert the immutable `ranked_result` with `WHERE changes() = 1`, binding the precomputed receipt fields and additionally selecting the account only when its balance equals the precomputed `balanceAfter`.
5. Upsert `ranked_game_stats` with `WHERE changes() = 1`.
6. Insert the eligible `user_achievement` from the stored result with conflict-ignore semantics. This catalog-visible side effect is last; an existing achievement cannot interrupt a mandatory monetary, result, or statistics cascade.

If no reward is eligible, the strict grant step is omitted and the wallet/session cascade follows the account gate directly. If the terminal wallet delta is zero, the wallet step is omitted; the exact-balance account snapshot still establishes and protects `balanceAfter`. Expiration never qualifies for Ranked Debut and uses its account snapshot and expiration compare-and-swap before the result/statistics cascade.

Reward eligibility is read before building the branch, but the strict grant insert is the definitive reservation. If it conflicts unexpectedly, D1 rolls back all earlier statements, including rate, wager, and session mutations. The handler re-reads the grant: a valid prior grant retries the non-reward branch, while inconsistent data is logged as an invariant violation and returns `INTERNAL_ERROR`. Merely noticing `meta.changes === 0` after committing a reward credit is not considered sufficient.

Every mandatory downstream effect is conditioned on the winning account snapshot, transition, strict reward reservation when applicable, or unique result. If the account snapshot reports zero, no result-affecting mutation has occurred; the coordinator distinguishes an account balance race from insufficient funds, escrow, expiry, or a winning concurrent transition, then retries with a fresh canonical receipt when appropriate. A retry of an already terminal session reads and returns the existing receipt rather than recalculating effects. The handler verifies all mandatory mutation counts before responding. An impossible partial-count pattern is logged as an invariant violation and returns `INTERNAL_ERROR`; real-D1 integration tests must prove that the SQL predicates make that pattern unreachable.

The response is built from the stored result row, not from transient in-memory calculations.

### 8.4 Receipt identity

Canonical receipt JSON follows section 4.4 and excludes presentation-only text. `receiptHash` covers all monetary, statistical, achievement, reward, ruleset, configuration, action-log, balance-snapshot, and timestamp fields. It is computed before the D1 batch from the expected balance transition, while exact-balance guards and the result insert prove that the stored receipt observed those values.

Replaying the same settlement request always returns byte-equivalent canonical receipt data. Reusing the session ID with a different payload is impossible through the public API because the server never accepts terminal result fields.

---

## 9. Ranked and multiplayer exclusion

Ranked sessions and multiplayer escrow cannot overlap:

- One shared server-only membership resolver owns stale-lock handling and is used by multiplayer room creation, `/api/mp/lock`, and the ranked coordinator. The existing route-local copies are removed so escrow release and membership deletion cannot diverge again.
- A membership younger than the 30-second initialization grace period, a live Durable Object room, or an `unknown` room probe result is a `MULTIPLAYER_CONFLICT`.
- Only a definitive `gone` room probe may be repaired. The shared repair returns `heldChips` while the membership still points to that exact room, deletes only that scoped stale membership, and then re-checks both membership and `heldChips` before ranked start proceeds. Release always happens before deletion.
- `heldChips > 0` with no membership row is an orphaned escrow state because no room identity remains to probe or scope safely. Ranked start fails closed with `MULTIPLAYER_ESCROW_ORPHANED`, emits a redacted audit event, and does not auto-release funds. After verifying that no live room owns the escrow, support can use the existing service-authenticated escrow-release path to repair it.
- Multiplayer room create/join/lock rejects a non-null active ranked-session key.
- Resume and terminal settlement remain available even if unrelated casual activity has changed the account balance.

Casual games remain independently available, including in another tab during an active ranked session. A casual update can change the account balance and therefore enable or disable ranked double/split actions between requests. If it lands between terminal preflight and the ranked batch, the exact-balance account snapshot prevents a receipt for the wrong balance and the coordinator rebuilds the batch from the new snapshot. Each ranked response replaces the client's displayed balance and available actions with the latest authoritative projection. A ranked wallet write may make a casual optimistic sync stale; the existing casual reconciliation path handles that conflict. Casual outcomes never enter ranked result or ranked statistics tables.

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
- A concise note that balance and double/split availability can change if another game updates the account.
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
| 409 | `ACCOUNT_BALANCE_CHANGED` | Repeated concurrent account updates prevented a stable transactional snapshot; retry is safe |
| 409 | `MULTIPLAYER_CONFLICT` | Ranked and multiplayer escrow would overlap |
| 409 | `MULTIPLAYER_ESCROW_ORPHANED` | Held chips exist without a membership that can be safely reconciled |
| 429 | `RATE_LIMITED` | Durable operation limit reached |
| 500 | `INTERNAL_ERROR` | Unexpected server failure |

`SEQUENCE_MISMATCH` includes the expected sequence. `RATE_LIMITED` includes `Retry-After`. Internal errors never expose SQL, seeds, configuration internals, raw logs, or stack traces.

---

## 12. Scheduled work, retention, and observability

The existing scheduled Worker adds two ranked jobs:

1. Select at most 100 rows matching `status = 'active' AND expiresAt <= now`, ordered by `expiresAt ASC, id ASC`, and finalize them through the shared terminal path.
2. Delete expired rate-limit buckets.

The 100-session limit is the complete work budget for one cron invocation; any remaining rows are picked up by the next hourly run or by a lazy request. Deterministic ordering prevents starvation among equally old rows. Lazy start/action/resume checks and the scheduled job call the same expiration finalizer and terminal transaction, including the same status compare-and-swap, so retries and overlapping cron/lazy work are safe. The scheduled path does not maintain a second settlement implementation.

Each selected session is finalized inside its own error boundary; one poison row is logged and skipped without preventing later rows from being attempted. Ranked expiration, rate-bucket cleanup, and the existing retention cleanup also have independent top-level error boundaries. A failure in one job must not abort the others.

The scheduled Worker invokes ranked expiration before the existing retention cleanup. Lazy expiration keeps users unblocked immediately; scheduled finalization is the global backstop. Historical ranked sessions and results are retained in HPA-170 so later competitive features can audit them. A future retention policy must preserve result and season requirements before deleting replay material.

The raw seed is necessary replay material but is sensitive at rest: a D1 snapshot, overly broad support query, or privileged database compromise could reveal the deck. The seed column is server-only, excluded from logs, receipts, public APIs, routine support tooling, and analytics exports. Database and support access should remain least-privileged, and future administrative endpoints must omit it by default. Application-layer seed encryption and key rotation are deferred for HPA-170; they become required if the threat model expands beyond trusted server/database operators.

Structured logs use redacted user/session identifiers and event names:

- `ranked_session_started`
- `ranked_action_accepted`
- `ranked_action_rejected`
- `ranked_session_replayed`
- `ranked_session_settled`
- `ranked_session_expired`
- `ranked_rate_limited`
- `ranked_mp_escrow_orphaned`

Seeds, deck state, complete action logs, emails, and raw account IDs are never logged.

---

## 13. Testing strategy

### 13.1 Pure unit tests

- Same seed, configuration, and actions produce byte-equivalent state, outcomes, and hashes.
- Fixed HMAC/counter, rejection-sampling, deck-order, and JCS fixtures produce identical bytes and values under Bun and the Worker runtime.
- Different accepted actions produce their expected deterministic branches.
- Dealer stands on soft 17.
- Blackjack payout is `wager + floor(wager * 3 / 2)`, including a split Ace plus ten-value card; push, normal win, loss, double, split, and re-split follow v1 rules.
- Eligible post-split hands may double on their first two cards totaling 9, 10, or 11.
- The fourth hand is the cap and an attempted fifth split is unavailable and rejected.
- All-bust rounds skip dealer draws, while a mixed split with an earlier standing hand and a final bust still runs the dealer.
- Public projection hides the dealer hole card, seed, and undealt cards.
- Public hand values expose numeric value plus `isSoft` and `isBust`, never presentation-only text.
- Configuration and action canonicalization rejects unknown or ambiguous fields.
- Canonical action-log fixtures contain only ascending `{ sequence, action }` entries with kebab-case action names.
- Payload tampering changes hashes and is rejected.

### 13.2 Repository and API integration tests

Tests run against the real migration schema and cover:

- Insufficient initial balance.
- Insufficient double/split balance without sequence advancement.
- A denied action-rate upsert prevents every following wallet, session, result, and statistics mutation.
- `heldChips > 0` introduced between preflight and the D1 batch blocks every ranked wallet transition without partial effects.
- A matched no-op account update reports one D1 change and a stale expected balance reports zero.
- A start-time account race cannot leave an active session without its opening-wager deduction.
- A casual balance change between terminal preflight and the D1 batch produces no result-affecting mutation, retries from a fresh snapshot, and stores a receipt hash covering the actual `balanceAfter`.
- Malformed, short, or oversized request/session identifiers are rejected.
- Unknown game/ruleset pairs and negative, fractional, or non-safe-integer sequences are rejected.
- Duplicate start returning the same session without another wager.
- Start request ID reused with a different wager.
- A conflict-tolerant start insert still commits its start-rate unit while every wallet/session effect remains gated off.
- Duplicate action returning the same state.
- Same sequence reused with a different action.
- A matching old sequence returns current state, and a mismatched recorded sequence still conflicts after terminal settlement.
- Matching start/action replays use the separate durable replay bucket and are eventually rate-limited.
- Actual parallel action batches against Miniflare/workerd D1 allow one sequence winner, one wallet effect, and one action-log append; this is not simulated with only a stale in-memory predicate.
- Natural settlement during start.
- Terminal action retry returning the same receipt.
- Expiration and scheduled expiration producing one forfeit receipt.
- Action/resume expiration returns the immutable receipt as success rather than an error.
- An accepted action just before the deadline does not move `expiresAt`; a later request at or after the original deadline settles the session as expired.
- Scheduled expiration processes the oldest 100 rows deterministically and leaves overflow safe for the next invocation.
- Ranked statistics updated exactly once.
- Ranked `netProfit` excludes rewards, expiration records its wager loss, and `biggestWin` ignores rewards and expiration.
- Ranked Debut achievement and 100-chip reward granted exactly once.
- An injected reward-grant uniqueness conflict rolls back the reward credit and every preceding mutation before the handler re-reads eligibility.
- Ranked Debut is present in the shared catalog but cannot be granted by casual achievement evaluation.
- Durable rate limits shared by fresh handler instances.
- Active ranked-session uniqueness.
- Two sequential sessions for one user prove the nullable `activeUserId` uniqueness constraint permits multiple terminal `NULL` rows.
- Ranked/multiplayer exclusion in both directions.
- Stale multiplayer membership is repaired only after a definitive gone-room probe; live, recent, and unknown probes remain blocked.
- Multiplayer room creation, lock acquisition, and ranked start use the same stale-membership resolver; scoped escrow is released before deletion.
- Orphaned `heldChips` without membership fails closed and never auto-releases through a user-authenticated request.
- A poison expiration row and a failed ranked cleanup job do not prevent other expirations or retention cleanup.
- Transaction rollback after injected persistence failure.

### 13.3 End-to-end tests

Playwright proves:

- An authenticated player can start, resume, act, and receive a ranked receipt.
- Reload during an active hand resumes authoritative state.
- A lost/retried start does not create another wager.
- A retried terminal action returns the same receipt and reward.
- Ranked action availability refreshes after another tab changes the casual account balance.
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
- Multiplayer room creation, lock acquisition, and ranked start must call one shared stale-membership/escrow resolver rather than copying its policy.
- The ranked seed schema field must carry a source comment identifying it as server-only sensitive replay material.
- `ranked_debut` is catalog-visible but terminal-only; generic casual achievement evaluation must filter it by `grantSource`.
- Every schema change must run `bun run db:generate`. The existing `scripts/apply-migrations.ts` automatically discovers numbered `drizzle/*.sql` files, so adding a generated migration does not require editing the `db:migrate:local` or `db:migrate:remote` scripts in `package.json`.
- Future games must add a new immutable adapter/ruleset version rather than branching on ad hoc payload fields inside the coordinator.
