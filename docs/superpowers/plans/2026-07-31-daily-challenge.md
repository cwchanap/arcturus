# Daily Challenge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship HPA-175 as a public Daily Challenge experience with one server-verified Blackjack attempt per authenticated user per UTC day, unlimited guest-safe practice, deterministic multi-round replay, live shared-rank standings, historical seed verification, and no account-wallet or ranked-statistics side effects.

**Architecture:** Add a sibling `daily-challenge` domain around the existing immutable `blackjack-ranked-v1` engine. Pure versioned seed derivation and multi-round replay feed a dedicated D1 repository and coordinator. Thin Astro handlers expose public cached challenge reads and authenticated no-store attempt mutations. Browser code validates every payload, lazy-loads the local replay engine for practice/history, and reuses extracted Blackjack presentation primitives without importing ranked wallet/reward UI.

**Tech Stack:** Astro 5 SSR on Cloudflare Workers, Cloudflare D1, Drizzle ORM/Kit, Zod 4, Web Crypto, `@noble/hashes` 2.2, Bun test, Miniflare/workerd D1 integration tests, happy-dom, Vitest route integration where needed, Playwright. Design spec: `docs/superpowers/specs/2026-07-31-daily-challenge-design.md`.

## Global Constraints

- **Branching:** Do not implement runtime code on the documentation branch. After PR #24 is approved and merged, update `main` and create `codex/hpa-175-daily-challenge-impl`.
- **Runtime:** Production code runs on Cloudflare Workers. Do not use Node-only APIs or `process.env` outside tests and build tooling.
- **Game scope:** `blackjack-daily-v1` is the only Daily Challenge ruleset and composes the existing immutable `blackjack-ranked-v1` hand engine.
- **Challenge constants:** Starting bankroll 1,000; 10 rounds; wager range 10–1,000; attempt TTL 1,800 seconds; ranked entry closes 1,800 seconds before the UTC day ends.
- **Time:** Persist and compare Unix seconds. Capture the injected clock once per operation or retry iteration. Reuse `getDailyPeriodKey`; do not scatter `Date.now()` in coordinator/catalog logic.
- **Trust boundary:** Ranked requests accept only a strict start request or one sequenced command. Never accept cards, seeds, bankroll, payout, score, rank, percentile, timestamps, or terminal state from the browser.
- **Wallet isolation:** Daily Challenge code must not read or mutate `user.chipBalance`, `heldChips`, multiplayer escrow, `ranked_session`, `ranked_game_stats`, achievements, missions, or rewards.
- **Randomness:** Ranked and practice master seeds are independent 32-byte values stored as canonical unpadded base64url. Live ranked seeds and derived round seeds never enter application responses or logs.
- **Versioning:** Resolve seed domains and encoding from the persisted `challengeRulesetVersion`. `blackjack-daily-v1` uses the approved v1 domains and unsigned 64-bit big-endian round indexes.
- **Fairness claim:** The MVP gives independent players identical server-generated inputs. It does not claim spoiler, collusion, multi-account, or external-communication resistance.
- **Command sequence:** The attempt owns one global `nextCommandSequence`. The adapter's per-round `nextSequence` stays internal and is stripped from Daily Challenge responses.
- **Wager errors:** Static schema/ruleset violations return `INVALID_WAGER`; a valid wager or additional split/double wager exceeding the virtual bankroll returns `INSUFFICIENT_CHALLENGE_BANKROLL`.
- **Terminal precedence:** After settlement, round-count completion wins over bankroll-below-minimum. Both eligible reasons persist attempt status `completed`; the result/receipt retains the specific terminal reason.
- **Terminal recovery:** Completion, accepted forfeit, and lazy expiry return immutable successful terminal responses. `ATTEMPT_COMPLETE` from a command is a client recovery signal followed by one resume read.
- **Idempotency:** Consume the one daily attempt when the attempt row is created. Unique constraints, request IDs, command sequences, action-log hashes, guarded projections, and immutable receipts remain authoritative.
- **Public reads:** Apply exact query bounds and cache headers from the design. Never put authenticated/current-user data in shared cache. Set `Vary: Cookie` on endpoints whose shape can personalize.
- **Guest abuse controls:** Do not create fake users to reuse `ranked_rate_limit`. Use CDN caching, bounded indexed queries, and operational Cloudflare/WAF limits if needed.
- **Scheduling:** Extend the existing hourly `src/worker.ts` → `runScheduledJobs` pipeline. Do not add another cron trigger.
- **Retention:** Keep challenges and compact results. Delete terminal attempt/action-log rows after 90 days. Never delete an active attempt before expiring it.
- **Browser bundle:** Lazy-load deterministic replay code only when Practice or historical replay starts. Record the emitted chunk size in the implementation PR.
- **Source style:** Use tabs, single quotes, semicolons, strict schemas, and redacted identifiers in logs.
- **Testing:** Write each test first, run it to observe the expected failure, implement the minimum contract, and rerun before committing.
- **Scope fence:** Do not add seasons, divisions, rewards, continuous shoes, basic-strategy grading, live-player presence, anti-collusion systems, or HPA-177 behavior.

---

## File Structure

### Pure and browser-safe domain

| File                                          | Responsibility                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------ |
| `src/lib/ranked/blackjack/types.ts`           | Shared internal and public Blackjack types                                     |
| `src/lib/ranked/blackjack/projection.ts`      | Balance-neutral public projection for ranked and Daily Challenge               |
| `src/lib/ranked/blackjack/projection.test.ts` | Projection secrecy, funding, terminal, and adapter-equivalence tests           |
| `src/lib/ranked/blackjack/adapter.ts`         | Preserve adapter contract while delegating projection                          |
| `src/lib/ranked/blackjack/adapter.test.ts`    | Existing adapter compatibility assertions                                      |
| `src/lib/ranked/random.ts`                    | Export the shared unsigned 64-bit big-endian encoder                           |
| `src/lib/ranked/random.test.ts`               | Encoder and existing random-stream compatibility                               |
| `src/lib/daily-challenge/protocol.ts`         | Strict commands, responses, identifiers, receipts, and error codes             |
| `src/lib/daily-challenge/protocol.test.ts`    | Schema, identifier, response-shape, and error mapping tests                    |
| `src/lib/daily-challenge/config.ts`           | Immutable v1 config and UTC challenge-window helpers                           |
| `src/lib/daily-challenge/config.test.ts`      | Config identity and UTC-boundary vectors                                       |
| `src/lib/daily-challenge/random.ts`           | Versioned seed registry, commitments, and per-round derivation                 |
| `src/lib/daily-challenge/random.test.ts`      | Known seed/commitment/HMAC vectors and version failure                         |
| `src/lib/daily-challenge/replay.ts`           | Pure multi-round command replay and virtual-bankroll state                     |
| `src/lib/daily-challenge/replay.test.ts`      | Round segmentation, actions, bankroll, terminal precedence, and replay vectors |
| `src/lib/daily-challenge/scoring.ts`          | Score comparison and percentile helpers                                        |
| `src/lib/daily-challenge/scoring.test.ts`     | Shared ranks, stable display order, and percentile tests                       |

### D1 and server orchestration

| File                                                        | Responsibility                                                                |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `src/db/schema.ts`                                          | Three Daily Challenge tables and indexes                                      |
| `drizzle/0015_daily_challenge.sql`                          | Generated D1 migration on the current migration sequence                      |
| `src/server/daily-challenge/test-d1.ts`                     | Daily aliases/helpers over the existing migrated Miniflare harness            |
| `src/server/daily-challenge/schema.integration.test.ts`     | Real schema constraints and indexes                                           |
| `src/server/daily-challenge/repository.ts`                  | Challenge, attempt, result, leaderboard, history, and cleanup persistence     |
| `src/server/daily-challenge/repository.integration.test.ts` | Real D1 races, guarded transitions, ranking, and retention                    |
| `src/server/daily-challenge/coordinator.ts`                 | Current/history reads, start/resume/command, render, and expiry orchestration |
| `src/server/daily-challenge/coordinator.test.ts`            | Clock, idempotency, classification, receipt, and recovery tests               |
| `src/server/daily-challenge/http.ts`                        | Injectable handlers, validation, status mapping, and cache policy             |
| `src/server/daily-challenge/http.test.ts`                   | Auth, parsing, cache, privacy, and route-contract tests                       |
| `src/server/daily-challenge/expiration.ts`                  | Bounded expiry and 90-day attempt retention                                   |
| `src/server/daily-challenge/expiration.test.ts`             | Pagination, poison-row progress, and retention tests                          |
| `src/server/ranked/rate-limit.ts`                           | Generic authenticated operations plus compatibility exports                   |
| `src/server/ranked/rate-limit.test.ts`                      | Ranked compatibility and Daily Challenge policy tests                         |
| `src/server/cleanup.ts`                                     | Independent Daily Challenge scheduled jobs                                    |
| `src/server/cleanup.test.ts`                                | Scheduled ordering and error isolation                                        |
| `src/worker.ts`                                             | Production coordinator/repository wiring                                      |

### API routes

| File                                                             | Endpoint                                                 |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| `src/pages/api/daily-challenges/current/index.ts`                | `GET /api/daily-challenges/current`                      |
| `src/pages/api/daily-challenges/current/attempts.ts`             | `POST /api/daily-challenges/current/attempts`            |
| `src/pages/api/daily-challenges/history.ts`                      | `GET /api/daily-challenges/history`                      |
| `src/pages/api/daily-challenges/[periodKey]/index.ts`            | `GET /api/daily-challenges/:periodKey`                   |
| `src/pages/api/daily-challenges/[periodKey]/leaderboard.ts`      | `GET /api/daily-challenges/:periodKey/leaderboard`       |
| `src/pages/api/daily-challenge-attempts/[attemptId]/index.ts`    | `GET /api/daily-challenge-attempts/:attemptId`           |
| `src/pages/api/daily-challenge-attempts/[attemptId]/commands.ts` | `POST /api/daily-challenge-attempts/:attemptId/commands` |

### Browser experience

