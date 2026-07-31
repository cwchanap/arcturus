# Daily Challenge — Shared Seeded Blackjack and Ranked Attempts

**Status:** Repository review changes addressed; final approval pending  
**Date:** 2026-07-31  
**Issue:** HPA-175  
**Dependency:** HPA-170 / PR #20 (complete)  
**Scope:** One daily Blackjack challenge, one ranked attempt per authenticated player, unlimited guest-safe practice, live standings, and recent history.

---

## 1. Context

Arcturus currently has two competitive foundations:

- Lifetime and game-specific leaderboards, which are influenced by account age, accumulated chip balance, and client-authoritative casual outcomes.
- A server-authoritative Ranked Blackjack path introduced by HPA-170, with deterministic replay, strict action sequencing, idempotent D1 transitions, immutable receipts, hidden server randomness, and exactly-once wallet settlement.

A Daily Challenge needs a different product model from ordinary Ranked Blackjack. Every player must receive the same scenario and a fixed challenge bankroll across several rounds. The result must measure decisions made inside that challenge, not the player's real account balance. Practice must remain available to guests and must never affect rankings, rewards, statistics, or the player wallet.

HPA-175 therefore composes the deterministic Blackjack adapter and canonical ranked primitives from HPA-170, but introduces a separate daily-challenge coordinator, persistence model, API, and UI. It does not turn the existing one-hand wallet-settling ranked coordinator into a generic multi-mode framework.

---

## 2. Goals and non-goals

### 2.1 Goals

- Give every ranked player the same hidden deterministic Blackjack scenarios for one UTC day.
- Give every player the same fixed starting challenge bankroll, round count, wager limits, and immutable ruleset.
- Permit one ranked attempt per authenticated user per challenge day.
- Permit unlimited guest and authenticated practice attempts without ranked side effects.
- Derive every ranked state and result from server-owned challenge configuration, seed material, and an accepted canonical command log.
- Recover an active ranked attempt after refresh, browser restart, uncertain responses, or use from another browser.
- Produce an immutable verified result with score, rank, percentile, and receipt.
- Show a public top-results leaderboard and a simple recent-challenge history.
- Make UTC rollover, ranked entry cutoff, attempt expiration, ties, and duplicate requests deterministic and testable.
- Keep the design versioned so historical challenges remain interpretable after future rules change.

### 2.2 Non-goals

- Weekly or monthly leagues, divisions, promotion, relegation, or season rewards; those belong to HPA-177.
- Multiple Daily Challenge games in the MVP.
- A continuous Blackjack shoe across rounds.
- Converting ordinary Casual or Ranked Blackjack to the new challenge coordinator.
- Using the player's account chip balance inside a challenge.
- Updating `game_stats`, `ranked_game_stats`, achievements, missions, or rewards from Daily Challenge attempts.
- Same-day practice on the exact hidden ranked seed.
- Basic-strategy grading or an AI assessment of decision quality.
- Device fingerprinting, anti-bot heuristics, or multi-account enforcement.
- Shareable image cards.
- Live “playing now” presence or counts.
- Offline ranked play or client-submitted final scores.

---

## 3. Approved product decisions

| Topic | Decision |
|---|---|
| Game | Blackjack |
| Challenge ruleset | `blackjack-daily-v1` |
| Underlying hand rules | Existing immutable `blackjack-ranked-v1` adapter |
| Starting challenge bankroll | 1,000 available challenge chips |
| Round count | 10 independently shuffled rounds |
| Wager range | 10–1,000, additionally capped by currently available challenge chips |
| All-in wager | Intentionally allowed in v1; maximum wager equals the starting bankroll |
| Ranked attempts | One attempt per authenticated user per UTC day |
| Practice | Unlimited and available to guests |
| Practice randomness | Separate public practice seed; never the live ranked seed |
| Attempt duration | 30 minutes |
| Ranked entry cutoff | 23:30:00 UTC; no starts during the final 30 minutes |
| Daily boundary | `[00:00:00 UTC, next 00:00:00 UTC)` |
| Ranked seed reveal | Reveal only after the challenge ends |
| Ranking | Ending available bankroll, then rounds completed; exact ties share rank |
| Completion time | Display-only; never a competitive tie-breaker |
| Ranked rewards | None in the MVP |
| Account wallet | Never read, debited, credited, or used for challenge decisions |
| Multiplayer/ordinary-ranked overlap | Allowed; no cross-mode warning or mutual exclusion in the MVP |
| Public names | Use the same player display-name privacy contract as existing public leaderboards |
| Live standings | Include only terminal eligible results; no active-attempt presence |
| History | Seven recent challenges in the initial UI |

The separate practice seed is intentional. A player must not be able to rehearse the exact ranked deck as a guest and then sign in for a nominally one-shot ranked attempt. After the day closes, the ranked seed is revealed and exact replay becomes safe.

The 1,000-chip maximum wager is also intentional for the MVP. It permits high-variance strategies rather than guaranteeing a ten-round sample. If live results show that all-in play overwhelms decision quality, a lower cap requires a new challenge configuration/ruleset version rather than an in-place change.

---

## 4. Versioned challenge configuration

The persisted canonical configuration for `blackjack-daily-v1` is:

