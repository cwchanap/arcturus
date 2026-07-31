# Daily Challenge — Shared Seeded Blackjack and Ranked Attempts

**Status:** Design approved; repository review pending  
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
| Multiplayer/ranked overlap | Allowed because the challenge bankroll is isolated |
| History | Seven recent challenges in the initial UI |

The separate practice seed is intentional. A player must not be able to rehearse the exact ranked deck as a guest and then sign in for a nominally one-shot ranked attempt. After the day closes, the ranked seed is revealed and exact replay becomes safe.

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

---

## 6. Challenge lifecycle and UTC boundaries

### 6.1 Period identity

The UTC period key uses the existing mission helper and has the form `YYYY-MM-DD`.

For a period key:

- `startsAt` is 00:00:00 UTC for that key.
- `rankedEntryClosesAt` is 23:30:00 UTC.
- `endsAt` is 00:00:00 UTC on the following day.

A ranked start request is rejected when `now >= rankedEntryClosesAt`. Practice remains available until `endsAt`.

The coordinator captures the server clock once when resolving the current challenge. A request received at or after midnight belongs to the new period. A previous challenge attempt can never accept another command after its challenge ends.

### 6.2 Lazy creation

`getOrCreateCurrentChallenge(now)`:

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
- `practiceSeed`: public immediately.

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