| File                                                | Responsibility                                                                          |
| --------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/lib/blackjack/presentation.ts`                 | Shared card, hand-value, dealer, and player-hand rendering                              |
| `src/lib/blackjack/presentation.test.ts`            | Generic presentation and ranked-ID compatibility                                        |
| `src/lib/ranked/blackjack/ui.ts`                    | Ranked-specific wallet, receipt, stats, and achievements using shared presentation      |
| `src/lib/ranked/blackjack/ui.test.ts`               | Preserve existing ranked UI behavior                                                    |
| `src/lib/daily-challenge/payload.ts`                | Runtime validation for challenge/attempt/leaderboard/history responses                  |
| `src/lib/daily-challenge/payload.test.ts`           | Strict public payload validation                                                        |
| `src/lib/daily-challenge/client.ts`                 | Current metadata, ranked storage, retry/resume recovery, and local replay orchestration |
| `src/lib/daily-challenge/client.test.ts`            | Start substitution, uncertain command, expiry recovery, and storage races               |
| `src/lib/daily-challenge/ui.ts`                     | Mode selection, game HUD, receipts, leaderboard, and history rendering                  |
| `src/lib/daily-challenge/ui.test.ts`                | happy-dom UI and accessibility states                                                   |
| `src/pages/games/daily-challenge.astro`             | Current Daily Challenge shell                                                           |
| `src/pages/games/daily-challenge/[periodKey].astro` | Closed challenge verification/replay shell                                              |
| `src/pages/games/index.astro`                       | Daily Challenge discovery card/link                                                     |
| `src/pages/games/blackjack.astro`                   | Daily Challenge link without changing Casual behavior                                   |
| `e2e/daily-challenge.spec.ts`                       | Guest, authenticated, recovery, standings, and history flows                            |

---

### Task 1: Extract a Balance-Neutral Blackjack Projection

**Files:**

- Modify: `src/lib/ranked/blackjack/types.ts`
- Create: `src/lib/ranked/blackjack/projection.ts`
- Create: `src/lib/ranked/blackjack/projection.test.ts`
- Modify: `src/lib/ranked/blackjack/adapter.ts`
- Modify: `src/lib/ranked/blackjack/adapter.test.ts`

**Interfaces:**

- Produces: `projectRankedBlackjackReplay(replay, availableBalance, forceTerminal?)`.
- Preserves: `blackjackRankedV1Adapter.project()` and `.projectTerminal()` byte-equivalent behavior.
- Produces: public Blackjack types in `types.ts` so Daily Challenge does not import browser client types.

- [ ] **Step 1: Move public type declarations into `types.ts` without changing their shapes**

Add the existing public card/hand/dealer/state interfaces to `src/lib/ranked/blackjack/types.ts`:

```typescript
import type { Card, HandValue } from '../../blackjack/types';

export interface RankedBlackjackPublicHandV1 {
	readonly cards: readonly Card[];
	readonly wager: number;
	readonly value: HandValue;
}

export interface RankedBlackjackPublicDealerV1 {
	readonly cards: readonly Card[];
	readonly value: HandValue;
}

export interface RankedBlackjackPublicStateV1 {
	readonly phase: 'player-turn' | 'complete';
	readonly playerHands: readonly RankedBlackjackPublicHandV1[];
	readonly activeHandIndex: number;
	readonly dealer: RankedBlackjackPublicDealerV1;
	readonly committedWager: number;
	readonly nextSequence: number;
	readonly availableActions: readonly RankedBlackjackAction[];
	readonly outcome: RankedBlackjackOutcomeV1 | null;
}
```

Remove the duplicate declarations from `adapter.ts` only after all imports compile.

- [ ] **Step 2: Write failing projection tests**

Create `projection.test.ts` with a fixed replay and assert:

```typescript
test('filters split and double-down using the supplied available balance', () => {
	const projected = projectRankedBlackjackReplay(replayWithFundingActions, 9);

	expect(projected.availableActions).toEqual(['hit', 'stand']);
	expect(projected.nextSequence).toBe(replayWithFundingActions.nextSequence);
});

test('force-terminal reveals the dealer and clears actions', () => {
	const projected = projectRankedBlackjackReplay(incompleteReplay, 1000, true);

	expect(projected.phase).toBe('complete');
	expect(projected.dealer.cards).toHaveLength(incompleteReplay.state.dealerHand.cards.length);
	expect(projected.availableActions).toEqual([]);
});
```

Add an adapter compatibility assertion:

```typescript
expect(blackjackRankedV1Adapter.project(replay, 250)).toEqual(
	projectRankedBlackjackReplay(replay, 250),
);
```

- [ ] **Step 3: Run focused tests and observe failure**

```bash
bun test \
	src/lib/ranked/blackjack/projection.test.ts \
	src/lib/ranked/blackjack/adapter.test.ts
```

Expected: FAIL because `projection.ts` and its export do not exist.

- [ ] **Step 4: Implement `projection.ts`**

Move the current private `projectHand`, `projectDealer`, and `projectReplay` logic into:

```typescript
export function projectRankedBlackjackReplay(
	replay: RankedBlackjackReplay,
	availableBalance: number,
	forceTerminal = false,
): RankedBlackjackPublicStateV1 {
	const isTerminal = forceTerminal || replay.state.phase === 'complete';
	const safeAvailableBalance =
		Number.isSafeInteger(availableBalance) && availableBalance >= 0 ? availableBalance : 0;
	const dealerCards = isTerminal
		? replay.state.dealerHand.cards
		: replay.state.dealerHand.cards.slice(0, 1);
	const availableActions = isTerminal
		? []
		: replay.legalActions
				.filter(
					({ additionalWager }) => additionalWager === 0 || safeAvailableBalance >= additionalWager,
				)
				.map(({ action }) => action);

	return {
		phase: isTerminal ? 'complete' : replay.state.phase,
		playerHands: replay.state.playerHands.map(({ cards, wager }) => ({
			cards: cards.map((card) => ({ ...card })),
			wager,
			value: calculateHandValue(cards),
		})),
		activeHandIndex: replay.state.activeHandIndex,
		dealer: {
			cards: dealerCards.map((card) => ({ ...card })),
			value: calculateHandValue(dealerCards),
		},
		committedWager: replay.state.committedWager,
		nextSequence: replay.nextSequence,
		availableActions,
		outcome: replay.outcome,
	};
}
```

Delegate both adapter projection methods to this function. Keep the ranked public payload unchanged.

- [ ] **Step 5: Run compatibility tests**

```bash
bun test \
	src/lib/ranked/blackjack/projection.test.ts \
	src/lib/ranked/blackjack/adapter.test.ts \
	src/lib/ranked/blackjack/client.test.ts \
	src/lib/ranked/blackjack/ui.test.ts
```

Expected: PASS with no ranked response or UI change.

- [ ] **Step 6: Commit**

```bash
git add \
	src/lib/ranked/blackjack/types.ts \
	src/lib/ranked/blackjack/projection.ts \
	src/lib/ranked/blackjack/projection.test.ts \
	src/lib/ranked/blackjack/adapter.ts \
	src/lib/ranked/blackjack/adapter.test.ts
git commit -m "refactor: share blackjack public projection (HPA-175)"
```

---

### Task 2: Define Daily Challenge Configuration, Protocol, and Seed Registry

**Files:**

- Modify: `src/lib/ranked/random.ts`
- Modify: `src/lib/ranked/random.test.ts`
- Create: `src/lib/daily-challenge/config.ts`
- Create: `src/lib/daily-challenge/config.test.ts`
- Create: `src/lib/daily-challenge/protocol.ts`
- Create: `src/lib/daily-challenge/protocol.test.ts`
- Create: `src/lib/daily-challenge/random.ts`
- Create: `src/lib/daily-challenge/random.test.ts`

**Interfaces:**

- Produces: immutable `BLACKJACK_DAILY_V1_CONFIG`.
- Produces: strict start/command/path/query schemas and stable error codes.
- Produces: `createDailyChallengeSeedCommitment()` and `deriveDailyChallengeRoundSeed()`.
- Preserves: existing ranked random vectors.

- [ ] **Step 1: Export the existing unsigned 64-bit encoder with tests**

Rename the private function in `src/lib/ranked/random.ts` without changing its implementation:

```typescript
export function encodeUint64BigEndian(counter: bigint): Uint8Array {
	if (typeof counter !== 'bigint' || counter < 0n || counter > MAX_UINT64) {
		throw new RangeError('Counter must be an unsigned 64-bit integer');
	}
	const encoded = new Uint8Array(8);
	let remaining = counter;
	for (let offset = encoded.length - 1; offset >= 0; offset -= 1) {
		encoded[offset] = Number(remaining & 0xffn);
		remaining >>= 8n;
	}
	return encoded;
}
```

Update `deriveRankedCounterBlock` to call the exported function. Add fixed tests for `0n`, `1n`, `0x0102030405060708n`, negative, and overflow.

- [ ] **Step 2: Write failing configuration and protocol tests**

Cover exact v1 values, strict unknown-field rejection, negative zero, request IDs, attempt IDs, period keys, limits, command tagged unions, and error statuses:

```typescript
expect(BLACKJACK_DAILY_V1_CONFIG).toEqual({
	challengeKind: 'blackjack-daily',
	challengeRulesetVersion: 'blackjack-daily-v1',
	gameType: 'blackjack',
	gameRulesetVersion: 'blackjack-ranked-v1',
	scoreVersion: 'blackjack-daily-score-v1',
	startingBankroll: 1000,
	roundCount: 10,
	minimumWager: 10,
	maximumWager: 1000,
	attemptTtlSeconds: 1800,
	rankedEntryCloseOffsetSeconds: 1800,
});

expect(dailyChallengeStartRequestSchema.safeParse({ requestId: 'a'.repeat(16) }).success).toBe(
	true,
);
expect(
	dailyChallengeStartRequestSchema.safeParse({
		requestId: 'a'.repeat(16),
		score: 5000,
	}).success,
).toBe(false);
```

Test command validation separately:

```typescript
expect(
	dailyChallengeCommandSchema.parse({
		sequence: 0,
		command: 'start-round',
		wager: 10,
	}),
).toEqual({ sequence: 0, command: 'start-round', wager: 10 });