```json
{
  "challengeKind": "blackjack-daily",
  "challengeRulesetVersion": "blackjack-daily-v1",
  "gameType": "blackjack",
  "gameRulesetVersion": "blackjack-ranked-v1",
  "scoreVersion": "blackjack-daily-score-v1",
  "startingBankroll": 1000,
  "roundCount": 10,
  "minimumWager": 10,
  "maximumWager": 1000,
  "attemptTtlSeconds": 1800,
  "rankedEntryCloseOffsetSeconds": 1800
}
```

The configuration is validated before RFC 8785/JCS canonicalization and hashed with the existing ranked canonical hashing utility. Unknown fields, floating-point values, negative zero, unsafe integers, and numeric strings are rejected.

`challengeRulesetVersion` governs the multi-round challenge lifecycle. `gameRulesetVersion` identifies the immutable Blackjack hand implementation. `scoreVersion` identifies ranking semantics. A change to any behavior covered by one of those contracts requires a new version; historical rows always retain their original versions and configuration hash.

---

## 5. Architecture

```text
Public Daily Challenge page
        |
        | practice: local commands only
        | ranked: start / resume / command
        v
Thin Astro API routes
        |
        v
Daily Challenge coordinator
   |             |                 |
   |             |                 +--> durable D1 rate limits
   |             +--> multi-round deterministic replay
   |                         |
   |                         +--> existing blackjack-ranked-v1 adapter
   |
   +--> Daily Challenge repository
          daily_challenge
          daily_challenge_attempt
          daily_challenge_result
```

The main units are:

- **Challenge catalog:** resolves a UTC period key and lazily creates exactly one immutable challenge record.
- **Seed derivation:** derives one deterministic 32-byte hand seed for each round from the selected challenge master seed.
- **Multi-round replay:** replays the complete accepted command log into available challenge bankroll, round progress, active Blackjack state, and terminal status.
- **Coordinator:** handles authentication, entry cutoff, attempt uniqueness, idempotency, ownership, expiration, conditional writes, result creation, and response construction.
- **Repository:** performs D1 reads and guarded transactional transitions.
- **Scoring and leaderboard:** calculates shared competitive ranks and percentiles from immutable eligible results.
- **Practice client:** runs the same pure multi-round replay locally with the public practice seed and no write API.

The existing Ranked Blackjack coordinator is not modified to support virtual bankroll strategies, multi-round aggregation, alternative receipts, or different statistics sinks. Only generic helpers whose semantics are already shared—canonicalization, hashes, deterministic Blackjack replay, and fixed-window D1 rate limiting—should be reused or narrowly extracted.

The coordinator and catalog receive a dependency-injected clock matching the ranked platform's testability pattern, for example `now(): Date`. Each operation or retry iteration converts that value once to a validated integer `nowSeconds` and passes it through catalog, expiration, transition, and response logic. Production code must not scatter direct `Date.now()` calls across these units.

---

## 6. Challenge lifecycle and UTC boundaries

### 6.1 Period identity

The UTC period key uses the existing mission helper and has the form `YYYY-MM-DD`.

For a period key:

- `startsAt` is 00:00:00 UTC for that key.
- `rankedEntryClosesAt` is 23:30:00 UTC.
- `endsAt` is 00:00:00 UTC on the following day.

A ranked start request is rejected when `now >= rankedEntryClosesAt`. The current-day Practice mode remains available until `endsAt`; closed challenges move to the historical replay behavior defined in §13.1.

The coordinator captures the injected server clock once for each operation or retry iteration. A request received at or after midnight belongs to the new period. A previous challenge attempt can never accept another command after its challenge ends.

### 6.2 Lazy creation

`getOrCreateCurrentChallenge(nowSeconds)`:

1. Derives the UTC period key and immutable timestamps.
2. Reads an existing `(challengeKind, periodKey)` row.
3. If absent, generates independent ranked and practice 32-byte master seeds.
4. Attempts `INSERT ... ON CONFLICT DO NOTHING` using a unique `(challengeKind, periodKey)` constraint.
5. Reads and returns the winning persisted row.

Concurrent creators may generate different candidate seeds, but only one complete row wins and every caller then reads that row. The seed is deterministic for replay because it is persisted; it is deliberately not publicly derivable from the date.

Challenge creation does not depend on cron execution. Cron may pre-create upcoming challenges later, but lazy creation remains the correctness path.

---

## 7. Randomness and seed disclosure

Each challenge stores two independent 32-byte master seeds as canonical unpadded base64url:

- `rankedSeed`: secret while the challenge is live.
- `practiceSeed`: public immediately and retained for historical practice.

The ranked seed commitment is lowercase hexadecimal SHA-256 over:

```text
UTF8("arcturus:blackjack-daily-v1:seed:") || rankedSeedRawBytes
```

For round index `0` through `9`, derive the hand seed as:

```text
HMAC-SHA-256(
  key = selectedMasterSeed,
  message = UTF8("arcturus:blackjack-daily-v1:round:") || uint32BE(roundIndex)
)
```

The 32-byte HMAC output is passed directly to the existing `blackjack-ranked-v1` adapter. Its existing deck construction, Fisher-Yates shuffle, HMAC random stream, card order, and deal direction remain unchanged.