Commands use strict tagged-union validation. `sequence` is a non-negative safe integer. `wager` exists only on `start-round`. Unknown fields are rejected. The stored log is a JCS-canonicalized array with contiguous sequences beginning at zero.

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
availableBankroll += payout
roundsCompleted += 1
activeRound = null
```

The initial and additional wagers were already deducted, so they are not subtracted again at settlement. The next accepted command may start the next round.

### 8.4 Attempt completion

An attempt completes as an eligible ranked result when either:

- Ten rounds have completed, or
- The available bankroll is below the 10-chip minimum wager after a completed round.

A `forfeit` command is legal whenever the attempt is active. It terminates the attempt immediately as ineligible. Expiration also terminates the attempt as ineligible without appending a synthetic client command. Any wager already committed to an active round remains deducted; forfeits and expirations do not credit a payout.

A partially completed attempt never receives a leaderboard score. Its immutable result records available ending bankroll, rounds completed, terminal reason, duration, and `eligible = false` for history and idempotent recovery.

---

## 9. Ranked attempt lifecycle and idempotency

### 9.1 Start

`POST /api/daily-challenges/current/attempts`

```json
{
  "requestId": "client-generated-id"
}
```

The server:

1. Authenticates the user.
2. Resolves the current challenge using one captured server timestamp.
3. Rejects starts at or after `rankedEntryClosesAt`.
4. Looks up `(userId, requestId)` before consuming a transition rate-limit unit.
5. Returns the existing attempt for an exact idempotent replay.
6. Rejects reuse of the request ID for another challenge or payload.
7. Looks up `(challengeId, userId)` and returns that attempt if the user already consumed today's ranked attempt under another request ID.
8. Creates one active attempt with 1,000 available chips and an empty command log.
9. Sets `expiresAt = createdAt + 1800`; the entry cutoff guarantees that this is not later than challenge end.

The unique `(challengeId, userId)` constraint is the authoritative one-attempt rule. The attempt is consumed when the row is created, not when a score is submitted. Refreshing, clearing local storage, switching browsers, forfeiting, or allowing the attempt to expire cannot create another attempt.

### 9.2 Resume

`GET /api/daily-challenge-attempts/:attemptId`

The server authenticates ownership without revealing another user's attempt, lazily expires the attempt when necessary, replays its canonical log, and returns current public state or its immutable result receipt.

The current challenge response may include the authenticated user's attempt/result summary so a different browser can discover the attempt without relying on local storage.

### 9.3 Command

`POST /api/daily-challenge-attempts/:attemptId/commands`

The coordinator follows the ranked-session sequence contract:

- `sequence < nextSequence` and the same canonical stored command returns current authoritative state through the replay rate bucket.
- `sequence < nextSequence` with different content returns `IDENTIFIER_REUSE_MISMATCH`.
- `sequence > nextSequence` returns `SEQUENCE_MISMATCH` with the expected sequence.
- `sequence = nextSequence` attempts one new transition.
- A command after terminal settlement returns the immutable result for exact replays and rejects a new sequence as `ATTEMPT_COMPLETE`.

Each new command transition:

1. Enforces expiration and durable command limits.
2. Replays the persisted state.
3. Validates the command against legal commands and available challenge bankroll.
4. Computes the next canonical log, hash, projections, and possible result.
5. Uses a guarded D1 write requiring the expected active status, sequence, prior action-log hash, available bankroll, and rounds-completed projection.
6. Inserts the result and marks the attempt terminal in the same batch when completion, forfeit, or expiration occurs.
7. Rereads and classifies a losing concurrent request as replay, mismatch, sequence conflict, or already complete.

No client timestamp, seed, cards, bankroll, score, payout, outcome, rank, percentile, or final-state field is accepted.

### 9.4 Receipt

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

The receipt hash is SHA-256 over the canonical receipt with `receiptHash` omitted. Duplicate terminal requests always return the same stored receipt.

---

## 10. Scoring, ranks, and percentile

`blackjack-daily-score-v1` compares eligible results by:

```text
1. endingBankroll  DESC
2. roundsCompleted DESC
```

`endingBankroll` is the available challenge bankroll at terminal completion and is the displayed score. `roundsCompleted` distinguishes players who finish more of the challenge when both end with the same bankroll, especially after falling below the minimum wager.

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

The value is clamped to `1..100`. Equal scores receive equal percentile. The live leaderboard returns the top 50 plus the authenticated player's result/rank when outside the top 50.

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
id                          primary key
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

### Public challenge responses

The current and historical challenge endpoints may return:

- Challenge ID, period key, versions, canonical public configuration, and configuration hash.
- Start, ranked-entry-close, and end timestamps.
- Ranked seed commitment.
- Public practice seed.
- `revealedRankedSeed` only after challenge end.
- Authenticated attempt/result summary when the caller is signed in.

They never return a live ranked seed or another user's private attempt state.

### Leaderboard response

The leaderboard is public and contains:

- Rank.
- Player display name.
- Available ending-bankroll score.
- Rounds completed.
- Server-derived completion duration for display.
- Current-user marker when authenticated.
- Total eligible players.
- Current user's rank and percentile when available.

It does not expose command logs, receipt hashes, user email, raw user IDs, or seed material.

### History response

The initial history endpoint returns seven closed or current challenges with:

- Period key and versions.
- Top score and participant count.
- Ranked seed commitment and post-close reveal when applicable.
- Authenticated user's result, rank, and percentile, or `not played`.

---

## 13. Practice mode and UI

### 13.1 Practice

Practice runs entirely in the browser using the public practice seed, the immutable challenge configuration, the existing Blackjack adapter rules, and the same pure multi-round replay semantics.

Practice:

- Is available to guests.
- Can be restarted without limits.
- Uses the same 1,000-chip available bankroll, 10 rounds, and wager rules.
- Never calls ranked start, resume, or command write APIs.
- Never writes D1 rows, account chips, statistics, achievements, missions, rewards, or leaderboard entries.
- Is clearly labeled as a different scenario from the hidden ranked challenge.

After challenge close, the UI may additionally offer an exact replay using the revealed ranked seed. That replay remains local and unranked.

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

The lobby and Blackjack pages may link to Daily Challenge, but the existing `/games/blackjack/ranked` and `/games/blackjack` routes remain unchanged.

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

| Code | Status |
|---|---:|
| `INVALID_REQUEST` | 400 |
| `INVALID_WAGER` | 400 |
| `INVALID_COMMAND` | 400 |
| `UNAUTHORIZED` | 401 |
| `CHALLENGE_NOT_FOUND` | 404 |
| `ATTEMPT_NOT_FOUND` | 404 |
| `RANKED_ENTRY_CLOSED` | 409 |
| `ATTEMPT_COMPLETE` | 409 |
| `IDENTIFIER_REUSE_MISMATCH` | 409 |
| `SEQUENCE_MISMATCH` | 409 |
| `INSUFFICIENT_CHALLENGE_BANKROLL` | 409 |
| `RATE_LIMITED` | 429 |
| `INTERNAL_ERROR` | 500 |

Ownership checks return `ATTEMPT_NOT_FOUND` for missing and other-user attempt IDs.

Security invariants:

- The server never accepts a final score, bankroll, result, payout, card, rank, percentile, seed, or completion timestamp from the browser.
- Ranked commands are replayed against the attempt's persisted challenge ID; the client cannot switch challenges or seeds.
- Ranked master seeds and derived round seeds are redacted from live responses, exceptions, analytics, and structured logs.
- Log identifiers use the same redaction conventions as Ranked Blackjack.
- Result insertion and terminal attempt transition are exactly once in one D1 batch.
- Practice code has no ranked write capability and receives no live ranked seed.
- Account wallet, held chips, multiplayer escrow, and ranked wallet statistics are outside the challenge transaction.

---

## 15. Expiration, retention, and operations

Expiration is both lazy and scheduled:

- Start, resume, and command paths expire an overdue active attempt before returning.
- The existing hourly Worker scheduled pipeline scans and expires overdue Daily Challenge attempts.
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
- Legal/illegal `start-round`, hit, stand, double-down, split, and forfeit transitions.
- Natural opening settlement.
- Available-bankroll deductions and payout credits after wins, losses, pushes, Blackjack, splits, and doubles.
- Completion after ten rounds.
- Completion below the minimum wager.
- Score ordering, shared ranks, stable display ordering, and tied percentile.
- Canonical command validation and hash vectors.
- UTC key, entry cutoff, end boundary, leap day, month end, and year end.

### 16.2 D1 integration tests

- Concurrent lazy challenge creation returns one row and one seed pair.
- Concurrent attempt starts create one `(challengeId, userId)` row.
- Exact start replay returns the same attempt.
- Request ID reuse across challenge periods is rejected.
- New request ID after attempt creation recovers the consumed attempt rather than creating another.
- Conditional command append under concurrent requests.
- Exact command replay, payload mismatch, sequence-behind, and sequence-ahead behavior.
- Projection guards reject stale available-bankroll or rounds-completed snapshots.
- Terminal result and attempt status settle in one batch.
- Duplicate terminal requests return one receipt.
- Expiration is idempotent.
- Forfeits and expirations never enter eligible leaderboard queries.
- Leaderboard top 50, current-user-outside-top, rank, tie, and percentile queries.
- Ninety-day attempt cleanup preserves compact result rows and completion duration.
- Seed disclosure is absent before end and present at/after end.

### 16.3 HTTP and client tests

- Guest reads current challenge and history.
- Guest ranked start returns 401.
- Strict request schemas reject unknown score, seed, bankroll, timestamp, and card fields.
- Attempt ownership does not leak existence.
- Practice client performs no ranked writes.
- Ranked client recovers uncertain start and command responses.
- Different-browser recovery works without shared local storage.
- Countdown and cutoff use server timestamps, not a client-selected date.

### 16.4 Playwright

- Guest completes and restarts practice.
- Guest selects Ranked and receives a sign-in call to action.
- Authenticated player starts one ranked attempt.
- Starting a round reduces available bankroll and shows committed wager separately.
- Refresh resumes the same round, available bankroll, and committed wager.
- A second browser for the same account recovers the same attempt.
- A second start cannot reset a completed, forfeited, or expired attempt.
- Tampered commands and sequences are rejected without state mutation.
- A completed result appears with score, rank, percentile, and receipt.
- Practice completion never changes the leaderboard.
- Tied results share a rank.
- Ranked entry closes at 23:30 UTC and a new challenge appears at 00:00 UTC.
- A closed challenge reveals the ranked seed and remains reproducible.

---

## 17. Delivery slices

1. **Challenge contracts and pure replay** — configuration, seed derivation, command schemas, multi-round state, scoring, and unit tests.
2. **D1 schema and repository** — challenge creation, attempt/result persistence, guarded transitions, ranking queries, and integration tests.
3. **Coordinator and API** — start, resume, command, expiration, idempotency, HTTP validation, and structured logging.
4. **Practice and shared Blackjack presentation** — focused renderer extraction and local practice client.
5. **Daily Challenge page** — mode selection, gameplay, countdowns, result panel, leaderboard, history, and navigation links.
6. **Scheduled expiration and retention** — Worker job integration, cleanup, and operational tests.
7. **End-to-end verification** — Playwright coverage, accessibility checks, lint, format, build, unit, integration, and E2E suites.

The detailed implementation plan must identify exact file changes and test-first checkpoints after this design is reviewed.

---

## 18. Acceptance criteria mapping

- **Same daily configuration:** one unique persisted challenge row per `(blackjack-daily, UTC periodKey)`.
- **Same deterministic ranked scenarios:** one hidden persisted ranked master seed with versioned per-round derivation.
- **One ranked attempt:** unique `(challengeId, userId)` consumed at attempt creation.
- **Unlimited practice:** local public-practice-seed replay with no ranked persistence.
- **Server verification:** score and result derive only from canonical replay.
- **Duplicate idempotency:** request IDs, command sequences, guarded writes, and immutable receipts.
- **Rank and percentile:** immutable eligible-result queries using versioned score semantics.
- **Recent history:** seven-day public history plus authenticated player result.
- **Guest support:** public page and practice; authentication required only for ranked start/resume/command.
- **UTC rollover:** shared period helpers, explicit entry cutoff/end timestamps, lazy creation, and boundary tests.
- **Tampering coverage:** strict schemas and server-owned challenge, seed, bankroll, cards, outcomes, and scores.

---

## 19. Linear issue alignment

HPA-176 describes the same Daily Challenge product under a second roadmap and an older prerequisite model. After this design is approved in repository review:

- Fold any remaining useful wording from HPA-176 into HPA-175.
- Mark HPA-176 as a duplicate of HPA-175.
- Treat completed HPA-170 as the implementation foundation.
- Do not retain HPA-169 as an additional blocker for this MVP.
- Keep weekly/monthly competition, divisions, finalization, and rewards under HPA-177.