expect(() =>
	dailyChallengeCommandSchema.parse({
		sequence: 1,
		command: 'hit',
		wager: 10,
	}),
).toThrow();
```

- [ ] **Step 3: Run and observe failure**

```bash
bun test \
	src/lib/ranked/random.test.ts \
	src/lib/daily-challenge/config.test.ts \
	src/lib/daily-challenge/protocol.test.ts \
	src/lib/daily-challenge/random.test.ts
```

Expected: FAIL because the Daily Challenge modules do not exist.

- [ ] **Step 4: Implement `config.ts`**

```typescript
export const BLACKJACK_DAILY_V1_CONFIG = Object.freeze({
	challengeKind: 'blackjack-daily',
	challengeRulesetVersion: 'blackjack-daily-v1',
	gameType: 'blackjack',
	gameRulesetVersion: 'blackjack-ranked-v1',
	scoreVersion: 'blackjack-daily-score-v1',
	startingBankroll: 1000,
	roundCount: 10,
	minimumWager: 10,
	maximumWager: 1000,
	attemptTtlSeconds: 1800,
	rankedEntryCloseOffsetSeconds: 1800,
} as const);

export function getDailyChallengeWindow(nowSeconds: number) {
	if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
		throw new TypeError('Daily Challenge time must be a non-negative safe integer');
	}
	const date = new Date(nowSeconds * 1000);
	const periodKey = getDailyPeriodKey(date);
	const startsAt = Math.trunc(Date.parse(`${periodKey}T00:00:00.000Z`) / 1000);
	const endsAt = startsAt + 24 * 60 * 60;
	return {
		periodKey,
		startsAt,
		rankedEntryClosesAt: endsAt - BLACKJACK_DAILY_V1_CONFIG.rankedEntryCloseOffsetSeconds,
		endsAt,
	};
}
```

Test leap day, month end, year end, exactly 23:30, and exactly midnight.

- [ ] **Step 5: Implement strict protocol contracts**

Define:

```typescript
export const dailyChallengeRequestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const dailyChallengeAttemptIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const dailyChallengePeriodKeySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const dailyChallengeSequenceSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0));

export const dailyChallengeStartRequestSchema = z
	.object({ requestId: dailyChallengeRequestIdSchema })
	.strict();

export const dailyChallengeCommandSchema = z.discriminatedUnion('command', [
	z
		.object({
			sequence: dailyChallengeSequenceSchema,
			command: z.literal('start-round'),
			wager: z.number().refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0)),
		})
		.strict(),
	z
		.object({
			sequence: dailyChallengeSequenceSchema,
			command: z.enum(['hit', 'stand', 'double-down', 'split', 'forfeit']),
		})
		.strict(),
]);
```

Add terminal/status types, public attempt/challenge/leaderboard/history/receipt interfaces, Zod response schemas, and:

```typescript
export const DAILY_CHALLENGE_ERROR_STATUS = {
	INVALID_REQUEST: 400,
	INVALID_WAGER: 400,
	INVALID_COMMAND: 400,
	UNAUTHORIZED: 401,
	CHALLENGE_NOT_FOUND: 404,
	ATTEMPT_NOT_FOUND: 404,
	RANKED_ENTRY_CLOSED: 409,
	ATTEMPT_COMPLETE: 409,
	IDENTIFIER_REUSE_MISMATCH: 409,
	SEQUENCE_MISMATCH: 409,
	INSUFFICIENT_CHALLENGE_BANKROLL: 409,
	RATE_LIMITED: 429,
	INTERNAL_ERROR: 500,
} as const;
```

- [ ] **Step 6: Implement the immutable seed registry**

```typescript
const UTF8 = new TextEncoder();
const SEED_LENGTH = 32;

interface DailyChallengeSeedVersion {
	readonly seedCommitmentDomain: Uint8Array;
	readonly roundDerivationDomain: Uint8Array;
}

const SEED_VERSIONS: Readonly<Record<string, DailyChallengeSeedVersion>> = Object.freeze({
	'blackjack-daily-v1': Object.freeze({
		seedCommitmentDomain: UTF8.encode('arcturus:blackjack-daily-v1:seed:'),
		roundDerivationDomain: UTF8.encode('arcturus:blackjack-daily-v1:round:'),
	}),
});

function requireSeedVersion(version: string): DailyChallengeSeedVersion {
	const resolved = SEED_VERSIONS[version];
	if (!resolved) throw new RangeError(`Unsupported Daily Challenge seed version: ${version}`);
	return resolved;
}

export function createDailyChallengeSeedCommitment(version: string, seed: Uint8Array): string {
	assertDailyChallengeSeed(seed);
	const resolved = requireSeedVersion(version);
	return sha256Hex(concatBytes(resolved.seedCommitmentDomain, seed));
}

export function deriveDailyChallengeRoundSeed(
	version: string,
	masterSeed: Uint8Array,
	roundIndex: number,
): Uint8Array {
	assertDailyChallengeSeed(masterSeed);
	if (!Number.isSafeInteger(roundIndex) || roundIndex < 0) {
		throw new RangeError('Round index must be a non-negative safe integer');
	}
	const resolved = requireSeedVersion(version);
	return hmac(
		sha256,
		masterSeed,
		concatBytes(resolved.roundDerivationDomain, encodeUint64BigEndian(BigInt(roundIndex))),
	);
}
```

Add known hexadecimal vectors; never assert only that two seeds differ.

- [ ] **Step 7: Run and commit**

```bash
bun test \
	src/lib/ranked/random.test.ts \
	src/lib/daily-challenge/config.test.ts \
	src/lib/daily-challenge/protocol.test.ts \
	src/lib/daily-challenge/random.test.ts
git add \
	src/lib/ranked/random.ts \
	src/lib/ranked/random.test.ts \
	src/lib/daily-challenge/config.ts \
	src/lib/daily-challenge/config.test.ts \
	src/lib/daily-challenge/protocol.ts \
	src/lib/daily-challenge/protocol.test.ts \
	src/lib/daily-challenge/random.ts \
	src/lib/daily-challenge/random.test.ts
git commit -m "feat: define daily challenge contracts (HPA-175)"
```

---

### Task 3: Implement Pure Multi-Round Replay and Scoring

**Files:**

- Create: `src/lib/daily-challenge/replay.ts`
- Create: `src/lib/daily-challenge/replay.test.ts`
- Create: `src/lib/daily-challenge/scoring.ts`
- Create: `src/lib/daily-challenge/scoring.test.ts`

**Interfaces:**

- Produces: `replayDailyChallenge(config, masterSeed, commands)`.
- Produces: `compareDailyChallengeScores()`, `calculateDailyChallengePercentile()`.
- Consumes: the existing deterministic Blackjack engine and the shared projection helper.
- Never reads D1, account state, or time.

- [ ] **Step 1: Write deterministic round-segmentation tests**

Use fixed seeds and global commands. Prove the adapter receives fresh per-round action sequences:

```typescript
const commands: DailyChallengeCommandV1[] = [
	{ sequence: 0, command: 'start-round', wager: 10 },
	{ sequence: 1, command: 'stand' },
	{ sequence: 2, command: 'start-round', wager: 20 },
	{ sequence: 3, command: 'hit' },
	{ sequence: 4, command: 'stand' },
];

const replay = replayDailyChallenge(BLACKJACK_DAILY_V1_CONFIG, FIXED_SEED, commands);

expect(replay.nextCommandSequence).toBe(5);
expect(replay.roundsCompleted).toBe(2);
expect(replay.rounds[0].adapterActions.map((entry) => entry.sequence)).toEqual([0]);
expect(replay.rounds[1].adapterActions.map((entry) => entry.sequence)).toEqual([0, 1]);
```

Use a test seam only for fixed deck fixtures if a natural opening would make a chosen action illegal. The production function still derives real round seeds.

- [ ] **Step 2: Write bankroll and terminal tests**

Cover:

- initial wager deduction;
- split/double additional wager deduction;
- gross `outcome.payout` credit;
- push, win, loss, Blackjack, split, and double;
- odd-wager 3:2 floor;
- below-minimum completion before round 10;
- round 10 with bankroll below 10 resolves as `completed`;
- accepted forfeit is ineligible and never reaches the adapter;
- invalid static wager versus dynamic funding error;
- byte-identical replay for identical inputs.

Representative assertions:

```typescript
expect(roundSettlement.availableBankroll).toBe(
	bankrollBeforeRound - roundSettlement.committedWager + roundSettlement.outcome.payout,
);

expect(roundTenLowBankroll).toMatchObject({
	status: 'completed',
	terminalReason: 'completed',
	eligible: true,
	roundsCompleted: 10,
});
```

- [ ] **Step 3: Run and observe failure**

```bash
bun test \
	src/lib/daily-challenge/replay.test.ts \
	src/lib/daily-challenge/scoring.test.ts
```

Expected: FAIL because replay and scoring modules do not exist.

- [ ] **Step 4: Implement replay state contracts**

```typescript
export interface DailyChallengeInternalRoundV1 {
	readonly roundIndex: number;
	readonly initialWager: number;
	readonly adapterActions: readonly RankedBlackjackActionLogEntryV1[];
	readonly replay: RankedBlackjackReplay;
}