The ranked seed, derived ranked round seeds, future cards, and undealt deck state must not appear in live responses or logs. The current challenge API exposes only the ranked commitment and the practice seed.

When `now >= endsAt`, historical challenge responses expose `revealedRankedSeed`. Anyone can then verify the commitment and reproduce the closed challenge. The server never accepts ranked commands for a closed challenge, so seed disclosure cannot affect live standings.

`GET /api/daily-challenges/:periodKey` returns the retained `practiceSeed` for both live and closed periods, and returns `revealedRankedSeed` only for closed periods. The current-day page presents Practice with the practice seed. A closed-day history/detail view may offer two entirely local unranked modes: replay the alternate Practice scenario with `practiceSeed`, or reproduce the exact ranked scenario with `revealedRankedSeed`. Neither mode calls ranked write APIs.

---

## 8. Multi-round command and replay model

### 8.1 Canonical command log

```ts
export type DailyChallengeCommandV1 =
  | {
      sequence: number;
      command: 'start-round';
      wager: number;
    }
  | {
      sequence: number;
      command: 'hit' | 'stand' | 'double-down' | 'split' | 'forfeit';
    };
```

Commands use strict tagged-union validation. `sequence` is a non-negative safe integer. `wager` exists only on `start-round`. Unknown fields are rejected. The stored log is a JCS-canonicalized array with contiguous global sequences beginning at zero.

The global sequence belongs to the whole Daily Challenge attempt. During pure replay, each `start-round` begins a new adapter action segment. Blackjack commands in that segment are converted to `RankedBlackjackActionLogEntryV1` values with fresh per-round sequences `0..n-1` before calling `blackjack-ranked-v1`; global sequence numbers are never passed directly to the adapter. The deterministic mapping is therefore `global command -> (roundIndex, perRoundActionIndex)`, where `roundIndex` is the number of preceding `start-round` commands and `perRoundActionIndex` is the number of preceding Blackjack actions in the current segment.

`forfeit` is an attempt-level command consumed by the Daily Challenge reducer/coordinator. It is never converted into a `RankedBlackjackActionLogEntryV1` or passed to the Blackjack adapter.

### 8.2 Replay state and bankroll semantics

The pure replay function accepts:

```text
challenge configuration
+ selected master seed
+ canonical accepted command log
```

and returns:

- Available challenge bankroll not currently committed to a wager.
- Number of completed rounds.
- Current round index.
- Active internal Blackjack replay, if a hand is in progress.
- Safe public Blackjack state, if a hand is in progress.
- Total wager committed to the active round.
- Next expected global sequence.
- Legal next commands.
- Attempt terminal classification.
- Eligible score fields when complete.

The available bankroll starts at 1,000. Initial, split, and double-down wagers are deducted when their commands are accepted. Payouts are credited only when the active round settles. The displayed challenge bankroll always means currently available chips; the active round shows its committed wager separately.

The replay function does not read D1, use the wall clock, inspect account chips, generate identifiers, update statistics, or emit UI events.

The Daily Challenge layer supplies its virtual `availableBankroll` to adapter public-state projection and validates every adapter legal action's `additionalWager` against that same virtual balance. The adapter's current projection parameter may be named `accountBalance`, but Daily Challenge treats it only as an available-funds value. Shared challenge code must not read `user.chipBalance`, `heldChips`, multiplayer escrow, or ordinary ranked-session state; a narrowly extracted helper should rename the parameter to `availableBalance` where practical.

### 8.3 Round transitions

A `start-round` command is legal only when:

- The attempt is active and not terminal.
- No Blackjack round is currently active.
- `roundsCompleted < roundCount`.
- The available challenge bankroll is at least `minimumWager`.
- The wager is an integer within configured limits and no greater than the available challenge bankroll.

The reducer deducts the initial wager from available bankroll, derives the round seed from the implicit current round index, issues the existing Blackjack configuration using the selected wager, and creates the opening replay. A natural opening result may complete the round immediately in the same command; its payout is then credited in the same replay transition.

Blackjack action commands are legal only while a round is active and are delegated to the existing adapter. For public-state projection, the adapter receives the available challenge bankroll so double-down and split actions are omitted when their additional wager cannot be funded.

When a split or double-down command is accepted, its additional wager is deducted from available bankroll before the command is appended. When a round reaches a natural terminal outcome:

```text
availableBankroll += outcome.payout
roundsCompleted += 1
activeRound = null
```

Credit the adapter's aggregate `outcome.payout`. It is the gross return including returned stakes across all hands; do not use `outcome.gameNetDelta`. The initial, split, and double-down wagers were already deducted when their commands were accepted, so settlement must never subtract them again. The next accepted command may start the next round.

`blackjack-ranked-v1` computes Blackjack profit as `Math.floor((wager * 3) / 2)`. All challenge bankroll values remain whole-chip safe integers, but an odd wager can produce an ending bankroll that is not divisible by 5 or 10. Score formatting and tests must preserve that exact integer rather than rounding to a wager increment.

### 8.4 Attempt completion and terminal reasons

A ranked attempt terminates under exactly one of these reasons:

| `terminalReason` | Trigger | `eligible` | Ranked score |
|---|---|---:|---|
| `completed` | Ten rounds completed | `true` | Ending bankroll and rounds completed |
| `bankroll-below-minimum` | After a settled round, available bankroll is below 10 | `true` | Ending bankroll and rounds completed |
| `forfeited` | Accepted attempt-level `forfeit` command | `false` | None |
| `expired` | Attempt deadline or challenge end reached before eligible completion | `false` | None |

Expiration terminates the attempt without appending a synthetic client command. Any wager already committed to an active round remains deducted; forfeits and expirations do not credit a payout.

Only forfeited or expired attempts are ineligible due to incomplete play. An eligible `bankroll-below-minimum` result may have fewer than ten completed rounds and still receives a leaderboard score. Every terminal attempt receives an immutable result and receipt for history and idempotent recovery.

---

## 9. Ranked attempt lifecycle and idempotency

### 9.1 Identifiers and strict start schema

Daily Challenge reuses the ranked identifier contracts:

- `requestId` must match `^[A-Za-z0-9_-]{16,128}$`.
- The server generates `attemptId` from exactly 16 cryptographically random bytes encoded as exactly 22 unpadded base64url characters.
- Malformed identifiers return `400 INVALID_REQUEST` before repository lookup.

The client creates and persists one fresh `requestId` for each logical daily start intent and reuses it for uncertain retries. It must not reuse yesterday's identifier for a new challenge. The database retains global `UNIQUE(userId, startRequestId)` protection, so reuse across challenge periods is rejected as `IDENTIFIER_REUSE_MISMATCH` rather than silently creating a new attempt.

The `blackjack-daily-v1` start body is a strict request-ID-only object:

```json
{
  "requestId": "client-generated-id"
}
```

`startPayloadHash` hashes the entire canonical validated body, including `requestId`. Unknown fields are rejected. Adding a future client/version/configuration field requires an explicit versioned start-schema change; it must not be accepted silently under the v1 hash contract.

### 9.2 Start

`POST /api/daily-challenges/current/attempts`

The server:

1. Authenticates the user.
2. Resolves the current challenge using one captured injected server timestamp.
3. Rejects starts at or after `rankedEntryClosesAt`.
4. Looks up `(userId, requestId)` before consuming a transition rate-limit unit.
5. Returns the existing attempt for an exact idempotent replay.
6. Rejects reuse of the request ID for another challenge or canonical payload.
7. Looks up `(challengeId, userId)` and returns that attempt if the user already consumed today's ranked attempt under another request ID.
8. Generates an attempt ID and attempts to create one active row with 1,000 available chips and an empty command log.
9. Sets `expiresAt = createdAt + 1800`; the entry cutoff guarantees that this is not later than challenge end.
10. If the guarded insert loses a concurrent uniqueness race, rereads first by `(userId, requestId)` and verifies `startPayloadHash`, then by `(challengeId, userId)`. It returns the winning attempt; only an unclassifiable conflict becomes `INTERNAL_ERROR`.

The unique `(challengeId, userId)` constraint is the authoritative one-attempt rule. The attempt is consumed when the row is created, not when a score is submitted. Refreshing, clearing local storage, switching browsers, forfeiting, or allowing the attempt to expire cannot create another attempt.

Two concurrent start requests using different valid request IDs may both consume a start rate-limit unit, but only one attempt row can win. Both successful HTTP responses resolve to the same winning attempt.

### 9.3 Resume

`GET /api/daily-challenge-attempts/:attemptId`

The server authenticates ownership without revealing another user's attempt, lazily expires the attempt when necessary, replays its canonical log, and returns current public state or its immutable result receipt.

Discovering expiry is terminal game-domain settlement, not a transport error. A resume that lazily expires an attempt returns `200` with status `expired` and the immutable receipt. There is no `ATTEMPT_EXPIRED` error code.

The current challenge response may include the authenticated user's attempt/result summary so a different browser can discover the attempt without relying on local storage.

### 9.4 Command

`POST /api/daily-challenge-attempts/:attemptId/commands`

The coordinator follows the ranked-session sequence contract:

- `sequence < nextSequence` and the same canonical stored command returns current authoritative state through the replay rate bucket.
- `sequence < nextSequence` with different content returns `IDENTIFIER_REUSE_MISMATCH`.
- `sequence > nextSequence` returns `SEQUENCE_MISMATCH` with the expected sequence.
- `sequence = nextSequence` attempts one new transition.
- An exact replay of a recorded terminal command, including `forfeit`, returns the immutable terminal response.
- An unrecorded new sequence after terminal settlement returns `ATTEMPT_COMPLETE`.

Each new command transition:

1. Lazily settles expiry when `now >= expiresAt` or `now >= challenge.endsAt`, then enforces durable command limits. The challenge-end check is explicit defense in depth even though the start invariant guarantees `expiresAt <= challenge.endsAt`.
2. If expiry was discovered, returns `200` with status `expired` and the immutable receipt without appending the submitted command.
3. Replays the persisted state.
4. Validates the command against legal commands and available challenge bankroll.
5. Computes the next canonical log, hash, projections, and possible result.
6. Uses a guarded D1 write requiring the expected active status, sequence, prior action-log hash, available bankroll, and rounds-completed projection.
7. Inserts the result and marks the attempt terminal in the same batch when completion or forfeit occurs.
8. Rereads and classifies a losing concurrent request as replay, mismatch, sequence conflict, or already complete.