export interface DailyChallengeReplayV1 {
	readonly availableBankroll: number;
	readonly roundsCompleted: number;
	readonly rounds: readonly DailyChallengeInternalRoundV1[];
	readonly activeRound: DailyChallengeInternalRoundV1 | null;
	readonly activeRoundPublic: Omit<RankedBlackjackPublicStateV1, 'nextSequence'> | null;
	readonly nextCommandSequence: number;
	readonly status: 'active' | 'completed' | 'forfeited';
	readonly terminalReason: 'completed' | 'bankroll-below-minimum' | 'forfeited' | null;
	readonly eligible: boolean | null;
}
```

- [ ] **Step 5: Implement the command loop**

The reducer must:

1. require global contiguous sequences;
2. create each round with `issueBlackjackConfig(wager)`;
3. derive a round seed from the implicit round index;
4. replay each round from zero-based adapter actions;
5. inspect `legalActions` before applying an action;
6. deduct `additionalWager` before appending split/double;
7. credit only aggregate `outcome.payout`;
8. evaluate terminal precedence after settlement;
9. consume `forfeit` at the attempt layer.

Core settlement helper:

```typescript
function settleCompletedRound(
	state: MutableDailyChallengeReplay,
	replay: RankedBlackjackReplay,
): void {
	const outcome = replay.outcome;
	if (!outcome) throw new DailyChallengeReplayInvariantError('Completed round has no outcome');
	state.availableBankroll += outcome.payout;
	state.roundsCompleted += 1;
	state.activeRound = null;

	if (state.roundsCompleted === state.config.roundCount) {
		state.status = 'completed';
		state.terminalReason = 'completed';
		return;
	}
	if (state.availableBankroll < state.config.minimumWager) {
		state.status = 'completed';
		state.terminalReason = 'bankroll-below-minimum';
	}
}
```

Project the active round through `projectRankedBlackjackReplay`, then remove `nextSequence` before returning browser-safe state.

- [ ] **Step 6: Implement scoring helpers**

```typescript
export interface DailyChallengeScore {
	readonly endingBankroll: number;
	readonly roundsCompleted: number;
}

export function compareDailyChallengeScores(
	left: DailyChallengeScore,
	right: DailyChallengeScore,
): number {
	if (left.endingBankroll !== right.endingBankroll) {
		return right.endingBankroll - left.endingBankroll;
	}
	return right.roundsCompleted - left.roundsCompleted;
}

export function calculateDailyChallengePercentile(
	totalEligible: number,
	playersStrictlyAbove: number,
): number {
	if (!Number.isSafeInteger(totalEligible) || totalEligible < 1) {
		throw new RangeError('An eligible result requires at least one eligible player');
	}
	if (
		!Number.isSafeInteger(playersStrictlyAbove) ||
		playersStrictlyAbove < 0 ||
		playersStrictlyAbove >= totalEligible
	) {
		throw new RangeError('Players strictly above is outside the eligible population');
	}
	const playersAtOrBelow = totalEligible - playersStrictlyAbove;
	return Math.min(100, Math.max(1, Math.round((100 * playersAtOrBelow) / totalEligible)));
}
```

- [ ] **Step 7: Run and commit**

```bash
bun test \
	src/lib/daily-challenge/replay.test.ts \
	src/lib/daily-challenge/scoring.test.ts \
	src/lib/ranked/blackjack/engine.test.ts \
	src/lib/ranked/blackjack/projection.test.ts
git add \
	src/lib/daily-challenge/replay.ts \
	src/lib/daily-challenge/replay.test.ts \
	src/lib/daily-challenge/scoring.ts \
	src/lib/daily-challenge/scoring.test.ts