A successfully accepted `forfeit` returns `200` with status `forfeited` and its immutable receipt. Because an expiry-triggering command is not appended, retrying that unrecorded command after receiving the terminal response is a new command after terminal and returns `ATTEMPT_COMPLETE`; resume remains the recovery path for the stored receipt.

No client timestamp, seed, cards, bankroll, score, payout, outcome, rank, percentile, or final-state field is accepted.

### 9.5 Receipt

Every terminal ranked attempt has a canonical receipt containing:

- Attempt ID and challenge ID.
- Period key.
- Challenge, game, and score versions.
- Challenge configuration hash.
- Ranked seed commitment.
- Command-log hash.
- Available ending bankroll and rounds completed.
- Eligibility and terminal reason.
- Server-derived duration seconds.
- Settlement timestamp.
- Receipt hash.

The receipt hash is SHA-256 over the canonical receipt with `receiptHash` omitted. Duplicate terminal reads and exact terminal-command replays always return the same stored receipt.

---

## 10. Scoring, ranks, and percentile

`blackjack-daily-score-v1` compares eligible results by:

```text
1. endingBankroll  DESC
2. roundsCompleted DESC
```

`endingBankroll` is the available challenge bankroll at terminal completion and is the displayed score. `roundsCompleted` distinguishes players who finish more of the challenge when both end with the same bankroll, especially after falling below the minimum wager.

The rounds-completed secondary key intentionally rewards progress through more deterministic scenarios when bankrolls tie. It is not claimed to be a complete measure of decision quality and may be revised only through a future `scoreVersion`.

Players equal on both fields share the same competitive rank. The leaderboard uses competition ranking: if two players tie for rank 1, the next distinct score is rank 3.

For stable row ordering only, tied rows are ordered by:

```text
settledAt ASC, userId ASC
```

This display order does not alter rank or percentile. Completion duration is shown as optional context but is not a tie-breaker because it is affected by latency, device performance, accessibility needs, and automation.

For an eligible result:

```text
playersAtOrBelow = totalEligible - playersStrictlyAbove
percentile = round(100 * playersAtOrBelow / totalEligible)
```

`totalEligible >= 1` by construction because percentile is calculated only for an existing eligible result. The value is clamped to `1..100`. Equal scores receive equal percentile. The live leaderboard returns the top 50 plus the authenticated player's result/rank when outside the top 50.

Practice attempts, forfeits, and expired attempts are excluded from leaderboard counts and percentile denominators.

---

## 11. Persistence

### 11.1 `daily_challenge`

```text
id                          primary key
challengeKind               'blackjack-daily'
periodKey                    YYYY-MM-DD
challengeRulesetVersion
gameRulesetVersion
scoreVersion
configJson
configHash
rankedSeed                   server-only base64url
rankedSeedCommitment
practiceSeed                 public base64url
startsAt
rankedEntryClosesAt
endsAt
createdAt
```

Constraints and indexes:

```text
UNIQUE(challengeKind, periodKey)
INDEX(endsAt)
```

### 11.2 `daily_challenge_attempt`

```text
id                          primary key; 22-char unpadded base64url
challengeId                 foreign key -> daily_challenge
userId                      foreign key -> user
startRequestId
startPayloadHash
status                      active | completed | forfeited | expired
actionLogJson
actionLogHash
nextSequence
availableBankroll           derived projection for guarded transitions
roundsCompleted             derived projection for guarded transitions
expiresAt
createdAt
updatedAt
settledAt                   nullable
```

Constraints and indexes:

```text
UNIQUE(challengeId, userId)
UNIQUE(userId, startRequestId)
INDEX(status, expiresAt)
INDEX(userId, createdAt)
```

`availableBankroll` and `roundsCompleted` are persisted transition projections for efficient responses and write guards. The canonical configuration, master seed, and command log remain the replay source of truth; projection disagreement is an internal invariant failure.

### 11.3 `daily_challenge_result`

```text
attemptId                   unique opaque correlation; no delete-cascade dependency
challengeId                 foreign key -> daily_challenge
userId                      foreign key -> user
endingBankroll
roundsCompleted
eligible                    boolean
terminalReason              completed | bankroll-below-minimum | forfeited | expired
durationSeconds             server-derived settledAt - attempt createdAt
scoreVersion
configHash
rankedSeedCommitment
actionLogHash
receiptHash
createdAt
settledAt
```

Constraints and indexes:

```text
PRIMARY KEY(challengeId, userId)
UNIQUE(attemptId)
INDEX(challengeId, eligible, endingBankroll DESC, roundsCompleted DESC, settledAt, userId)
INDEX(userId, settledAt)
```

The result does not foreign-key `attemptId` so old command logs can be reaped without deleting compact scores or challenge history. `durationSeconds` is retained in the result because it remains displayable after the attempt row is cleaned up.

### 11.4 Rate limits

Reuse the existing `ranked_rate_limit` table through a narrowly generalized fixed-window helper. Add operations with the existing policy shape:

| Operation | Limit |
|---|---:|
| `daily_challenge_start` | 6/minute |
| `daily_challenge_command` | 30/minute |
| `daily_challenge_resume` | 120/minute |
| `daily_challenge_replay` | 120/minute |

As in Ranked Blackjack, exact idempotent lookups occur before consuming an expensive transition bucket where possible.

---

## 12. API surface

```text
GET  /api/daily-challenges/current
GET  /api/daily-challenges/:periodKey
POST /api/daily-challenges/current/attempts
GET  /api/daily-challenge-attempts/:attemptId
POST /api/daily-challenge-attempts/:attemptId/commands
GET  /api/daily-challenges/:periodKey/leaderboard?limit=50
GET  /api/daily-challenges/history?limit=7
```

The naming is intentional: `/daily-challenges/*` addresses the challenge collection and date-scoped resources, while `/daily-challenge-attempts/:attemptId/*` addresses one opaque attempt independently of how it was discovered.

Query limits are validated server-side:

- Leaderboard `limit` defaults to 50 and must be an integer from 1 through 50.
- History `limit` defaults to 7 and must be an integer from 1 through 7.
- Missing limits use defaults; malformed or out-of-range values return `400 INVALID_REQUEST`.

### Public challenge responses

The current and historical challenge endpoints return:

- Challenge ID, period key, versions, canonical public configuration, and configuration hash.
- Start, ranked-entry-close, and end timestamps.
- Ranked seed commitment.
- Public practice seed for live and closed challenges.
- `revealedRankedSeed` only after challenge end.
- Authenticated attempt/result summary when the caller is signed in.

They never return a live ranked seed or another user's private attempt state.

### Leaderboard response

The leaderboard is public and contains:

- Rank.
- Player display name under the same privacy contract as the existing public leaderboard.
- Available ending-bankroll score.
- Rounds completed.
- Server-derived completion duration for display.
- Current-user marker when authenticated.
- Total eligible players.
- Current user's rank and percentile when available.

It does not expose command logs, receipt hashes, user email, raw user IDs, seed material, or active-attempt presence.

### History response

The initial history endpoint returns up to seven closed or current challenges with:

- Period key and versions.
- Top score and participant count.
- Ranked seed commitment and post-close reveal when applicable.
- Practice seed for local historical practice.
- Authenticated user's result, rank, and percentile, or `not played`.

---

## 13. Practice mode and UI

### 13.1 Practice and historical replay

Practice runs entirely in the browser using the public practice seed, the immutable challenge configuration, the existing Blackjack adapter rules, and the same pure multi-round replay semantics.

Current-day Practice:

- Is available to guests until challenge end.
- Can be restarted without limits.
- Uses the same 1,000-chip available bankroll, 10 rounds, and wager rules.
- Never calls ranked start, resume, or command write APIs.
- Never writes D1 rows, account chips, statistics, achievements, missions, rewards, or leaderboard entries.
- Is clearly labeled as a different scenario from the hidden ranked challenge.

After challenge close, a historical detail/replay view may offer:

- **Practice Scenario:** local replay using the retained public `practiceSeed`.
- **Exact Ranked Replay:** local reproducibility using `revealedRankedSeed`.

Both historical modes are unranked, restartable, and client-local. `GET /api/daily-challenges/current` is the only source for the current-day mode; `GET /api/daily-challenges/:periodKey` supplies historical replay metadata and seeds.

### 13.2 Page

Add a public route:

```text
/games/daily-challenge
```

The page contains:

- Challenge date and explicit UTC reset information.
- Ranked-entry-close countdown and challenge-end countdown.
- Ranked and Practice mode selection.
- Sign-in call to action when a guest selects Ranked.
- One-attempt warning before the authenticated player starts.
- Available challenge bankroll, active committed wager, round progress, wager input, dealer/player hands, and actions.
- Resume state when a ranked attempt already exists.
- An explicit Forfeit control with confirmation.
- Verified result panel with score, rank, percentile, eligibility, and receipt hash.
- Top-results table.
- Seven-day recent history.

The lobby and Blackjack pages may link to Daily Challenge, but the existing `/games/blackjack/ranked` and `/games/blackjack` routes remain unchanged. Ordinary Ranked Blackjack and Daily Challenge may remain active simultaneously; each page displays only its own countdown and no cross-mode warning is required in the MVP.

### 13.3 Shared presentation

The current Ranked Blackjack renderer is coupled to ranked DOM IDs, account balance, wallet receipts, ranked statistics, and achievement toasts. Extract only focused presentation primitives needed by both pages:

- Card rendering.
- Hand-value formatting.
- Dealer and player-hand rendering.
- Blackjack action-button state.

Do not share ranked wallet controls, local-storage keys, receipts, countdown semantics, or achievement UI with Daily Challenge.

---

## 14. Error, security, and privacy contracts

Use strict public error codes:

| Code | Status | Applicable operations |
|---|---:|---|
| `INVALID_REQUEST` | 400 | All request/query validation, malformed identifiers |
| `INVALID_WAGER` | 400 | `start-round` command |
| `INVALID_COMMAND` | 400 | Command endpoint |
| `UNAUTHORIZED` | 401 | Ranked start/resume/command |
| `CHALLENGE_NOT_FOUND` | 404 | Date-scoped challenge/leaderboard reads |
| `ATTEMPT_NOT_FOUND` | 404 | Resume/command ownership checks |
| `RANKED_ENTRY_CLOSED` | 409 | Ranked start |
| `ATTEMPT_COMPLETE` | 409 | Unrecorded new command after terminal settlement |
| `IDENTIFIER_REUSE_MISMATCH` | 409 | Start request ID or recorded command payload mismatch |
| `SEQUENCE_MISMATCH` | 409 | Command endpoint |
| `INSUFFICIENT_CHALLENGE_BANKROLL` | 409 | `start-round`, split, or double-down funding |
| `RATE_LIMITED` | 429 | Ranked start/resume/command/replay |
| `INTERNAL_ERROR` | 500 | Unclassifiable invariant or persistence failure |

Ownership checks return `ATTEMPT_NOT_FOUND` for missing and other-user attempt IDs.

Expiration is deliberately absent from the error table. Lazy expiration returns a successful terminal response with the immutable receipt, mirroring Ranked Blackjack.

Security invariants:

- The server never accepts a final score, bankroll, result, payout, card, rank, percentile, seed, or completion timestamp from the browser.
- Ranked commands are replayed against the attempt's persisted challenge ID; the client cannot switch challenges or seeds.
- Ranked master seeds and derived round seeds are redacted from live responses, exceptions, analytics, and structured logs.
- Log identifiers use the same redaction conventions as Ranked Blackjack.
- Result insertion and terminal attempt transition are exactly once in one D1 batch.
- Practice code has no ranked write capability and receives no live ranked seed.
- Account wallet, held chips, multiplayer escrow, and ranked wallet statistics are outside the challenge transaction.
- Tests and repository interfaces must make it impossible for Daily Challenge funding or projection code to depend on `user.chipBalance` or `heldChips`.

---

## 15. Expiration, retention, and operations

Expiration is both lazy and scheduled:

- Start, resume, and command paths expire an overdue active attempt before returning.
- A request that discovers expiry returns `200` with status `expired` and the immutable ineligible receipt.
- Command handling checks both the attempt deadline and the parent challenge `endsAt`; no command can be accepted after challenge close.
- The existing hourly Worker scheduled pipeline in `src/worker.ts` calls the shared `runScheduledJobs` path in `src/server/cleanup.ts`; Daily Challenge expiration and retention are additional jobs in that pipeline, not a second cron trigger.
- An expired attempt creates one immutable ineligible result and cannot be restarted.
- Failure of the scheduled job does not permit late commands because request paths enforce the same clock rule.

Retention:

- `daily_challenge` and `daily_challenge_result` are retained as compact historical competition data.
- Terminal `daily_challenge_attempt` rows and their command logs are retained for 90 days, then deleted by scheduled cleanup.
- Active attempts are never deleted by retention cleanup; they must first be expired.
- Result rows retain hashes, score fields, and completion duration after the full command log is removed.
- Rate-limit rows use the existing short-lived cleanup.

Operational logs record challenge creation races, attempt starts, accepted/replayed/rejected commands, expiration, terminal settlement, invariant failures, and rate limiting. They must never record raw seeds or command logs.

---

## 16. Testing strategy

### 16.1 Pure unit tests

- Exact known vectors for challenge seed commitment and per-round HMAC derivation.
- Different round indexes produce different seeds.
- Ranked and practice master seeds produce different round streams.
- Same configuration, master seed, and command log produce byte-identical replay and score.
- Global command sequences partition into deterministic round indexes and zero-based per-round adapter sequences.
- `forfeit` remains attempt-level and is never passed to the Blackjack adapter.
- Legal/illegal `start-round`, hit, stand, double-down, split, and forfeit transitions.
- Natural opening settlement.
- Available-bankroll deductions and gross `outcome.payout` credits after wins, losses, pushes, Blackjack, splits, and doubles; `gameNetDelta` is never credited as the payout.
- Odd-wager Blackjack floors 3:2 profit to a whole chip and preserves the exact resulting bankroll.
- Terminal-reason eligibility table: completed/bankroll-below-minimum eligible; forfeited/expired ineligible.
- Completion after ten rounds.
- Completion below the minimum wager.
- Score ordering, shared ranks, stable display ordering, and tied percentile.
- Canonical command validation and hash vectors.
- Ranked-compatible request and attempt identifier validation/generation vectors.
- Strict v1 start-body hashing and unknown-field rejection.
- Injected-clock UTC key, entry cutoff, end boundary, leap day, month end, and year end.

### 16.2 D1 integration tests