git commit -m "feat: add deterministic daily challenge replay (HPA-175)"
```

---

### Task 4: Add Daily Challenge Persistence Schema

**Files:**

- Modify: `src/db/schema.ts`
- Create: `drizzle/0015_daily_challenge.sql`
- Create: `src/server/daily-challenge/test-d1.ts`
- Create: `src/server/daily-challenge/schema.integration.test.ts`

**Interfaces:**

- Produces: `dailyChallenge`, `dailyChallengeAttempt`, and `dailyChallengeResult`.
- Reuses: the existing migration-discovering Miniflare harness.
- Preserves: ranked schema and cleanup behavior.

- [ ] **Step 1: Add a thin Daily Challenge test harness wrapper**

```typescript
export {
	createRankedTestD1 as createDailyChallengeTestD1,
	insertRankedTestUser as insertDailyChallengeTestUser,
} from '../ranked/test-d1';
```

Add Daily-specific insert helpers only after the schema exists. Do not duplicate migration discovery.

- [ ] **Step 2: Write failing real-D1 schema tests**

Assert:

- unique `(challengeKind, periodKey)`;
- unique `(challengeId, userId)`;
- global unique `(userId, startRequestId)`;
- result primary key `(challengeId, userId)`;
- result unique `attemptId` without an FK to attempt;
- challenge/result rows survive terminal attempt deletion;
- status/expiry and leaderboard indexes exist.

Run:

```bash
bun test src/server/daily-challenge/schema.integration.test.ts
```

Expected: FAIL because the tables do not exist.

- [ ] **Step 3: Add Drizzle tables**

Use Unix-second timestamp comments consistent with ranked schema:

```typescript
export const dailyChallenge = sqliteTable(
	'daily_challenge',
	{
		id: text('id').primaryKey(),
		challengeKind: text('challengeKind').notNull(),
		periodKey: text('periodKey').notNull(),
		challengeRulesetVersion: text('challengeRulesetVersion').notNull(),
		gameRulesetVersion: text('gameRulesetVersion').notNull(),
		scoreVersion: text('scoreVersion').notNull(),
		configJson: text('configJson').notNull(),
		configHash: text('configHash').notNull(),
		rankedSeed: text('rankedSeed').notNull(),
		rankedSeedCommitment: text('rankedSeedCommitment').notNull(),
		practiceSeed: text('practiceSeed').notNull(),
		startsAt: integer('startsAt', { mode: 'timestamp' }).notNull(),
		rankedEntryClosesAt: integer('rankedEntryClosesAt', { mode: 'timestamp' }).notNull(),
		endsAt: integer('endsAt', { mode: 'timestamp' }).notNull(),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({
		periodUnique: uniqueIndex('daily_challenge_kind_period_idx').on(
			table.challengeKind,
			table.periodKey,
		),
		endsAtIdx: index('daily_challenge_ends_at_idx').on(table.endsAt),
	}),
);
```

Define attempt and result exactly as approved, using `nextCommandSequence` in the attempt row. Do not add an FK from result `attemptId` to attempt.

- [ ] **Step 4: Generate and inspect the migration**

```bash
bun run db:generate -- --name=daily_challenge
```

Expected on current `main`: `drizzle/0015_daily_challenge.sql`.

If a newer `main` already owns `0015`, keep the generated next sequence and update the plan path in the implementation PR description. Do not manually renumber migration metadata.

Inspect that the generated SQL contains all three tables, constraints, and indexes and no unrelated schema changes.

- [ ] **Step 5: Run schema and migration checks**

```bash
bun test \
	src/server/ranked/schema.integration.test.ts \
	src/server/daily-challenge/schema.integration.test.ts
bun run db:migrate:local
```

Expected: PASS; local migration applies cleanly from the checked-in sequence.

- [ ] **Step 6: Commit**

```bash
git add \
	src/db/schema.ts \
	drizzle/0015_daily_challenge.sql \
	src/server/daily-challenge/test-d1.ts \
	src/server/daily-challenge/schema.integration.test.ts
git commit -m "feat: add daily challenge persistence schema (HPA-175)"
```

---

### Task 5: Implement Challenge Catalog and Start Persistence

**Files:**

- Create: `src/server/daily-challenge/repository.ts`
- Create: `src/server/daily-challenge/repository.integration.test.ts`

**Interfaces:**

- Produces: strict challenge/attempt/result records.
- Produces: lazy challenge insert/read and one-attempt start transition.
- Produces: request-ID and challenge/user lookup paths for race classification.

- [ ] **Step 1: Define repository records and schemas**

Create parsed record types for:

```typescript
export interface DailyChallengeRecord {
	id: string;
	challengeKind: 'blackjack-daily';
	periodKey: string;
	challengeRulesetVersion: 'blackjack-daily-v1';
	gameRulesetVersion: 'blackjack-ranked-v1';
	scoreVersion: 'blackjack-daily-score-v1';
	configJson: string;
	configHash: string;
	rankedSeed: string;
	rankedSeedCommitment: string;
	practiceSeed: string;
	startsAt: number;
	rankedEntryClosesAt: number;
	endsAt: number;
	createdAt: number;
	config: typeof BLACKJACK_DAILY_V1_CONFIG;
}

export interface DailyChallengeAttemptRecord {
	id: string;
	challengeId: string;
	userId: string;
	startRequestId: string;
	startPayloadHash: string;
	status: 'active' | 'completed' | 'forfeited' | 'expired';
	actionLogJson: string;
	actionLogHash: string;
	nextCommandSequence: number;
	availableBankroll: number;
	roundsCompleted: number;
	expiresAt: number;
	createdAt: number;
	updatedAt: number;
	settledAt: number | null;
	actionLog: DailyChallengeCommandV1[];
}
```

Use Zod to validate database JSON and safe integers before returning a record.

- [ ] **Step 2: Write failing catalog and start integration tests**

Cover:

- concurrent lazy creation stores one seed pair;
- losing creators reread the winner;
- exact start request replay;
- different request ID recovers the consumed daily attempt;
- request ID reuse across periods is classified as mismatch;
- concurrent different request IDs return one winning attempt;
- no `user` balance field is read or changed;
- start rate-limit continuation is atomic with attempt creation.

- [ ] **Step 3: Run and observe failure**

```bash
bun test src/server/daily-challenge/repository.integration.test.ts
```

Expected: FAIL because the repository does not exist.

- [ ] **Step 4: Implement catalog SQL**

```typescript
const INSERT_CHALLENGE_SQL = `INSERT INTO daily_challenge (
	id, challengeKind, periodKey, challengeRulesetVersion, gameRulesetVersion,
	scoreVersion, configJson, configHash, rankedSeed, rankedSeedCommitment,
	practiceSeed, startsAt, rankedEntryClosesAt, endsAt, createdAt
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (challengeKind, periodKey) DO NOTHING`;
```

Expose:

```typescript
findChallengeByPeriodKey(challengeKind, periodKey)
insertChallengeIfAbsent(record): Promise<'inserted' | 'existing'>
```

After any create attempt, the coordinator rereads the persisted row. Never return an unpersisted candidate seed.

- [ ] **Step 5: Implement start transition SQL**

Pre-read idempotency occurs in the coordinator. The atomic transition includes the rate-limit continuation and guarded insert:

```typescript
const INSERT_ATTEMPT_SQL = `INSERT INTO daily_challenge_attempt (
	id, challengeId, userId, startRequestId, startPayloadHash, status,
	actionLogJson, actionLogHash, nextCommandSequence, availableBankroll,
	roundsCompleted, expiresAt, createdAt, updatedAt
) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, 0, ?, 0, ?, ?, ?)
ON CONFLICT DO NOTHING`;
```

Return:

```typescript
export type DailyChallengeStartTransitionResult =
	| { kind: 'created' }
	| { kind: 'not-created' }
	| { kind: 'rate-limited'; retryAfter: number };
```

Inspect every `meta.changes` value. A unique conflict is not an internal error; it is classified by rereading `(userId, requestId)` and then `(challengeId, userId)`.

- [ ] **Step 6: Run focused tests**

```bash
bun test src/server/daily-challenge/repository.integration.test.ts
```

Expected: PASS, including concurrent-start tests.

- [ ] **Step 7: Commit**

```bash
git add \
	src/server/daily-challenge/repository.ts \
	src/server/daily-challenge/repository.integration.test.ts
git commit -m "feat: add daily challenge catalog and start persistence (HPA-175)"
```

---

### Task 6: Add Guarded Command, Result, Leaderboard, History, and Retention Persistence

**Files:**

- Modify: `src/server/daily-challenge/repository.ts`
- Modify: `src/server/daily-challenge/repository.integration.test.ts`

**Interfaces:**

- Produces: guarded active command updates and atomic terminal result insertion.
- Produces: expiry transitions, top-50/shared ranks, current-user rank/percentile, history, and retention queries.

- [ ] **Step 1: Write failing guarded-transition tests**

Cover:

- expected status, sequence, prior log hash, bankroll, and rounds projection;
- one winning concurrent command;
- exact duplicate leaves one result;
- terminal update/result insert are atomic;
- result survives attempt deletion;
- expiry does not append a command;
- forfeit command remains in the log;
- stale projections cannot mutate state.

Representative stale guard:

```typescript
const result = await repository.runCommandTransition({
	userId,
	attemptId,
	expectedSequence: 2,
	expectedActionLogHash: 'stale-hash',
	expectedAvailableBankroll: 990,
	expectedRoundsCompleted: 0,
	nextActionLogJson,
	nextActionLogHash,
	nextCommandSequence: 3,
	availableBankroll: 980,
	roundsCompleted: 0,
	nowSeconds,
});

expect(result).toEqual({ kind: 'not-applied' });
```

- [ ] **Step 2: Write failing leaderboard/history tests**

Seed tied and distinct results. Assert:

- competition rank `1, 1, 3`;
- ties use `settledAt ASC, userId ASC` only for row order;
- equal scores have equal percentile;
- top 50 plus current user outside top 50;
- ineligible results excluded;
- history returns bounded dates and the authenticated user's result;
- live leaderboard can be empty;
- expired duration is already deadline-based in the result.

- [ ] **Step 3: Run and observe failure**

```bash
bun test src/server/daily-challenge/repository.integration.test.ts
```

Expected: FAIL on unimplemented transition/read methods.

- [ ] **Step 4: Implement guarded active and terminal updates**

Use one active update statement:

```typescript
const UPDATE_ATTEMPT_SQL = `UPDATE daily_challenge_attempt
SET actionLogJson = ?,
	actionLogHash = ?,
	nextCommandSequence = ?,
	availableBankroll = ?,
	roundsCompleted = ?,
	status = ?,
	updatedAt = ?,
	settledAt = ?
WHERE id = ?
	AND userId = ?
	AND status = 'active'
	AND nextCommandSequence = ?
	AND actionLogHash = ?
	AND availableBankroll = ?
	AND roundsCompleted = ?`;
```

For terminal transitions, follow the update with this insert in the same D1 batch:

```typescript
const INSERT_RESULT_AFTER_TERMINAL_SQL = `INSERT INTO daily_challenge_result (
	attemptId, challengeId, userId, endingBankroll, roundsCompleted,
	eligible, terminalReason, durationSeconds, scoreVersion, configHash,
	rankedSeedCommitment, actionLogHash, receiptHash, createdAt, settledAt
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
WHERE changes() = 1`;
```

Require exactly one attempt update and one result insert.

- [ ] **Step 5: Implement immutable receipt/result parsing**

Store all receipt source fields and reconstruct the receipt from persisted challenge + result rows. The hash input excludes `receiptHash` and includes:

```typescript
{
	attemptId,
	challengeId,
	periodKey,
	challengeRulesetVersion,
	gameRulesetVersion,
	scoreVersion,
	configHash,
	rankedSeedCommitment,
	actionLogHash,
	endingBankroll,
	roundsCompleted,
	eligible,
	terminalReason,
	durationSeconds,
	settledAt,
}
```

- [ ] **Step 6: Implement competition-rank SQL**

Use a window over eligible results:

```sql
WITH ranked AS (
	SELECT
		r.challengeId,
		r.userId,
		u.name AS playerName,
		r.endingBankroll,
		r.roundsCompleted,
		r.durationSeconds,
		r.settledAt,
		RANK() OVER (
			ORDER BY r.endingBankroll DESC, r.roundsCompleted DESC
		) AS rank
	FROM daily_challenge_result AS r
	JOIN user AS u ON u.id = r.userId
	WHERE r.challengeId = ?
		AND r.eligible = 1
)
SELECT *
FROM ranked
ORDER BY
	endingBankroll DESC,
	roundsCompleted DESC,
	settledAt ASC,
	userId ASC
LIMIT ?;
```

Use a second bounded query/CTE for current-user rank and total eligible count. Compute percentile through the pure helper from `rank - 1`.

- [ ] **Step 7: Implement history and retention reads**

Expose:

```typescript
listChallengeHistory(limit, currentUserId?)
listExpiredAttempts(nowSeconds, cursor?)
deleteTerminalAttemptsBefore(cutoffSeconds)
```

Use `(expiresAt, id)` cursor ordering so poison rows cannot block later attempts. Delete only `status <> 'active'`.

- [ ] **Step 8: Run and commit**

```bash
bun test src/server/daily-challenge/repository.integration.test.ts
git add \
	src/server/daily-challenge/repository.ts \
	src/server/daily-challenge/repository.integration.test.ts
git commit -m "feat: add daily challenge guarded result persistence (HPA-175)"
```

---

### Task 7: Implement the Daily Challenge Coordinator

**Files:**

- Create: `src/server/daily-challenge/coordinator.ts`
- Create: `src/server/daily-challenge/coordinator.test.ts`

**Interfaces:**

- Produces: current/history reads, start, resume, command, leaderboard, history, and explicit expiry.
- Consumes: repository, injected clock/randomness, pure replay, canonical hashing.
- Does not consume account or multiplayer services.

- [ ] **Step 1: Define coordinator dependencies and API**

```typescript
export interface DailyChallengeCoordinatorDeps {
	repository: DailyChallengeRepository;
	now(): Date;
	randomBytes(length: number): Uint8Array;
	log(entry: DailyChallengeLogEntry): void;
}

export interface DailyChallengeCoordinator {
	getCurrent(input: { userId: string | null }): Promise<DailyChallengePublicResponse>;
	getByPeriod(input: {
		periodKey: string;
		userId: string | null;
	}): Promise<DailyChallengePublicResponse>;
	start(input: {
		userId: string;
		body: DailyChallengeStartRequest;
	}): Promise<DailyChallengeAttemptPublicStateV1>;
	resume(input: { userId: string; attemptId: string }): Promise<DailyChallengeAttemptPublicStateV1>;
	command(input: {
		userId: string;
		attemptId: string;
		body: DailyChallengeCommandV1;
	}): Promise<DailyChallengeAttemptPublicStateV1>;
	expire(attemptId: string): Promise<DailyChallengeAttemptPublicStateV1>;
	leaderboard(input: {
		periodKey: string;
		userId: string | null;
		limit: number;
	}): Promise<DailyChallengeLeaderboardResponse>;
	history(input: { userId: string | null; limit: number }): Promise<DailyChallengeHistoryResponse>;
}
```

- [ ] **Step 2: Write failing lazy-challenge and start tests**

Cover:

- exact UTC challenge window;
- ranked/practice seeds are independent;
- concurrent catalog candidates return persisted winner;
- cutoff at `now >= rankedEntryClosesAt`;
- exact request replay before start rate consumption;
- global request-ID mismatch;
- different request ID recovers today's attempt and echoes stored `startRequestId`;
- concurrent loser returns winner;
- `expiresAt <= endsAt`;
- no account/membership calls exist in dependencies.

- [ ] **Step 3: Write failing resume/command/expiry tests**

Cover:

- ownership returns `ATTEMPT_NOT_FOUND`;
- malformed stored projection becomes `INTERNAL_ERROR`;
- sequence behind exact replay/mismatch;
- sequence ahead;
- static wager versus dynamic funding errors;
- natural opening terminal;
- accepted forfeit;
- round-10 precedence;
- lazy expiry returns successful receipt;
- retrying the unrecorded expiry-triggering command returns `ATTEMPT_COMPLETE`;
- terminal receipt remains byte-identical;
- challenge end independently blocks commands;
- effective expired duration uses deadline, not discovery time.

- [ ] **Step 4: Run and observe failure**

```bash
bun test src/server/daily-challenge/coordinator.test.ts
```

Expected: FAIL because the coordinator does not exist.

- [ ] **Step 5: Implement lazy catalog creation**

```typescript
async function getOrCreateCurrentChallenge(nowSeconds: number): Promise<DailyChallengeRecord> {
	const window = getDailyChallengeWindow(nowSeconds);
	const existing = await deps.repository.findChallengeByPeriodKey(
		BLACKJACK_DAILY_V1_CONFIG.challengeKind,
		window.periodKey,
	);
	if (existing) return existing;

	const rankedSeed = requireRandomBytes(deps.randomBytes, 32);
	const practiceSeed = requireRandomBytes(deps.randomBytes, 32);
	const candidate = buildNewChallengeRecord(window, rankedSeed, practiceSeed, nowSeconds);
	await deps.repository.insertChallengeIfAbsent(candidate);

	const persisted = await deps.repository.findChallengeByPeriodKey(
		candidate.challengeKind,
		candidate.periodKey,
	);
	if (!persisted) throw new DailyChallengeServiceError('INTERNAL_ERROR');
	return persisted;
}
```

Redact seeds from every log entry.

- [ ] **Step 6: Implement start classification**

Order:

1. capture `nowSeconds`;
2. resolve current challenge;
3. reject cutoff;
4. hash validated start body;
5. find exact `(userId, requestId)`;
6. find `(challengeId, userId)`;
7. consume start limit;
8. generate attempt ID;
9. attempt guarded insert;
10. on conflict reread exact request, then challenge/user;
11. return winner with persisted `startRequestId`.

- [ ] **Step 7: Implement render and terminal receipt**

`render()` must replay the canonical log from the persisted challenge seed and compare replay projections with stored `availableBankroll`, `roundsCompleted`, and `nextCommandSequence`. Projection disagreement is an internal invariant failure.

For an active attempt, return:

```typescript
{
	attemptId,
	challengeId,
	startRequestId,
	status: 'active',
	nextCommandSequence,
	availableBankroll,
	roundsCompleted,
	activeRound,
	receipt: null,
}
```

For terminal attempts, load the immutable result and return its receipt. Eligible responses may additionally include live rank/percentile outside the receipt.

- [ ] **Step 8: Implement command classification and recovery semantics**

- Exact behind-sequence payload returns authoritative state through the replay bucket.
- Different behind-sequence payload returns `IDENTIFIER_REUSE_MISMATCH`.
- Ahead returns `SEQUENCE_MISMATCH`.
- On-time command replays state, applies one pure transition, and calls the guarded repository method.
- A lost write rereads and classifies replay/mismatch/sequence/terminal.
- Lazy expiry occurs before applying the submitted command and returns the terminal receipt.
- A later retry of that unrecorded command returns `ATTEMPT_COMPLETE`.

- [ ] **Step 9: Run and commit**

```bash
bun test \
	src/server/daily-challenge/coordinator.test.ts \
	src/server/daily-challenge/repository.integration.test.ts
git add \
	src/server/daily-challenge/coordinator.ts \
	src/server/daily-challenge/coordinator.test.ts
git commit -m "feat: add daily challenge coordinator (HPA-175)"
```

---

### Task 8: Add HTTP Contracts and Astro API Routes

**Files:**

- Create: `src/server/daily-challenge/http.ts`
- Create: `src/server/daily-challenge/http.test.ts`
- Create all seven route files listed in File Structure

**Interfaces:**

- Produces: injectable route handlers.
- Enforces: strict validation, privacy, cache headers, bounds, and stable errors.
- Keeps route modules as one-line exports.

- [ ] **Step 1: Write failing HTTP tests**

Cover:

- guest current/detail/history/leaderboard;
- authenticated personalization is private/no-store;
- guest live/closed cache headers;
- `Vary: Cookie`;
- guest ranked start `401`;
- malformed period/attempt/request IDs;
- unknown fields;
- query limits default and reject invalid;
- static invalid wager maps `INVALID_WAGER`;
- dynamic coordinator errors preserve status;
- `Retry-After` and expected sequence;
- another user's attempt remains `ATTEMPT_NOT_FOUND`;
- `?periodKey=current` is invalid; clients resolve current first.

- [ ] **Step 2: Run and observe failure**

```bash
bun test src/server/daily-challenge/http.test.ts
```

Expected: FAIL because handlers do not exist.

- [ ] **Step 3: Implement JSON/cache helpers**

```typescript
function publicCacheControl(
	kind: 'live-detail' | 'closed-detail' | 'history' | 'leaderboard',
): string {
	switch (kind) {
		case 'live-detail':
		case 'history':
			return 'public, max-age=0, s-maxage=60, stale-while-revalidate=300';
		case 'closed-detail':
			return 'public, max-age=0, s-maxage=86400, stale-while-revalidate=604800';
		case 'leaderboard':
			return 'public, max-age=0, s-maxage=15, stale-while-revalidate=60';
	}
}

function jsonResponse(
	body: unknown,
	options: {
		status?: number;
		cacheControl: string;
		varyCookie?: boolean;
		retryAfter?: number;
	},
): Response {
	const headers = new Headers({
		'content-type': 'application/json',
		'cache-control': options.cacheControl,
	});
	if (options.varyCookie) headers.set('Vary', 'Cookie');
	if (options.retryAfter !== undefined) headers.set('Retry-After', String(options.retryAfter));
	return new Response(JSON.stringify(body), {
		status: options.status ?? 200,
		headers,
	});
}
```

Any response containing current-user attempt/result/rank data uses `private, no-store`.

- [ ] **Step 4: Implement parser boundaries**

- `periodKey`: exact UTC calendar key; reject impossible dates by round-tripping through `Date`.
- `limit`: base-10 integer string; leaderboard 1..50, history 1..7.
- start and command: strict Zod schemas.
- numeric static wager schema issues map to `INVALID_WAGER`.
- attempt and request IDs reject before repository lookup.

- [ ] **Step 5: Implement handler factory**

```typescript
export interface DailyChallengeHttpHandlers {
	current: APIRoute;
	detail: APIRoute;
	start: APIRoute;
	resume: APIRoute;
	command: APIRoute;
	leaderboard: APIRoute;
	history: APIRoute;
}
```

Each handler resolves the coordinator from `locals.runtime.env.DB`, requires auth only for writes/resume/command, and passes optional `locals.user?.id` to reads.

- [ ] **Step 6: Add thin route modules**

Example:

```typescript
// src/pages/api/daily-challenges/current/index.ts
import { dailyChallengeHttpHandlers } from '../../../../server/daily-challenge/http';

export const GET = dailyChallengeHttpHandlers.current;
```

Do not place test modules under `src/pages`.

- [ ] **Step 7: Run focused tests and build**

```bash
bun test \
	src/server/daily-challenge/http.test.ts \
	src/astro-pages-isolation.test.ts
bun run build
```

Expected: PASS and all seven routes appear in the Astro build manifest.

- [ ] **Step 8: Commit**

```bash
git add \
	src/server/daily-challenge/http.ts \
	src/server/daily-challenge/http.test.ts \
	src/pages/api/daily-challenges \
	src/pages/api/daily-challenge-attempts
git commit -m "feat: expose daily challenge APIs (HPA-175)"
```

---

### Task 9: Generalize Authenticated Rate Limits and Wire Scheduled Maintenance

**Files:**

- Modify: `src/server/ranked/rate-limit.ts`
- Modify: `src/server/ranked/rate-limit.test.ts`
- Create: `src/server/daily-challenge/expiration.ts`
- Create: `src/server/daily-challenge/expiration.test.ts`
- Modify: `src/server/cleanup.ts`
- Modify: `src/server/cleanup.test.ts`
- Modify: `src/worker.ts`

**Interfaces:**

- Adds authenticated operations without breaking ranked types.
- Produces bounded Daily Challenge expiration and retention jobs.
- Uses the existing hourly cron.

- [ ] **Step 1: Write failing generic-rate tests**

Assert the existing ranked limits remain unchanged and add:

```typescript
expect(AUTHENTICATED_RATE_LIMITS.daily_challenge_start).toEqual({
	limit: 6,
	windowSeconds: 60,
});
expect(AUTHENTICATED_RATE_LIMITS.daily_challenge_command).toEqual({
	limit: 30,
	windowSeconds: 60,
});
expect(AUTHENTICATED_RATE_LIMITS.daily_challenge_resume).toEqual({
	limit: 120,
	windowSeconds: 60,
});
expect(AUTHENTICATED_RATE_LIMITS.daily_challenge_replay).toEqual({
	limit: 120,
	windowSeconds: 60,
});
```

Prove existing ranked callers retain their accepted operation type.

- [ ] **Step 2: Implement compatibility-safe generic exports**

```typescript
export const RANKED_RATE_LIMITS = Object.freeze({
	ranked_start: Object.freeze({ limit: 6, windowSeconds: 60 }),
	ranked_action: Object.freeze({ limit: 30, windowSeconds: 60 }),
	ranked_resume: Object.freeze({ limit: 120, windowSeconds: 60 }),
	ranked_replay: Object.freeze({ limit: 120, windowSeconds: 60 }),
} as const);

export const DAILY_CHALLENGE_RATE_LIMITS = Object.freeze({
	daily_challenge_start: Object.freeze({ limit: 6, windowSeconds: 60 }),
	daily_challenge_command: Object.freeze({ limit: 30, windowSeconds: 60 }),
	daily_challenge_resume: Object.freeze({ limit: 120, windowSeconds: 60 }),
	daily_challenge_replay: Object.freeze({ limit: 120, windowSeconds: 60 }),
} as const);

export const AUTHENTICATED_RATE_LIMITS = Object.freeze({
	...RANKED_RATE_LIMITS,
	...DAILY_CHALLENGE_RATE_LIMITS,
});

export type RankedRateOperation = keyof typeof RANKED_RATE_LIMITS;
export type DailyChallengeRateOperation = keyof typeof DAILY_CHALLENGE_RATE_LIMITS;
export type AuthenticatedRateOperation = keyof typeof AUTHENTICATED_RATE_LIMITS;
```

Generalize internal helpers to `AuthenticatedRateOperation`. Keep ranked exported input aliases compatible.

- [ ] **Step 3: Write failing expiration/retention tests**

Cover:

- ordered page of 100;
- `(expiresAt, id)` cursor progress;
- poison attempt does not block later attempts;
- one failure does not stop the page;
- retention cutoff exactly 90 days;
- active attempts never deleted;
- result/challenge rows preserved.

- [ ] **Step 4: Implement bounded jobs**

```typescript
export const DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE = 100;
export const DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS = 90;

export async function runDailyChallengeExpiration(
	repository: DailyChallengeRepository,
	expire: (attemptId: string) => Promise<unknown>,
	nowSeconds: number,
): Promise<void> {
	let cursor: DailyChallengeExpirationCursor | null = null;
	for (;;) {
		const rows = await repository.listExpiredAttempts(nowSeconds, cursor);
		for (const row of rows) {
			cursor = { expiresAt: row.expiresAt, id: row.id };
			try {
				await expire(row.id);
			} catch (error) {
				console.warn('[DAILY_CHALLENGE] expiration failed', error);
			}
		}
		if (rows.length < DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE) return;
	}
}
```

Retention computes cutoff from the injected `nowSeconds`, not `Date.now()`.

- [ ] **Step 5: Extend scheduled dependency boundaries**

Add independent jobs:

```typescript
dailyChallengeExpiration(db, nowSeconds): Promise<void>;
dailyChallengeRetention(db, nowSeconds): Promise<void>;
```

Run each in its own `try/catch` in `runScheduledJobs`. Preserve ranked expiration, rate cleanup, and global retention order and behavior.

- [ ] **Step 6: Wire `worker.ts`**

Create the Daily Challenge repository/coordinator with:

```typescript
now: () => new Date(),
randomBytes(length) {
	return crypto.getRandomValues(new Uint8Array(length));
},
```

Wire expiration with the captured scheduled `nowSeconds`, then retention. Do not add a new Wrangler cron.

- [ ] **Step 7: Run and commit**

```bash
bun test \
	src/server/ranked/rate-limit.test.ts \
	src/server/daily-challenge/expiration.test.ts \
	src/server/cleanup.test.ts \
	src/worker.test.ts
git add \
	src/server/ranked/rate-limit.ts \
	src/server/ranked/rate-limit.test.ts \
	src/server/daily-challenge/expiration.ts \
	src/server/daily-challenge/expiration.test.ts \
	src/server/cleanup.ts \
	src/server/cleanup.test.ts \
	src/worker.ts
git commit -m "feat: schedule daily challenge maintenance (HPA-175)"
```

If `src/worker.test.ts` does not exist on the implementation base, omit that path and rely on `cleanup.test.ts` plus `bun run build`; do not create a low-value test solely for import wiring.

---

### Task 10: Extract Shared Blackjack Presentation Primitives

**Files:**

- Create: `src/lib/blackjack/presentation.ts`
- Create: `src/lib/blackjack/presentation.test.ts`
- Modify: `src/lib/ranked/blackjack/ui.ts`
- Modify: `src/lib/ranked/blackjack/ui.test.ts`

**Interfaces:**

- Produces: generic card, hand-value, dealer, and player-hand rendering.
- Preserves: ranked selectors, wallet display, receipt, stats, and achievement toast.

- [ ] **Step 1: Write failing generic presentation tests**

Use happy-dom and assert:

- red/black suit classes and accessible card names;
- Bust/Soft/hard hand values;
- hidden versus terminal dealer cards are already determined by projection;
- active player-hand styling;
- configurable test-ID prefix preserves ranked IDs.

- [ ] **Step 2: Run and observe failure**

```bash
bun test \
	src/lib/blackjack/presentation.test.ts \
	src/lib/ranked/blackjack/ui.test.ts
```

Expected: FAIL because shared presentation does not exist.

- [ ] **Step 3: Implement pure DOM helpers**

```typescript
export interface BlackjackPresentationOptions {
	readonly testIdPrefix: string;
	readonly formatWager: (value: number) => string;
}

export function formatBlackjackHandValue(value: HandValue): string {
	if (value.isBust) return `Bust ${value.value}`;
	if (value.isSoft) return `Soft ${value.value}`;
	return String(value.value);
}

export function createBlackjackCardElement(
	document: Document,
	card: Card,
	testId: string,
): HTMLElement {
	const element = document.createElement('div');
	element.dataset.testid = testId;
	element.className =
		'playing-card flex h-24 w-16 flex-col items-center justify-center rounded-lg bg-white text-xl font-bold shadow-lg';
	element.classList.add(isRedSuit(card.suit) ? 'text-red-700' : 'text-slate-900');
	element.setAttribute('aria-label', `${card.rank} of ${card.suit}`);
	element.textContent = `${card.rank}${getSuitSymbol(card.suit)}`;
	return element;
}
```

Add focused `renderBlackjackDealer()` and `renderBlackjackPlayerHands()` functions that receive containers and options.

- [ ] **Step 4: Refactor ranked UI only at the rendering seam**

Keep ranked-specific:

- account balance;
- countdown;
- start wager;
- receipt;
- statistics;
- achievements;
- ranked status wording.

Delegate only dealer/player/card/value rendering. Existing ranked test IDs must remain exact.

- [ ] **Step 5: Run compatibility tests and commit**

```bash
bun test \
	src/lib/blackjack/presentation.test.ts \
	src/lib/ranked/blackjack/ui.test.ts \
	src/lib/ranked/blackjack/client.test.ts
git add \
	src/lib/blackjack/presentation.ts \
	src/lib/blackjack/presentation.test.ts \
	src/lib/ranked/blackjack/ui.ts \
	src/lib/ranked/blackjack/ui.test.ts
git commit -m "refactor: share blackjack presentation primitives (HPA-175)"
```

---

### Task 11: Build Browser Payload Validation and Ranked Attempt Recovery

**Files:**

- Create: `src/lib/daily-challenge/payload.ts`
- Create: `src/lib/daily-challenge/payload.test.ts`
- Create: `src/lib/daily-challenge/client.ts`
- Create: `src/lib/daily-challenge/client.test.ts`

**Interfaces:**

- Validates every server success payload.
- Persists one logical start intent and active attempt safely across tabs.
- Handles request-ID substitution, uncertain writes, and `ATTEMPT_COMPLETE` recovery.

- [ ] **Step 1: Write strict payload tests**

Cover:

- missing/extra fields;
- malformed identifiers;
- negative/unsafe bankroll and sequences;
- nested adapter `nextSequence` rejection;
- live ranked seed rejection;
- pre-close reveal rejection;
- leaderboard rank/tie and history shape;
- terminal receipt/status/reason consistency;
- authenticated summary optionality.

- [ ] **Step 2: Implement payload parsers**

Use the shared protocol schemas, plus cross-field refinements:

```typescript
export function parseDailyChallengeAttemptResponse(
	value: unknown,
): DailyChallengeAttemptPublicStateV1 {
	const parsed = dailyChallengeAttemptPublicStateSchema.parse(value);
	if (parsed.status === 'active' && parsed.receipt !== null) {
		throw new TypeError('Active attempt cannot contain a receipt');
	}
	if (parsed.status !== 'active' && parsed.receipt === null) {
		throw new TypeError('Terminal attempt requires a receipt');
	}
	return parsed;
}
```

No Daily Challenge success response may expose a nested `activeRound.nextSequence`.

- [ ] **Step 3: Write failing client recovery tests**

Cover:

- fresh request ID per logical start intent;
- same request ID on uncertain start retry;
- returned stored `startRequestId` replaces the caller's losing ID;
- compare-and-remove storage behavior across tabs;
- uncertain command retries once then resumes;
- `ATTEMPT_COMPLETE` always resumes once and renders terminal receipt;
- definitive validation/409 errors do not retry;
- terminal acceptance clears active storage;
- period rollover does not reuse yesterday's request ID.

- [ ] **Step 4: Implement storage keys and transport**

```typescript
export function buildDailyChallengeStorageKeys(userId: string, periodKey: string) {
	return {
		startRequest: `arcturus:daily-challenge:start:${userId}:${periodKey}`,
		activeAttempt: `arcturus:daily-challenge:attempt:${userId}:${periodKey}`,
	};
}
```

Store:

```typescript
interface StoredDailyChallengeStartIntent {
	requestId: string;
	periodKey: string;
}

interface StoredDailyChallengeAttempt {
	attemptId: string;
	periodKey: string;
	startRequestId: string;
}
```

After start, persist the response's `attemptId` and persisted `startRequestId`, not the caller's assumed request ID.

- [ ] **Step 5: Implement command recovery**

```typescript
async function recoverTerminalAttempt(attemptId: string) {
	const resumed = await getAttempt(attemptId);
	acceptAttempt(resumed);
	return resumed;
}
```

For a command:

1. send once;
2. retry once only for uncertain failures;
3. resume on a second uncertain failure;
4. resume immediately on `409 ATTEMPT_COMPLETE`;
5. surface an error only if the recovery read fails or is not terminal when terminal was required.

- [ ] **Step 6: Run and commit**

```bash
bun test \
	src/lib/daily-challenge/payload.test.ts \
	src/lib/daily-challenge/client.test.ts
git add \
	src/lib/daily-challenge/payload.ts \
	src/lib/daily-challenge/payload.test.ts \
	src/lib/daily-challenge/client.ts \
	src/lib/daily-challenge/client.test.ts
git commit -m "feat: add daily challenge browser recovery client (HPA-175)"
```

---

### Task 12: Add Local Practice/Historical Replay and Daily Challenge UI

**Files:**

- Create: `src/lib/daily-challenge/ui.ts`
- Create: `src/lib/daily-challenge/ui.test.ts`
- Modify: `src/lib/daily-challenge/client.ts`
- Modify: `src/lib/daily-challenge/client.test.ts`

**Interfaces:**

- Lazy-loads pure replay only when a local mode begins.
- Renders current ranked/practice and historical replay without ranked wallet controls.
- Reuses shared Blackjack presentation.

- [ ] **Step 1: Write failing UI tests**

Cover:

- guest Practice available and Ranked sign-in CTA;
- authenticated one-attempt warning;
- available bankroll and committed wager shown separately;
- round progress;
- action button funding;
- forfeit confirmation;
- eligible and ineligible receipt states;
- rank/percentile/top results;
- history rows;
- shared-seed limitation notice;
- keyboard/focus and live-region state;
- no account balance, ranked stats, reward, or achievement elements.

- [ ] **Step 2: Define renderer/controller contract**

```typescript
export interface DailyChallengeRendererHandlers {
	onSelectMode(mode: 'practice' | 'ranked'): void | Promise<void>;
	onStartRanked(): void | Promise<void>;
	onStartRound(wager: number): void | Promise<void>;
	onAction(action: 'hit' | 'stand' | 'double-down' | 'split'): void | Promise<void>;
	onForfeit(): void | Promise<void>;
	onRestartPractice(): void | Promise<void>;
}

export interface DailyChallengeRenderer {
	bind(handlers: DailyChallengeRendererHandlers): void;
	renderChallenge(challenge: DailyChallengePublicResponse): void;
	renderAttempt(attempt: DailyChallengeAttemptPublicStateV1 | null): void;
	renderLeaderboard(leaderboard: DailyChallengeLeaderboardResponse): void;
	renderHistory(history: DailyChallengeHistoryResponse): void;
	renderLocalReplay(replay: DailyChallengeReplayV1 | null): void;
	setPending(pending: boolean): void;
	renderError(message: string): void;
}
```

- [ ] **Step 3: Implement lazy practice module loading**

Do not statically import `replay.ts` in the page bootstrap:

```typescript
async function loadReplayModule() {
	return await import('./replay');
}
```

The practice controller stores commands in memory, calls the pure replay after each command, and never invokes start/resume/command write APIs.

Historical mode selects:

- `practiceSeed` for Practice Scenario;
- `revealedRankedSeed` for Exact Ranked Replay.

Both are local and restartable.

- [ ] **Step 4: Implement UI with shared presentation**

Use `renderBlackjackDealer()` and `renderBlackjackPlayerHands()` with `daily-challenge-*` test IDs. Strip all ranked wallet/stat/reward semantics.

Show explicit text:

- “Practice uses a different scenario from today’s ranked attempt.”
- “Shared daily scenarios are not resistant to player-to-player spoilers.”
- “Ranked entry closes at 23:30 UTC.”

- [ ] **Step 5: Run and commit**

```bash
bun test \
	src/lib/daily-challenge/client.test.ts \
	src/lib/daily-challenge/ui.test.ts \
	src/lib/blackjack/presentation.test.ts
git add \
	src/lib/daily-challenge/client.ts \
	src/lib/daily-challenge/client.test.ts \
	src/lib/daily-challenge/ui.ts \
	src/lib/daily-challenge/ui.test.ts
git commit -m "feat: add daily challenge practice and UI controller (HPA-175)"
```

---

### Task 13: Add Current and Historical Daily Challenge Pages

**Files:**

- Create: `src/pages/games/daily-challenge.astro`
- Create: `src/pages/games/daily-challenge/[periodKey].astro`
- Modify: `src/pages/games/index.astro`
- Modify: `src/pages/games/blackjack.astro`
- Create: `integration/daily-challenge-pages.test.ts`

**Interfaces:**

- Produces: public current page with personalized ranked state when authenticated.
- Produces: public closed-day verification/replay page.
- Adds discovery without changing Casual or ordinary Ranked Blackjack.

- [ ] **Step 1: Create the current-page shell**

The route remains public. Embed `data-user-id` only when authenticated and set:

- guest HTML: `public, max-age=0, s-maxage=60, stale-while-revalidate=300`, `Vary: Cookie`;
- authenticated HTML: `private, no-store`.

The shell includes:

- date/reset/cutoff;
- mode tabs;
- sign-in CTA;
- one-attempt warning;
- bankroll/round HUD;
- dealer/player containers;
- wager/actions/forfeit;
- result panel;
- top-results table;
- seven-day history;
- `<noscript>` explanation.

- [ ] **Step 2: Bootstrap the browser client**

```astro
<script>
	import { initDailyChallengePage } from '../../lib/daily-challenge/client';

	const root = document.querySelector<HTMLElement>('#daily-challenge-root');
	if (root) void initDailyChallengePage(root);
</script>
```

Initialization fetches `/api/daily-challenges/current`, then resolves the date-scoped leaderboard using the returned `periodKey`. Do not send `current` through the `[periodKey]` endpoint.

- [ ] **Step 3: Create the historical page**

Validate the route parameter before rendering. The client fetches `/api/daily-challenges/:periodKey`; closed detail must include `revealedRankedSeed`.

Show:

- commitment verification status;
- Practice Scenario button;
- Exact Ranked Replay button;
- closed leaderboard;
- no ranked write controls.

Live dates reached through the historical route show metadata but disable Exact Ranked Replay until reveal.

- [ ] **Step 4: Add discovery links**

- Add a Daily Challenge card/link in `/games`.
- Add a compact “Try today’s Daily Challenge” link on Casual Blackjack.
- Do not change `/games/blackjack/ranked` or its active-session rules.

- [ ] **Step 5: Add route/component integration checks**

Use Vitest/Astro Container only where SSR header/session behavior cannot be tested as a pure function. Place tests under `integration/`, never `src/pages`.

Cover guest/auth page cache headers and invalid historical period handling.

- [ ] **Step 6: Run and commit**

```bash
bun run format:check
bun run lint
bun run test:integration
bun run build
git add \
	src/pages/games/daily-challenge.astro \
	src/pages/games/daily-challenge \
	src/pages/games/index.astro \
	src/pages/games/blackjack.astro \
	integration/daily-challenge-pages.test.ts
git commit -m "feat: add daily challenge pages (HPA-175)"
```

---

### Task 14: Add End-to-End Coverage and Complete Verification

**Files:**

- Create: `e2e/daily-challenge.spec.ts`
- Modify production selectors only when required by the approved flows
- Update the implementation PR description with bundle and verification evidence

**Interfaces:**

- Produces: focused real-API and intercepted-boundary browser coverage.
- Proves: guest practice, one ranked attempt, recovery, ranking UI, and historical replay.

- [ ] **Step 1: Use isolated authenticated users**

Follow `e2e/isolated-page.ts` so one-attempt state cannot leak between tests. Do not add a production reset endpoint.

- [ ] **Step 2: Test guest practice and sign-in behavior**

- Open `/games/daily-challenge` as guest.
- Verify Practice starts without a write request.
- Complete/restart at least one local round.
- Select Ranked and verify the sign-in CTA.
- Assert no `/attempts` or `/commands` request occurred during Practice.

- [ ] **Step 3: Test a real authenticated ranked attempt**

With an isolated user:

1. start the attempt;
2. wager 10 each round;
3. stand whenever legal;
4. handle natural terminal openings without assuming an action button;
5. refresh mid-attempt and verify the same `attemptId`, bankroll, round, and committed wager;
6. complete or reach below-minimum;
7. verify receipt, score, rank/percentile, and leaderboard appearance;
8. attempt a second start and verify the consumed attempt is returned rather than reset.

- [ ] **Step 4: Test uncertain and terminal recovery**

Intercept one command response after forwarding it to the server, then abort/drop the browser response. Verify the client retries/resumes and renders one authoritative state.

Intercept an expiry-style `ATTEMPT_COMPLETE` fixture followed by a terminal resume fixture. Verify no red gameplay error is shown and the receipt renders.

Keep actual clock boundary behavior in coordinator/HTTP tests; do not add a test-only production clock endpoint.

- [ ] **Step 5: Test historical reveal UI with intercepted public fixtures**

- Pre-close detail has commitment but no ranked seed and Exact Ranked Replay disabled.
- Closed detail reveals seed, verifies commitment, and enables both local replay modes.
- Live leaderboard may be empty and shows no “playing now” presence.
- Tied rows display shared rank.

- [ ] **Step 6: Measure lazy-loaded replay bundle**

Build and locate the chunk containing the v1 round-domain string:

```bash
bun run build
grep -R -l "arcturus:blackjack-daily-v1:round:" dist/_astro | xargs wc -c
```

Record raw bytes and, when the build output supports it, compressed bytes in the PR description. Verify the current page's initial module does not contain the replay domain string before the dynamic import chunk.

- [ ] **Step 7: Run focused verification**

```bash
bun test \
	src/lib/ranked/blackjack \
	src/lib/daily-challenge \
	src/server/daily-challenge \
	src/server/ranked/rate-limit.test.ts \
	src/server/cleanup.test.ts
bunx playwright test e2e/daily-challenge.spec.ts
```

Expected: PASS.

- [ ] **Step 8: Run full project verification**

```bash
bun run format:check
bun run lint
bun run test
bun run build
bun run test:e2e
```

Expected: all commands exit 0, with only already-documented intentional Playwright skips.

- [ ] **Step 9: Review scope**

```bash
git diff --stat main...HEAD
git diff --name-only main...HEAD
```

Confirm:

- no account-wallet or held-chip mutations;
- no ranked stats/achievement/reward writes;
- no second cron;
- no HPA-177 league/reward implementation;
- no production test-reset or clock-bypass endpoint;
- only the generated Daily Challenge migration is added.

- [ ] **Step 10: Commit final E2E changes**

```bash
git add e2e/daily-challenge.spec.ts
git status --short
```

If E2E work required selector changes, review `git status --short` and add each exact production file path separately. Never stage the entire `src/` tree.

```bash
git commit -m "test: cover daily challenge flows (HPA-175)"
```

Do not create an empty commit if verification required no final source changes.

---

## Plan Completion Checklist

- [ ] Every approved design requirement maps to a task above.
- [ ] Daily Challenge remains a sibling coordinator and never enters the ranked wallet coordinator.
- [ ] Ranked adapter responses remain byte-compatible after projection extraction.
- [ ] V1 seed domains and uint64 encoding are selected from persisted ruleset version.
- [ ] Pure replay is deterministic and receives no database, time, account, or identity input.
- [ ] `nextCommandSequence` is the only public command counter.
- [ ] Static and dynamic wager failures have distinct tested error codes.
- [ ] Terminal precedence and status/reason mapping are explicit and tested.
- [ ] Start substitution echoes persisted `startRequestId`.
- [ ] `ATTEMPT_COMPLETE` command recovery resumes and renders the immutable receipt.
- [ ] One attempt is consumed at row creation under concurrent starts.
- [ ] Result insertion and terminal status update are atomic and exactly once.
- [ ] Eligible ties share competition rank and percentile.
- [ ] Public reads use exact cache headers and never cache personalized data.
- [ ] Guest reads rely on bounded/cacheable queries rather than fake user-keyed rate limits.
- [ ] Expiration and retention run through the existing hourly scheduled pipeline.
- [ ] Terminal attempts are retained for 90 days; compact results survive reaping.
- [ ] Practice and historical replay are local, restartable, and write-free.
- [ ] Shared-seed spoiler/collusion limitations remain visible and are not overstated.
- [ ] The replay engine is lazy-loaded and its chunk size is recorded.
- [ ] Full format, lint, unit, integration, build, and E2E verification runs before completion is claimed.