- Concurrent lazy challenge creation returns one row and one seed pair.
- Concurrent attempt starts create one `(challengeId, userId)` row.
- Concurrent starts with different request IDs return the same winning attempt after unique-conflict reread.
- Exact start replay returns the same attempt.
- Request ID reuse across challenge periods is rejected.
- New request ID after attempt creation recovers the consumed attempt rather than creating another.
- Conditional command append under concurrent requests.
- Exact command replay, payload mismatch, sequence-behind, and sequence-ahead behavior.
- Lazy expiry from resume or command returns `200` plus the stored receipt; it does not return an expiration error.
- Accepted forfeit and exact forfeit replay return the same immutable receipt.
- A new command at or after `challenge.endsAt` cannot mutate the attempt even if its stored expiry is malformed or later.
- Projection guards reject stale available-bankroll or rounds-completed snapshots.
- Daily Challenge replay/projection/funding performs no account-balance, held-chip, escrow, or ranked-session reads.
- Terminal result and attempt status settle in one batch.
- Duplicate terminal requests return one receipt.
- Expiration is idempotent.
- Forfeits and expirations never enter eligible leaderboard queries.
- Leaderboard top 50, current-user-outside-top, rank, tie, and percentile queries.
- Percentile is computed only for an existing eligible result and therefore always has `totalEligible >= 1`.
- Leaderboard/history query limits apply defaults and reject malformed or out-of-range values.
- Ninety-day attempt cleanup preserves compact result rows and completion duration.
- Seed disclosure is absent before end and present at/after end; practice seed remains available historically.

### 16.3 HTTP and client tests

- Guest reads current challenge and history.
- Guest ranked start returns 401.
- Strict request schemas reject unknown score, seed, bankroll, timestamp, card, and start-body fields.
- Malformed request IDs and attempt IDs return `INVALID_REQUEST` before lookup.
- Attempt ownership does not leak existence.
- Practice client performs no ranked writes.
- Ranked client persists a fresh request ID per start intent and recovers uncertain start and command responses.
- Different-browser recovery works without shared local storage.
- Countdown and cutoff use the injected server clock, not a client-selected date.
- Closed challenge detail supports local practice-seed and revealed-ranked-seed replay without write calls.

### 16.4 Playwright

- Guest completes and restarts practice.
- Guest selects Ranked and receives a sign-in call to action.
- Authenticated player starts one ranked attempt.
- Starting a round reduces available bankroll and shows committed wager separately.
- Refresh resumes the same round, available bankroll, and committed wager.
- A second browser for the same account recovers the same attempt.
- A second start cannot reset a completed, forfeited, or expired attempt.
- Tampered commands and sequences are rejected without state mutation.
- An expiry-triggering resume/command renders the verified expired receipt rather than a transport error.
- A completed result appears with score, rank, percentile, and receipt.
- Practice completion never changes the leaderboard.
- Tied results share a rank.
- Empty early-day standings render without active-player presence.
- Ranked entry closes at 23:30 UTC and a new challenge appears at 00:00 UTC.
- A closed challenge reveals the ranked seed and supports both local replay modes.

---

## 17. Delivery slices

1. **Challenge contracts and pure replay** — configuration, identifiers, seed derivation, command schemas, multi-round state, terminal semantics, scoring, and unit tests.
2. **D1 schema and repository** — challenge creation, attempt/result persistence, guarded transitions, concurrent-start recovery, ranking queries, and integration tests.
3. **Coordinator and API** — start, resume, command, expiration response semantics, idempotency, HTTP validation, query bounds, and structured logging.
4. **Practice and shared Blackjack presentation** — focused renderer extraction, virtual-balance funding contract, and local practice/replay client.
5. **Daily Challenge page** — mode selection, gameplay, countdowns, result panel, leaderboard, history, and navigation links.
6. **Scheduled expiration and retention** — add jobs to the existing `src/worker.ts` → `runScheduledJobs` hourly pipeline, cleanup, and operational tests; do not introduce another cron.
7. **End-to-end verification** — Playwright coverage, accessibility checks, lint, format, build, unit, integration, and E2E suites.

The detailed implementation plan must identify exact file changes and test-first checkpoints after this design receives final repository approval.

---

## 18. Acceptance criteria mapping

- **Same daily configuration:** one unique persisted challenge row per `(blackjack-daily, UTC periodKey)`.
- **Same deterministic ranked scenarios:** one hidden persisted ranked master seed with versioned per-round derivation.
- **One ranked attempt:** unique `(challengeId, userId)` consumed at attempt creation, with concurrent losers returning the winning attempt.
- **Unlimited practice:** local public-practice-seed replay with no ranked persistence.
- **Server verification:** score and result derive only from canonical replay and virtual challenge bankroll.
- **Duplicate idempotency:** request IDs, command sequences, guarded writes, and immutable receipts.
- **Terminal recovery:** completion, forfeit, and lazy expiration return immutable successful terminal responses.
- **Rank and percentile:** immutable eligible-result queries using versioned score semantics.
- **Recent history:** seven-day public history plus authenticated player result and post-close local replay metadata.
- **Guest support:** public page and practice; authentication required only for ranked start/resume/command.
- **UTC rollover:** shared period helpers, injected clock, explicit entry cutoff/end timestamps, lazy creation, and boundary tests.
- **Tampering coverage:** strict schemas and server-owned challenge, seed, bankroll, cards, outcomes, and scores.

---

## 19. Linear issue alignment

HPA-176 describes the same Daily Challenge product under a second roadmap and an older prerequisite model. This is post-merge project hygiene, not part of the Daily Challenge implementation slices:

- Fold any remaining useful wording from HPA-176 into HPA-175.
- Mark HPA-176 as a duplicate of HPA-175.
- Treat completed HPA-170 as the implementation foundation.
- Do not retain HPA-169 as an additional blocker for this MVP.
- Keep weekly/monthly competition, divisions, finalization, and rewards under HPA-177.
