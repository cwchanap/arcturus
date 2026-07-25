# Server-Verifiable Ranked Single-Player Results Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an authenticated, server-authoritative Ranked Blackjack round whose hidden randomness, sequenced actions, wallet settlement, ranked statistics, achievement, and one-time reward are deterministic, durable, and idempotent while Casual Blackjack remains unchanged.

**Architecture:** Thin Astro handlers call a Cloudflare-runtime-neutral ranked coordinator. The coordinator resolves a versioned pure Blackjack adapter, rebuilds state from a server-only seed and canonical action log, and delegates all D1 compare-and-swap batches to a focused repository. A shared multiplayer membership reconciler protects the ranked/escrow exclusion in both directions; the existing Worker cron invokes the same expiration finalizer used by lazy requests.

**Tech Stack:** Astro 5 SSR, Cloudflare Workers and D1, Drizzle ORM/Kit, Zod 4, Web Crypto seed generation, `@noble/hashes` 2.2 synchronous SHA-256/HMAC, Bun test, Miniflare/workerd D1 integration tests, Playwright.

## Global Constraints

- Runtime is Cloudflare Workers; production modules must not use Node-only APIs or `process.env`.
- Ranked v1 supports only `gameType: 'blackjack'` with `rulesetVersion: 'blackjack-ranked-v1'`.
- Ranked sessions are authenticated-only; `/games/blackjack` remains guest-safe and client-authoritative.
- Ranked APIs accept only a start configuration or one sequenced action; they never accept cards, scores, payouts, chip deltas, timestamps, or final state.
- All hashed JSON uses the restricted RFC 8785 JCS implementation in `src/lib/ranked/canonical.ts`; numeric inputs are finite JavaScript safe integers and negative zero is invalid.
- A session seed is exactly 32 bytes, stored as canonical unpadded base64url, never logged or returned, and identified publicly only by its audit-only SHA-256 commitment.
- `expiresAt` is fixed at opening deal plus exactly 15 minutes and is never extended.
- At most one active ranked session exists per user; ranked play and multiplayer membership/escrow are mutually exclusive.
- Every ranked wallet mutation requires `heldChips = 0`.
- Ranked statistics remain separate from existing casual `game_stats`.
- The one-time `ranked_debut_100` grant is reserved by a strict unique insert before its 100-chip credit.
- Receipt construction pre-reads `chipBalance`, computes `balanceAfter` and `receiptHash`, and proves that snapshot with an exact-balance no-op D1 update before any terminal effect.
- D1 batches use explicit `WHERE changes() = 1` cascades and every mandatory `meta.changes` count is inspected.
- Existing `/api/chips/update` and casual Blackjack settlement behavior must not change.
- Schema changes run `bun run db:generate -- --name=ranked_sessions`; migration scripts already discover numbered SQL files automatically.
- Pin `@noble/hashes` to `^2.2.0`; use its synchronous ESM subpath imports so rejection sampling can refill without an asynchronous `nextInt()` contract.
- Source uses tabs, single quotes, semicolons, and no unredacted user/session identifiers in ranked logs.

---

## File Structure

### Generic ranked domain

- Create `src/lib/ranked/canonical.ts` — restricted JCS serialization, SHA-256 hashing, canonical base64url helpers.
- Create `src/lib/ranked/canonical.test.ts` — canonical byte, validation, hash, and identifier fixtures.
- Create `src/lib/ranked/random.ts` — HMAC-SHA-256 counter stream, unbiased `nextInt`, seed generation/commitment.
- Create `src/lib/ranked/random.test.ts` — fixed HMAC, rejection-sampling, shuffle, and seed-codec fixtures.
- Create `src/lib/ranked/random.worker.integration.test.ts` — execute the bundled random module in Miniflare/workerd and compare the same fixed fixtures.
- Create `src/lib/ranked/protocol.ts` — strict request schemas, public response/receipt types, stable error codes.
- Create `src/lib/ranked/protocol.test.ts` — unknown-field, unsafe-number, identifier, and action-log validation.
- Create `src/lib/ranked/registry.ts` — generic adapter interface and exact `(gameType, rulesetVersion)` lookup.
- Create `src/lib/ranked/registry.test.ts` — supported and unsupported adapter resolution.
- Modify `package.json` — add `@noble/hashes` as the Worker-compatible synchronous hash dependency.
- Modify `bun.lock` — lock the selected package version.

### Ranked Blackjack

- Create `src/lib/ranked/blackjack/types.ts` — immutable v1 configuration, internal state, public state, legal action, outcome types.
- Create `src/lib/ranked/blackjack/engine.ts` — pure deterministic initial deal, replay reducer, rules, dealer transition, and settlement.
- Create `src/lib/ranked/blackjack/engine.test.ts` — natural, hit, stand, double, split, re-split, payout, dealer, and terminal fixtures.
- Create `src/lib/ranked/blackjack/adapter.ts` — v1 issued configuration, deterministic deck construction, replay, public projection, and terminal effects.
- Create `src/lib/ranked/blackjack/adapter.test.ts` — config identity, projection secrecy, balance-constrained actions, and byte-equivalent replay.

### Persistence and server coordination

- Modify `src/db/schema.ts` — export the five ranked tables and indexes.
- Create `drizzle/0011_ranked_sessions.sql` — generated D1 schema migration.
- Create `src/server/ranked/test-d1.ts` — Miniflare D1 setup that applies every numbered SQL migration.
- Create `src/server/ranked/schema.integration.test.ts` — real-schema constraints, indexes, and nullable active-user uniqueness.
- Create `src/server/ranked/logging.ts` — redacted identifiers and ranked event names.
- Create `src/server/ranked/rate-limit.ts` — fixed-window limits, conditional upsert statement, retry metadata.
- Create `src/server/ranked/repository.ts` — typed reads and safety-critical start/action/terminal/expiry SQL builders.
- Create `src/server/ranked/repository.integration.test.ts` — real D1 cascade, rollback, idempotency, and concurrency proof.
- Create `src/server/ranked/coordinator.ts` — start, resume, act, settle, and lazy-expiration orchestration.
- Create `src/server/ranked/coordinator.test.ts` — protocol classification, replay semantics, adapter dispatch, and error mapping.
- Create `src/server/ranked/http.ts` — injectable Astro request handlers and structured JSON responses.
- Create `src/server/ranked/http.test.ts` — authentication, strict parsing, ownership, status, and response headers.
- Create `src/server/ranked/expiration.ts` — bounded ordered expiration and rate-bucket cleanup jobs.
- Create `src/server/ranked/expiration.test.ts` — oldest-100 selection, poison-row isolation, and cleanup independence.
- Create `src/pages/api/ranked/sessions/index.ts` — `POST` start route.
- Create `src/pages/api/ranked/sessions/[sessionId]/index.ts` — `GET` resume route.
- Create `src/pages/api/ranked/sessions/[sessionId]/actions.ts` — `POST` action route.
- Modify `src/server/cleanup.ts` — expose the existing retention job as one independently guarded scheduled operation.
- Modify `src/server/cleanup.test.ts` — preserve existing cleanup behavior under the new job composition.
- Modify `src/worker.ts` — run ranked expiration, ranked rate cleanup, and retention cleanup in independent error boundaries.

### Multiplayer exclusion and achievements

- Create `src/server/mp/membership.ts` — shared recent/live/unknown/gone membership reconciliation and scoped escrow repair.
- Create `src/server/mp/membership.test.ts` — real D1 and mocked Durable Object probe coverage.
- Modify `src/pages/api/mp/rooms/index.ts` — call the shared reconciler and reject active ranked sessions before room creation.
- Modify `src/pages/api/mp/lock.ts` — call the same reconciler and reject active ranked sessions before acquisition.
- Modify `src/server/mp/lock.test.ts` — lock-route same-room, stale-room, and ranked-conflict coverage.
- Create `src/server/mp/rooms-api.test.ts` — room-create reconciliation, repair order, and ranked-conflict coverage.
- Modify `src/lib/achievements/types.ts` — add `ranked_debut` and required `grantSource`.
- Modify `src/lib/achievements/achievement-rules.ts` — add the catalog entry and evaluated-only list.
- Modify `src/lib/achievements/achievements.ts` — default generic evaluation to evaluated-only definitions.
- Modify `src/lib/achievements/achievement-rules.test.ts` — catalog and source exhaustiveness.
- Modify `src/lib/achievements/achievements.test.ts` — prove casual evaluation cannot grant Ranked Debut.

### Browser experience

- Create `src/lib/ranked/blackjack/client.ts` — persisted start/session recovery, serialized actions, retry-once-then-resume behavior.
- Create `src/lib/ranked/blackjack/client.test.ts` — request persistence, uncertain response, reload, and terminal cleanup.
- Create `src/lib/ranked/blackjack/ui.ts` — render only server public state, countdown, controls, receipt, and catalog-backed achievement toast.
- Create `src/lib/ranked/blackjack/ui.test.ts` — hidden hole card, pending controls, action availability, balance, and receipt rendering.
- Create `src/pages/games/blackjack/ranked.astro` — authenticated Ranked Blackjack page and stable test IDs.
- Modify `src/pages/games/blackjack.astro` — explicit Casual label plus ranked/sign-in link only.
- Create `e2e/ranked-blackjack.spec.ts` — authenticated ranked flow, recovery, retry, secrecy, and cross-tab balance refresh.
- Modify `e2e/public-single-player-games.spec.ts` — guest Casual Blackjack independence and sign-in-safe ranked prompt.
- Modify `e2e/authed-user-preservation.spec.ts` — authenticated Casual Blackjack label/link and independent settlement.

---

### Task 1: Add the Ranked Persistence Schema

**Files:**

- Modify: `src/db/schema.ts`
- Create: `drizzle/0011_ranked_sessions.sql`
- Create: `src/server/ranked/test-d1.ts`
- Create: `src/server/ranked/schema.integration.test.ts`

**Interfaces:**

- Produces: Drizzle exports `rankedSession`, `rankedResult`, `rankedGameStats`, `rankedRewardGrant`, and `rankedRateLimit`.
- Produces: `createRankedTestD1(): Promise<{ mf: Miniflare; db: D1Database }>` and `insertRankedTestUser(db, overrides)`.
- Consumes: existing `user` and `userAchievement` schema keys.

- [ ] **Step 1: Create the reusable real-D1 test harness**

Use the existing dynamic migration convention rather than maintaining a second migration list:

```ts
const migrationFiles = readdirSync(join(process.cwd(), 'drizzle'))
	.filter((file) => /^\d+_[a-z0-9_-]+\.sql$/i.test(file))
	.sort();

export async function createRankedTestD1() {
	const mf = new Miniflare({
		modules: [
			{
				type: 'ESModule',
				path: 'file:///entry.js',
				contents: 'export default { fetch() { return new Response("ok"); } }',
			},
		],
		d1Databases: { DB: `ranked-${crypto.randomUUID()}` },
		d1Persist: false,
	});
	await mf.ready;
	const db = await mf.getD1Database('DB');
	for (const file of migrationFiles) {
		const sql = readFileSync(join(process.cwd(), 'drizzle', file), 'utf8');
		const statements = sql
			.split('--> statement-breakpoint')
			.map((statement) => statement.trim())
			.filter(Boolean);
		await db.batch(statements.map((statement) => db.prepare(statement)));
	}
	return { mf, db };
}
```

- [ ] **Step 2: Write schema tests that fail before the migration exists**

Assert all five tables exist, `(userId, startRequestId)` is unique, only one non-null `activeUserId` is permitted, two terminal rows with `activeUserId = NULL` are permitted, and `(userId, operation, windowStart)` is the rate-limit primary key.

```ts
test('allows sequential terminal sessions but only one active session per user', async () => {
	await insertRankedTestUser(db, { id: 'schema-user' });
	await insertSession(db, {
		id: 's1',
		activeUserId: 'schema-user',
		startRequestId: 'request-00000001',
	});
	await expect(
		insertSession(db, {
			id: 's2',
			activeUserId: 'schema-user',
			startRequestId: 'request-00000002',
		}),
	).rejects.toThrow(/UNIQUE constraint failed/);
	await db
		.prepare('UPDATE ranked_session SET activeUserId = NULL, status = ? WHERE id = ?')
		.bind('settled', 's1')
		.run();
	await insertSession(db, {
		id: 's2',
		activeUserId: 'schema-user',
		startRequestId: 'request-00000002',
	});
	await db
		.prepare('UPDATE ranked_session SET activeUserId = NULL, status = ? WHERE id = ?')
		.bind('settled', 's2')
		.run();
	expect(await countRows(db, 'ranked_session')).toBe(2);
});
```

Define `insertSession(db, values)` and `countRows(db, table)` as local test helpers in `schema.integration.test.ts`; both execute raw D1 statements against the generated schema, while shared user/migration setup remains in `test-d1.ts`.

```ts
async function insertSession(
	db: D1Database,
	values: { id: string; activeUserId: string | null; startRequestId: string },
) {
	const now = Math.trunc(Date.now() / 1000);
	return db
		.prepare(
			`INSERT INTO ranked_session (
				id, userId, startRequestId, startPayloadHash, activeUserId,
				gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
				actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
				status, expiresAt, createdAt, updatedAt
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			values.id,
			'schema-user',
			values.startRequestId,
			'start-hash',
			values.activeUserId,
			'blackjack',
			'blackjack-ranked-v1',
			'{}',
			'config-hash',
			'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
			'seed-commitment',
			'[]',
			'action-log-hash',
			0,
			10,
			10,
			values.activeUserId === null ? 'settled' : 'active',
			now + 900,
			now,
			now,
		)
		.run();
}

async function countRows(db: D1Database, table: 'ranked_session'): Promise<number> {
	const row = await db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{ count: number }>();
	return row?.count ?? 0;
}
```

- [ ] **Step 3: Run the schema test and verify the intended failure**

Run: `bun test src/server/ranked/schema.integration.test.ts`

Expected: FAIL because `ranked_session` and the other ranked tables do not exist.

- [ ] **Step 4: Define the five Drizzle tables**

Use integer timestamp columns in the repository's existing Unix-seconds convention. Add `uniqueIndex` to the SQLite imports. The `seed` field must carry the source comment shown below.

```ts
export const rankedSession = sqliteTable(
	'ranked_session',
	{
		id: text('id').primaryKey(),
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		startRequestId: text('startRequestId').notNull(),
		startPayloadHash: text('startPayloadHash').notNull(),
		activeUserId: text('activeUserId').references(() => user.id, { onDelete: 'cascade' }),
		gameType: text('gameType').notNull(),
		rulesetVersion: text('rulesetVersion').notNull(),
		configJson: text('configJson').notNull(),
		configHash: text('configHash').notNull(),
		// Server-only sensitive replay material. Never expose through public APIs or logs.
		seed: text('seed').notNull(),
		seedCommitment: text('seedCommitment').notNull(),
		actionLogJson: text('actionLogJson').notNull(),
		actionLogHash: text('actionLogHash').notNull(),
		nextSequence: integer('nextSequence').notNull().default(0),
		initialWager: integer('initialWager').notNull(),
		committedWager: integer('committedWager').notNull(),
		status: text('status').notNull(),
		expiresAt: integer('expiresAt', { mode: 'timestamp' }).notNull(),
		createdAt: integer('createdAt', { mode: 'timestamp' }).notNull(),
		updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
		settledAt: integer('settledAt', { mode: 'timestamp' }),
	},
	(table) => ({
		startRequestUnique: uniqueIndex('ranked_session_user_start_request_idx').on(
			table.userId,
			table.startRequestId,
		),
		activeUserUnique: uniqueIndex('ranked_session_active_user_idx').on(table.activeUserId),
		expiryIdx: index('ranked_session_status_expiry_idx').on(table.status, table.expiresAt),
		userCreatedIdx: index('ranked_session_user_created_idx').on(table.userId, table.createdAt),
	}),
);
```

Define the remaining tables with these exact columns and keys:

```ts
export const rankedResult = sqliteTable('ranked_result', {
	sessionId: text('sessionId')
		.primaryKey()
		.references(() => rankedSession.id, { onDelete: 'cascade' }),
	userId: text('userId')
		.notNull()
		.references(() => user.id, { onDelete: 'cascade' }),
	gameType: text('gameType').notNull(),
	rulesetVersion: text('rulesetVersion').notNull(),
	seedCommitment: text('seedCommitment').notNull(),
	configHash: text('configHash').notNull(),
	actionLogHash: text('actionLogHash').notNull(),
	outcomeJson: text('outcomeJson').notNull(),
	initialWager: integer('initialWager').notNull(),
	committedWager: integer('committedWager').notNull(),
	payout: integer('payout').notNull(),
	gameNetDelta: integer('gameNetDelta').notNull(),
	rewardDelta: integer('rewardDelta').notNull(),
	balanceAfter: integer('balanceAfter').notNull(),
	statsEffectsJson: text('statsEffectsJson').notNull(),
	achievementEffectsJson: text('achievementEffectsJson').notNull(),
	rewardEffectsJson: text('rewardEffectsJson').notNull(),
	receiptHash: text('receiptHash').notNull(),
	settledAt: integer('settledAt', { mode: 'timestamp' }).notNull(),
});

export const rankedGameStats = sqliteTable(
	'ranked_game_stats',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		gameType: text('gameType').notNull(),
		sessionsPlayed: integer('sessionsPlayed').notNull().default(0),
		totalWins: integer('totalWins').notNull().default(0),
		totalLosses: integer('totalLosses').notNull().default(0),
		totalPushes: integer('totalPushes').notNull().default(0),
		totalForfeits: integer('totalForfeits').notNull().default(0),
		netProfit: integer('netProfit').notNull().default(0),
		biggestWin: integer('biggestWin').notNull().default(0),
		updatedAt: integer('updatedAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({ pk: primaryKey({ columns: [table.userId, table.gameType] }) }),
);

export const rankedRewardGrant = sqliteTable(
	'ranked_reward_grant',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		rewardId: text('rewardId').notNull(),
		sourceSessionId: text('sourceSessionId')
			.notNull()
			.references(() => rankedSession.id, { onDelete: 'cascade' }),
		achievementId: text('achievementId').notNull(),
		chipAmount: integer('chipAmount').notNull(),
		grantedAt: integer('grantedAt', { mode: 'timestamp' }).notNull(),
	},
	(table) => ({ pk: primaryKey({ columns: [table.userId, table.rewardId] }) }),
);

export const rankedRateLimit = sqliteTable(
	'ranked_rate_limit',
	{
		userId: text('userId')
			.notNull()
			.references(() => user.id, { onDelete: 'cascade' }),
		operation: text('operation').notNull(),
		windowStart: integer('windowStart').notNull(),
		count: integer('count').notNull(),
		expiresAt: integer('expiresAt').notNull(),
	},
	(table) => ({
		pk: primaryKey({ columns: [table.userId, table.operation, table.windowStart] }),
		expiryIdx: index('ranked_rate_limit_expiry_idx').on(table.expiresAt),
	}),
);
```

- [ ] **Step 5: Generate and inspect the named migration**

Run: `bun run db:generate -- --name=ranked_sessions`

Expected: creates `drizzle/0011_ranked_sessions.sql`.

Inspect the SQL and confirm it contains all five tables, both ranked-session unique indexes, the status/expiry index, and the two composite primary keys. Do not hand-edit generated SQL unless Drizzle omits a design constraint; if an edit is necessary, add a matching schema integration assertion.

- [ ] **Step 6: Run the schema tests**

Run: `bun test src/server/ranked/schema.integration.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.ts drizzle/0011_ranked_sessions.sql src/server/ranked/test-d1.ts src/server/ranked/schema.integration.test.ts
git commit -m "feat: add ranked session persistence schema"
```

---

### Task 2: Make Achievement Grant Sources Explicit

**Files:**

- Modify: `src/lib/achievements/types.ts`
- Modify: `src/lib/achievements/achievement-rules.ts`
- Modify: `src/lib/achievements/achievements.ts`
- Modify: `src/lib/achievements/achievement-rules.test.ts`
- Modify: `src/lib/achievements/achievements.test.ts`

**Interfaces:**

- Produces: `AchievementGrantSource = 'evaluated' | 'ranked-terminal'`.
- Produces: `EVALUATED_ACHIEVEMENTS: AchievementDefinition[]`.
- Produces: catalog definition for `ranked_debut`.
- Preserves: `getAchievementsWithStatus()` continues to return every catalog definition.

- [ ] **Step 1: Write failing catalog and evaluator-isolation tests**

```ts
test('ranked debut is catalog-visible and terminal-only', () => {
	expect(getAchievementById('ranked_debut')).toEqual({
		id: 'ranked_debut',
		name: 'Ranked Debut',
		description: 'Complete your first ranked game.',
		category: 'milestone',
		icon: '🎖️',
		grantSource: 'ranked-terminal',
	});
	expect(EVALUATED_ACHIEVEMENTS.every((item) => item.grantSource === 'evaluated')).toBe(true);
});

test('generic evaluation never attempts to grant ranked debut', async () => {
	const grantAchievement = mock(async () => true);
	const service = createAchievementService({ grantAchievement });
	await service.checkAndGrantAchievements(db, 'user-1', 1000);
	expect(grantAchievement.mock.calls.some((call) => call[2] === 'ranked_debut')).toBe(false);
});
```

- [ ] **Step 2: Run the focused achievement tests**

Run: `bun test src/lib/achievements/achievement-rules.test.ts src/lib/achievements/achievements.test.ts`

Expected: FAIL because `ranked_debut`, `grantSource`, and `EVALUATED_ACHIEVEMENTS` do not exist.

- [ ] **Step 3: Add the required source discriminator**

```ts
export type AchievementGrantSource = 'evaluated' | 'ranked-terminal';

export const ACHIEVEMENT_IDS = [
	'rising_star',
	'high_roller',
	'champion',
	'consistent',
	'comeback',
	'ranked_debut',
] as const;

export interface AchievementDefinition {
	id: AchievementId;
	name: string;
	description: string;
	category: AchievementCategory;
	icon: string;
	grantSource: AchievementGrantSource;
}
```

Add `grantSource: 'evaluated'` to every existing definition and the exact Ranked Debut definition from Step 1. Change `ACHIEVEMENT_CHECKS` and the injected dependency type to `Partial<Record<AchievementId, AchievementCheckFn>>`; terminal-only achievements intentionally have no generic check function.

- [ ] **Step 4: Filter the generic evaluation default without filtering display APIs**

```ts
export const EVALUATED_ACHIEVEMENTS = ACHIEVEMENTS.filter(
	(achievement) => achievement.grantSource === 'evaluated',
);
```

Set the default `achievementsList` in `checkAndGrantAchievements` to `EVALUATED_ACHIEVEMENTS`. Keep `getAchievementsWithStatus` mapped over the full `ACHIEVEMENTS` catalog so the profile renders Ranked Debut.

- [ ] **Step 5: Run achievement and API regression tests**

Run: `bun test src/lib/achievements src/lib/chips-update-api.test.ts src/lib/roulette/spin-api.test.ts`

Expected: PASS, including proof that existing casual paths still evaluate the original five achievements.

- [ ] **Step 6: Commit**

```bash
git add src/lib/achievements
git commit -m "feat: distinguish terminal ranked achievements"
```

---

### Task 3: Implement Canonical Protocol and Ranked Randomness

**Files:**

- Create: `src/lib/ranked/canonical.ts`
- Create: `src/lib/ranked/canonical.test.ts`
- Create: `src/lib/ranked/random.ts`
- Create: `src/lib/ranked/random.test.ts`
- Create: `src/lib/ranked/random.worker.integration.test.ts`
- Create: `src/lib/ranked/protocol.ts`
- Create: `src/lib/ranked/protocol.test.ts`
- Modify: `package.json`
- Modify: `bun.lock`

**Interfaces:**

- Produces: `canonicalizeRanked(value: RankedJson): string`.
- Produces: `sha256Hex(bytes: Uint8Array | string): string`.
- Produces: `encodeBase64Url`, `decodeCanonicalBase64Url`, and `hashCanonical`.
- Produces: `createRankedRandomSource(seed): RankedRandomSource` and `shuffleRankedDeck`.
- Produces: `deriveRankedCounterBlock(seed, counter): Uint8Array` for pinned audit fixtures.
- Produces: strict `startRequestSchema`, `actionRequestSchema`, `actionLogSchema`, identifier schemas, receipt/public-state types, and `RankedServiceError`.

- [ ] **Step 1: Write fixed canonicalization and crypto fixtures**

```ts
test('canonicalizes the restricted JCS value byte-for-byte', () => {
	expect(canonicalizeRanked({ z: 0, a: [3, { x: 'é', b: true }] })).toBe(
		'{"a":[3,{"b":true,"x":"é"}],"z":0}',
	);
});

test('pins the v1 HMAC block and seed commitment', async () => {
	const seed = Uint8Array.from({ length: 32 }, (_, index) => index);
	expect(bytesToHex(deriveRankedCounterBlock(seed, 0n))).toBe(
		'26703278906b275d44e68bcccc9563a062c2364c71cd76679fe6d1a3afc86ac3',
	);
	expect(createSeedCommitment(seed)).toBe(
		'53b7d7e3c3cccc4d50c84318061deca625f712619eab99f8dd1c0b66c7d9ef7e',
	);
});
```

Also assert rejection of `NaN`, infinity, unsafe integers, negative zero, `undefined`, sparse arrays, malformed/non-canonical base64url, a seed not exactly 32 bytes, unknown request fields, short/oversized identifiers, fractional sequences, and non-kebab-case actions.

- [ ] **Step 2: Run the focused tests**

Run: `bun test src/lib/ranked/canonical.test.ts src/lib/ranked/random.test.ts src/lib/ranked/protocol.test.ts`

Expected: FAIL because the modules do not exist.

- [ ] **Step 3: Implement restricted JCS and hashing**

The serializer handles only validated JSON primitives, arrays, and plain objects. It sorts object keys lexicographically and uses `JSON.stringify` for strings and the safe-integer number subset.

```ts
export function canonicalizeRanked(value: RankedJson): string {
	if (value === null || typeof value === 'boolean' || typeof value === 'string') {
		return JSON.stringify(value);
	}
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value) || Object.is(value, -0)) throw new CanonicalizationError();
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (Object.keys(value).length !== value.length) throw new CanonicalizationError();
		return `[${value.map(canonicalizeRanked).join(',')}]`;
	}
	if (Object.getPrototypeOf(value) !== Object.prototype) throw new CanonicalizationError();
	return `{${Object.keys(value)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalizeRanked(value[key])}`)
		.join(',')}}`;
}
```

Install the audited synchronous hashing package before implementing the hash helpers:

```bash
bun add @noble/hashes@^2.2.0
```

Use its ESM subpath imports and `TextEncoder`; implement base64url without Node `Buffer`.

```ts
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes } from '@noble/hashes/utils.js';
```

- [ ] **Step 4: Implement the immutable v1 HMAC counter stream**

```ts
export interface RankedRandomSource {
	nextInt(exclusiveUpperBound: number): number;
}

const DECK_DOMAIN = new TextEncoder().encode('arcturus:blackjack-ranked-v1:deck');

export function deriveRankedCounterBlock(seed: Uint8Array, counter: bigint): Uint8Array {
	assertSeed(seed);
	return hmac(sha256, seed, concatBytes(DECK_DOMAIN, encodeUint64BigEndian(counter)));
}

export function createRankedRandomSource(seed: Uint8Array): RankedRandomSource {
	assertSeed(seed);
	let counter = 0n;
	let block = new Uint8Array();
	let offset = 0;
	const nextUint32 = () => {
		if (offset + 4 > block.length) {
			block = deriveRankedCounterBlock(seed, counter);
			counter += 1n;
			offset = 0;
		}
		const value = readUint32BigEndian(block, offset);
		offset += 4;
		return value;
	};
	return {
		nextInt(exclusiveUpperBound) {
			assertUpperBound(exclusiveUpperBound);
			const limit = Math.floor(0x1_0000_0000 / exclusiveUpperBound) * exclusiveUpperBound;
			for (;;) {
				const value = nextUint32();
				if (value < limit) return value % exclusiveUpperBound;
			}
		},
	};
}
```

`encodeUint64BigEndian` rejects counter overflow. `shuffleRankedDeck` creates the exact suit/rank order from the design and deals from the array end. Seed creation still uses `crypto.getRandomValues`, while SHA-256, HMAC, and commitments use the same synchronous noble implementation in Bun and workerd.

- [ ] **Step 5: Define strict protocol schemas and stable errors**

```ts
export const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);
export const sessionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
export const rankedActionSchema = z.enum(['hit', 'stand', 'double-down', 'split']);
export const safeIntegerSchema = z
	.number()
	.refine((value) => Number.isSafeInteger(value) && !Object.is(value, -0));

export const startRequestSchema = z
	.object({
		requestId: requestIdSchema,
		gameType: z.literal('blackjack'),
		rulesetVersion: z.literal('blackjack-ranked-v1'),
		wager: safeIntegerSchema.min(10).max(1000),
	})
	.strict();

export const actionRequestSchema = z
	.object({
		sequence: safeIntegerSchema.refine((value) => value >= 0),
		action: rankedActionSchema,
	})
	.strict();
```

The second sequence refine expresses non-negativity after the shared safe-integer/negative-zero check.

Define every error code and HTTP status in one record:

```ts
export const RANKED_ERROR_STATUS = {
	INVALID_REQUEST: 400,
	INVALID_WAGER: 400,
	INVALID_ACTION: 400,
	UNAUTHORIZED: 401,
	SESSION_NOT_FOUND: 404,
	ACTIVE_SESSION_EXISTS: 409,
	IDENTIFIER_REUSE_MISMATCH: 409,
	SEQUENCE_MISMATCH: 409,
	INSUFFICIENT_BALANCE: 409,
	ACCOUNT_BALANCE_CHANGED: 409,
	MULTIPLAYER_CONFLICT: 409,
	MULTIPLAYER_ESCROW_ORPHANED: 409,
	RATE_LIMITED: 429,
	INTERNAL_ERROR: 500,
} as const;
```

`RankedServiceError` carries `code`, optional `expectedSequence`, and optional `retryAfter`.

- [ ] **Step 6: Prove the same fixtures in workerd**

Bundle `random.ts` and `canonical.ts` in the test with `Bun.build({ target: 'browser', format: 'esm', write: false })`, append a minimal default Worker `fetch`, run it through Miniflare, and compare the HMAC, commitment, canonical JSON, and shuffled-deck fixture with the Bun results.

Run: `bun test src/lib/ranked/canonical.test.ts src/lib/ranked/random.test.ts src/lib/ranked/random.worker.integration.test.ts src/lib/ranked/protocol.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json bun.lock src/lib/ranked
git commit -m "feat: add ranked protocol and deterministic randomness"
```

---

### Task 4: Build the Pure Ranked Blackjack Reducer

**Files:**

- Create: `src/lib/ranked/blackjack/types.ts`
- Create: `src/lib/ranked/blackjack/engine.ts`
- Create: `src/lib/ranked/blackjack/engine.test.ts`

**Interfaces:**

- Consumes: `RankedBlackjackActionLogEntryV1` from `protocol.ts`.
- Produces: `createInitialBlackjackState(config, deck)`.
- Produces: `replayRankedBlackjack(config, deck, actions): RankedBlackjackReplay`.
- Produces: terminal `RankedBlackjackOutcomeV1` and per-action `additionalWager`.
- Must not import D1, Astro, browser globals, clocks, random generation, or wallet state.

- [ ] **Step 1: Write reducer fixtures before implementation**

Use explicit 52-card decks with the intended draws at the array end. Cover:

```ts
test('a final split-hand bust still runs the dealer when an earlier hand stood', () => {
	const replay = replayRankedBlackjack(config(100), deckForMixedSplit(), [
		action(0, 'split'),
		action(1, 'stand'),
		action(2, 'hit'),
	]);
	expect(replay.state.phase).toBe('complete');
	expect(replay.state.dealerHand.cards.length).toBeGreaterThan(2);
});

test('rejects a fifth hand and permits double-down on an eligible post-split hand', () => {
	const fourHands = replayRankedBlackjack(config(10), deckForFourHands(), splitToFourHands());
	expect(fourHands.legalActions.some((entry) => entry.action === 'split')).toBe(false);
	const postSplit = replayRankedBlackjack(config(10), deckForPostSplitEleven(), [
		action(0, 'split'),
	]);
	expect(postSplit.legalActions).toContainEqual({ action: 'double-down', additionalWager: 10 });
});
```

Add fixtures for both naturals, dealer soft 17, all-bust dealer skip, split Blackjack 3:2, odd-wager flooring, normal win/loss/push, double-down one-card completion, sequence gaps, and illegal actions.

- [ ] **Step 2: Run the engine test**

Run: `bun test src/lib/ranked/blackjack/engine.test.ts`

Expected: FAIL because the ranked engine does not exist.

- [ ] **Step 3: Define immutable engine types**

```ts
export interface RankedBlackjackHandV1 {
	cards: readonly Card[];
	wager: number;
}

export interface RankedBlackjackStateV1 {
	phase: 'player-turn' | 'complete';
	playerHands: readonly RankedBlackjackHandV1[];
	activeHandIndex: number;
	dealerHand: readonly Card[];
	deckCursor: number;
	committedWager: number;
}

export interface RankedBlackjackReplay {
	state: RankedBlackjackStateV1;
	nextSequence: number;
	legalActions: readonly { action: RankedBlackjackAction; additionalWager: number }[];
	outcome: RankedBlackjackOutcomeV1 | null;
}
```

Reuse the existing pure hand evaluator and dealer strategy where their semantics match. Do not call `BlackjackGame` or `DeckManager`; both own casual balance/random state.

- [ ] **Step 4: Implement initial deal, action reduction, dealer play, and settlement**

`replayRankedBlackjack` must create a fresh initial state and fold the canonical log in sequence order. After each action, calculate legal rule actions without consulting balance. When the final player hand completes, call a single `finishPlayerTurn` helper that skips dealer draws only when every hand is bust.

Use integer payout formulas:

```ts
const blackjackPayout = wager + Math.floor((wager * 3) / 2);
const normalWinPayout = wager * 2;
```

Classify the whole session by total payout versus total committed wager; retain every per-hand result in the outcome.

- [ ] **Step 5: Run the engine and existing casual Blackjack tests**

Run: `bun test src/lib/ranked/blackjack/engine.test.ts src/lib/blackjack`

Expected: PASS. The ranked implementation must not change casual behavior in this task.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ranked/blackjack
git commit -m "feat: add pure ranked blackjack reducer"
```

---

### Task 5: Add the Versioned Adapter and Safe Public Projection

**Files:**

- Create: `src/lib/ranked/registry.ts`
- Create: `src/lib/ranked/registry.test.ts`
- Create: `src/lib/ranked/blackjack/adapter.ts`
- Create: `src/lib/ranked/blackjack/adapter.test.ts`

**Interfaces:**

- Produces: `RankedGameAdapter<Config, Action, Replay, PublicState, Outcome>`.
- Produces: `getRankedAdapter(gameType, rulesetVersion)`.
- Produces: `BLACKJACK_RANKED_V1_CONFIG` rule constants and `issueBlackjackConfig(wager)`.
- Produces: `blackjackRankedV1Adapter.replay(seed, config, actions)` and `.project(replay, accountBalance)`.

- [ ] **Step 1: Write adapter and projection tests**

```ts
test('issues the exact immutable v1 config and hashes the per-session wager', async () => {
	const first = await adapter.issue({ wager: 100 });
	const second = await adapter.issue({ wager: 200 });
	expect(first.config.rulesetVersion).toBe('blackjack-ranked-v1');
	expect(first.configHash).not.toBe(second.configHash);
});

test('active projection hides seed, deck, and dealer hole card', async () => {
	const replay = await adapter.replay(seedFixture, config, []);
	const publicState = adapter.project(replay, 0);
	expect(publicState.dealer.cards).toHaveLength(1);
	expect(JSON.stringify(publicState)).not.toContain(seedFixtureBase64);
	expect(JSON.stringify(publicState)).not.toContain('deckCursor');
	expect(publicState.availableActions).toEqual(['hit', 'stand']);
});
```

Also assert terminal projection reveals the full dealer hand, hand values are structured, and additional-wager actions disappear when `accountBalance` is too small.

- [ ] **Step 2: Run the focused tests**

Run: `bun test src/lib/ranked/registry.test.ts src/lib/ranked/blackjack/adapter.test.ts`

Expected: FAIL because the adapter and registry do not exist.

- [ ] **Step 3: Define the generic adapter boundary**

```ts
export interface RankedGameAdapter<C, A, R, P, O> {
	readonly gameType: RankedGameType;
	readonly rulesetVersion: string;
	issue(input: { wager: number }): Promise<{ config: C; configJson: string; configHash: string }>;
	replay(seed: Uint8Array, config: C, actions: readonly A[]): Promise<R>;
	project(replay: R, accountBalance: number): P;
	terminalOutcome(replay: R): O | null;
}
```

The registry key is the literal `${gameType}:${rulesetVersion}` and throws `INVALID_REQUEST` for every unsupported pair.

- [ ] **Step 4: Implement the Blackjack v1 adapter**

Issue the exact integer/boolean configuration from design section 5.1. Derive and shuffle the deck before invoking the synchronous reducer. Project only the fields allowed by design section 5.5 and intersect rule-legal actions with current account funding.

- [ ] **Step 5: Run all ranked pure tests**

Run: `bun test src/lib/ranked`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ranked
git commit -m "feat: register ranked blackjack v1 adapter"
```

---

### Task 6: Centralize Multiplayer Membership Reconciliation

**Files:**

- Create: `src/server/mp/membership.ts`
- Create: `src/server/mp/membership.test.ts`
- Modify: `src/pages/api/mp/rooms/index.ts`
- Modify: `src/pages/api/mp/lock.ts`
- Modify: `src/server/mp/lock.test.ts`
- Create: `src/server/mp/rooms-api.test.ts`

**Interfaces:**

- Produces: `reconcileMultiplayerMembership(input): Promise<MembershipResolution>`.
- Produces: `hasActiveRankedSession(db, userId): Promise<boolean>`.
- Consumes: existing `roomExists(namespace, roomCode): Promise<'exists' | 'gone' | 'unknown'>`.
- Preserves: service-only release behavior in `src/pages/api/mp/release-escrow.ts`.

- [ ] **Step 1: Write shared-policy tests**

```ts
test.each(['exists', 'unknown'] as const)('preserves a %s membership', async (probeResult) => {
	const result = await reconcileMultiplayerMembership(input({ probeResult, ageMs: 31_000 }));
	expect(result.kind).toBe('conflict');
	expect(await readMembership(db, userId)).not.toBeNull();
});

test('releases scoped escrow before deleting a definitively gone membership', async () => {
	await seedMembershipAndEscrow(db, userId, 'MP-OLD01', 500);
	const result = await reconcileMultiplayerMembership(
		input({ probeResult: 'gone', ageMs: 31_000 }),
	);
	expect(result).toEqual({ kind: 'clear' });
	expect(await readBalance(db, userId)).toEqual({ chipBalance: 1000, heldChips: 0 });
	expect(await readMembership(db, userId)).toBeNull();
});

test('fails closed when held chips have no membership', async () => {
	await seedOrphanedEscrow(db, userId, 500);
	expect(await reconcileMultiplayerMembership(input({}))).toEqual({ kind: 'orphaned' });
	expect(await readBalance(db, userId)).toEqual({ chipBalance: 500, heldChips: 500 });
});
```

Add exact 30-second-boundary coverage, same-room allowance for `/api/mp/lock`, a concurrent membership replacement guard, and active-ranked-session checks in both MP endpoints.

- [ ] **Step 2: Run the MP tests**

Run: `bun test src/server/mp/membership.test.ts src/server/mp/lock.test.ts src/server/mp/rooms-api.test.ts`

Expected: FAIL because the shared reconciler is absent and `/api/mp/lock` can delete membership before releasing escrow.

- [ ] **Step 3: Implement one reconciliation state machine**

```ts
export type MembershipResolution =
	| { kind: 'clear' }
	| { kind: 'same-room'; roomCode: string }
	| { kind: 'conflict'; roomCode: string }
	| { kind: 'orphaned' };

export interface ReconcileMembershipInput {
	db: D1Database;
	namespace?: DurableObjectNamespace;
	userId: string;
	allowedRoomCode?: string;
	nowMs?: number;
	probe?: typeof roomExists;
}
```

Rules in order:

1. Read membership and `heldChips`.
2. With no membership, return `orphaned` when `heldChips > 0`, otherwise `clear`.
3. Return `same-room` when `allowedRoomCode` matches.
4. Preserve and return `conflict` while membership age is less than 30,000 ms.
5. Preserve and return `conflict` without a namespace or when the probe is `exists`/`unknown`.
6. On `gone`, execute a D1 batch whose first statement returns scoped escrow and whose second deletes only `(userId, roomCode)`.
7. Inspect both counts, re-read membership and escrow, and return only `clear`, `conflict`, or `orphaned`; never infer success from a zero-row mutation.

- [ ] **Step 4: Refactor both MP handlers and add ranked exclusion**

Call `hasActiveRankedSession` before creating/acquiring membership and map it to existing MP `409` responses. In room creation call the reconciler before inserting the new code. In lock acquisition pass `allowedRoomCode: parsed.roomCode`. Remove both route-local stale-probe implementations.

- [ ] **Step 5: Run all multiplayer server tests**

Run: `bun test src/server/mp`

Expected: PASS, including existing release/settlement/reconnect invariants.

- [ ] **Step 6: Commit**

```bash
git add src/server/mp src/pages/api/mp/rooms/index.ts src/pages/api/mp/lock.ts
git commit -m "refactor: centralize multiplayer membership repair"
```

---

### Task 7: Implement Durable Rate Limits and the Start Transaction

**Files:**

- Create: `src/server/ranked/logging.ts`
- Create: `src/server/ranked/rate-limit.ts`
- Create: `src/server/ranked/repository.ts`
- Create: `src/server/ranked/repository.integration.test.ts`

**Interfaces:**

- Produces: `RankedRateOperation` and immutable `RANKED_RATE_LIMITS`.
- Produces: `buildRateLimitStatement(db, input)` and `getRetryAfterSeconds`.
- Produces: `consumeStandaloneRateLimit(userId, operation, nowSeconds)` for resume and replay buckets.
- Produces: `createRankedRepository(db)` with start/read methods.
- Consumes: ranked schema, canonical hashes, and shared MP reconciler.

- [ ] **Step 1: Write real-D1 start and rate-limit tests**

Cover six starts/minute, 30 actions/minute, 120 resumes/replays/minute, fresh repository instances sharing the same counter, exact `Retry-After`, insufficient balance, `heldChips` introduced after preflight, duplicate identical start, request-ID mismatch, different active session, and racing starts. Prove in workerd D1 that a matched `UPDATE user SET chipBalance = chipBalance` reports one change, a stale expected balance reports zero, and a stale start snapshot cannot insert a session or deduct a wager.

```ts
test('a conflict-tolerant duplicate start commits rate but no second wager', async () => {
	const [first, second] = await Promise.all([
		repository.runStartTransition(startInput),
		repository.runStartTransition(startInput),
	]);
	expect([first.kind, second.kind].sort()).toEqual(['created', 'not-created']);
	expect(await readBalance(db, userId)).toBe(900);
	expect(await countSessions(db, userId)).toBe(1);
	expect(await readRateCount(db, userId, 'ranked_start')).toBe(2);
});
```

- [ ] **Step 2: Run the repository integration test**

Run: `bun test src/server/ranked/repository.integration.test.ts`

Expected: FAIL because the ranked repository does not exist.

- [ ] **Step 3: Implement redacted ranked logging and fixed-window limits**

Use SHA-256-derived short identifiers or the existing redaction convention; never log raw IDs. Pin:

```ts
export const RANKED_RATE_LIMITS = {
	ranked_start: { limit: 6, windowSeconds: 60 },
	ranked_action: { limit: 30, windowSeconds: 60 },
	ranked_resume: { limit: 120, windowSeconds: 60 },
	ranked_replay: { limit: 120, windowSeconds: 60 },
} as const;
```

The conditional upsert must increment only below the configured limit and must be usable as statement one in a larger D1 batch.

```sql
INSERT INTO ranked_rate_limit (userId, operation, windowStart, count, expiresAt)
VALUES (?, ?, ?, 1, ?)
ON CONFLICT (userId, operation, windowStart)
DO UPDATE SET count = ranked_rate_limit.count + 1, expiresAt = excluded.expiresAt
WHERE ranked_rate_limit.count < ?
```

- [ ] **Step 4: Implement typed repository reads**

```ts
export interface RankedRepository {
	findByStartRequest(userId: string, requestId: string): Promise<RankedSessionRecord | null>;
	findOwnedSession(userId: string, sessionId: string): Promise<RankedSessionRecord | null>;
	findResult(sessionId: string): Promise<RankedResultRecord | null>;
	readAccount(userId: string): Promise<{ chipBalance: number; heldChips: number } | null>;
	runStartTransition(input: StartTransitionInput): Promise<StartTransitionResult>;
}

export interface StartTransitionInput {
	userId: string;
	expectedBalance: number;
	session: NewRankedSessionRecord;
	rateLimit: RankedRateLimitInput;
}
```

Parse persisted config/action JSON through the strict versioned schemas on reads. Corrupt rows are invariant errors, not public validation errors.

- [ ] **Step 5: Implement and export the safety-critical start SQL**

The batch order is:

1. Conditional `ranked_start` upsert.
2. Exact-balance no-op account update, guarded by `heldChips = 0`, sufficient balance, no `mp_membership` row, no active ranked row, and `WHERE changes() = 1`.
3. `INSERT ... SELECT ... WHERE changes() = 1 ... ON CONFLICT DO NOTHING` for `ranked_session`, repeating the account and exclusion predicates.
4. Relative wager deduction guarded by the inserted session, exact pre-read balance, and `WHERE changes() = 1`.

Export the SQL constants so the integration test executes the production strings. Inspect all four mutation counts and return typed `rate-limited`, `balance-changed`, `not-created`, and `created` outcomes for coordinator classification. The no-op account write is intentionally before the session insert: if a casual update invalidates `expectedBalance`, the rate increment may commit but no ranked session or wager mutation can occur.

```sql
UPDATE user
SET chipBalance = chipBalance
WHERE id = ?
	AND chipBalance = ?
	AND chipBalance >= ?
	AND heldChips = 0
	AND changes() = 1
	AND NOT EXISTS (SELECT 1 FROM mp_membership WHERE userId = ?)
	AND NOT EXISTS (SELECT 1 FROM ranked_session WHERE activeUserId = ?)
```

```sql
INSERT INTO ranked_session (
	id, userId, startRequestId, startPayloadHash, activeUserId,
	gameType, rulesetVersion, configJson, configHash, seed, seedCommitment,
	actionLogJson, actionLogHash, nextSequence, initialWager, committedWager,
	status, expiresAt, createdAt, updatedAt
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 'active', ?, ?, ?
WHERE changes() = 1
	AND EXISTS (
		SELECT 1 FROM user
		WHERE id = ? AND chipBalance = ? AND chipBalance >= ? AND heldChips = 0
	)
	AND NOT EXISTS (SELECT 1 FROM mp_membership WHERE userId = ?)
	AND NOT EXISTS (SELECT 1 FROM ranked_session WHERE activeUserId = ?)
ON CONFLICT DO NOTHING
```

```sql
UPDATE user
SET chipBalance = chipBalance - ?, updatedAt = ?
WHERE id = ?
	AND chipBalance = ?
	AND heldChips = 0
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ? AND status = 'active'
	)
```

- [ ] **Step 6: Run the start/rate tests**

Run: `bun test src/server/ranked/repository.integration.test.ts`

Expected: PASS for all start and durable-counter cases; terminal/action cases remain for Task 8.

- [ ] **Step 7: Commit**

```bash
git add src/server/ranked
git commit -m "feat: add ranked start transaction and rate limits"
```

---

### Task 8: Add Action, Terminal, Reward, and Expiry Transactions

**Files:**

- Modify: `src/server/ranked/repository.ts`
- Modify: `src/server/ranked/repository.integration.test.ts`

**Interfaces:**

- Extends: `RankedRepository` with `runActionTransition`, `runTerminalTransition`, `runExpirationTransition`, `listExpiredSessions`, and `deleteExpiredRateBuckets`.
- Produces: stored immutable receipt rows as the only terminal response source.

- [ ] **Step 1: Add failing action concurrency and cascade tests**

Use real Miniflare D1 batches and actual `Promise.all`, not an in-memory predicate simulation.

```ts
test('parallel actions produce one sequence winner and one wallet effect', async () => {
	const [left, right] = await Promise.all([
		repository.runActionTransition(doubleInput),
		repository.runActionTransition(doubleInput),
	]);
	expect([left.kind, right.kind].filter((kind) => kind === 'applied')).toHaveLength(1);
	expect(await readSessionSequence(db, sessionId)).toBe(1);
	expect(await readBalance(db, userId)).toBe(800);
	expect(await readActionLog(db, sessionId)).toEqual([{ sequence: 0, action: 'double-down' }]);
});
```

Add denied-rate zero-cascade, escrow TOCTOU, insufficient additional wager, mismatched concurrent action, opening-natural settlement inside the start batch, terminal retry, reward-once, reward uniqueness rollback, expiry forfeit, stats-once, reward exclusion from `netProfit`/`biggestWin`, and persistence-failure rollback tests.

Add receipt-snapshot tests that:

- Verify a matched no-op account snapshot reports one change and a stale snapshot reports zero.
- Change the casual balance between terminal preflight and the batch, then prove there is no session/result/stats/reward mutation.
- Retry from the fresh balance and assert stored `balanceAfter` equals the actual account row.
- Independently canonicalize the stored receipt without `receiptHash` and assert its SHA-256 equals the stored hash.
- Exercise the same stale-snapshot behavior for an opening natural and expiration.

- [ ] **Step 2: Run the expanded repository integration test**

Run: `bun test src/server/ranked/repository.integration.test.ts`

Expected: FAIL because action and terminal repository methods are absent.

- [ ] **Step 3: Implement action compare-and-swap batches**

For non-terminal funded actions the order is rate upsert, guarded relative wallet update, then guarded session update. For non-terminal zero-wager actions the session update follows rate directly. Both paths store the canonical log/hash and increment `nextSequence` only once.

For terminal actions, the order starts with the rate upsert and an exact-balance no-op account snapshot. The snapshot repeats the owned active-session/expected-sequence predicate and `heldChips = 0`; all terminal effects follow only when it reports one change.

```ts
export interface ActionTransitionInput {
	userId: string;
	sessionId: string;
	expectedSequence: number;
	actionLogJson: string;
	actionLogHash: string;
	additionalWager: number;
	committedWager: number;
	nowSeconds: number;
	terminal?: TerminalTransitionInput;
}

export interface TerminalEffects {
	finalAdditionalWager: number;
	payout: number;
	gameNetDelta: number;
	rewardDelta: 0 | 100;
	outcomeJson: string;
	statsEffectsJson: string;
	achievementEffectsJson: string;
	rewardEffectsJson: string;
}

export interface TerminalTransitionInput extends TerminalEffects {
	expectedWalletBalance: number;
	balanceAfter: number;
	receiptHash: string;
	settledAt: number;
}
```

`expectedWalletBalance` is the account value immediately before the terminal wallet delta: the preflight balance for an action or expiration, and the balance after opening-wager deduction for an opening natural. The coordinator must satisfy:

```ts
balanceAfter === expectedWalletBalance - finalAdditionalWager + payout + rewardDelta;
```

Classify a zero snapshot/wallet/session count only after re-reading balance, escrow, stored sequence, action, and result.

- [ ] **Step 4: Implement the strict terminal cascade**

Build two explicit branches: reward-eligible and non-reward. In the eligible branch, insert `ranked_debut_100` with a plain unique insert before including 100 chips in the wallet update. A uniqueness error must roll back the entire batch; after the catch, re-read the grant and retry the non-reward branch only when the existing grant is internally consistent.

Before either branch, the coordinator supplies the full canonical receipt and its hash. D1 cannot compute SHA-256 from an intra-batch row, so the production SQL proves the precomputed monetary identity with exact balance predicates.

For a terminal action, establish the snapshot after the successful action-rate upsert:

```sql
UPDATE user
SET chipBalance = chipBalance
WHERE id = ?
	AND chipBalance = ?
	AND heldChips = 0
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ?
			AND status = 'active' AND nextSequence = ?
	)
```

Opening-natural settlement uses the exact start snapshot and successful opening-wager deduction from Task 7 instead of another no-op update.

Expiration uses the account snapshot as statement one, so its SQL deliberately omits `changes() = 1` and replaces the expected-sequence predicate with `expiresAt <= ?`. The following expiration session compare-and-swap requires `changes() = 1`.

```sql
INSERT INTO ranked_reward_grant (
	userId, rewardId, sourceSessionId, achievementId, chipAmount, grantedAt
)
SELECT ?, 'ranked_debut_100', ?, 'ranked_debut', 100, ?
WHERE changes() = 1
```

The statement deliberately has no conflict clause. The following wallet statement includes the reward only in this branch:

```sql
UPDATE user
SET chipBalance = chipBalance - ? + ? + ?, updatedAt = ?
WHERE id = ?
	AND chipBalance = ?
	AND heldChips = 0
	AND changes() = 1
	AND EXISTS (
		SELECT 1 FROM ranked_session
		WHERE id = ? AND userId = ? AND activeUserId = ?
			AND status = 'active' AND nextSequence = ?
	)
```

The remainder of the batch is:

1. Exact account snapshot and winning transition gate.
2. Strict reward reservation when eligible.
3. Relative wallet update when monetary delta is non-zero.
4. Normal session settlement compare-and-swap; expiration performs its compare-and-swap immediately after its account snapshot.
5. Immutable `ranked_result` insert binding the precomputed receipt only when the account row equals `balanceAfter`.
6. `ranked_game_stats` upsert.
7. Conflict-tolerant `user_achievement` insert for `ranked_debut`.

Every downstream statement includes `WHERE changes() = 1`. Return only a stored `ranked_result`.

```sql
INSERT INTO ranked_result (
	sessionId, userId, gameType, rulesetVersion, seedCommitment,
	configHash, actionLogHash, outcomeJson, initialWager, committedWager,
	payout, gameNetDelta, rewardDelta, balanceAfter, statsEffectsJson,
	achievementEffectsJson, rewardEffectsJson, receiptHash, settledAt
)
SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
FROM user
WHERE id = ? AND chipBalance = ? AND changes() = 1
```

Extend `runStartTransition` with `openingTerminal?: TerminalTransitionInput`; when present, append this same terminal cascade after the opening-wager deduction so the session, wager, result, statistics, achievement, and reward commit or roll back together.

- [ ] **Step 5: Implement expiration reads and cleanup**

`listExpiredSessions` uses:

```sql
SELECT id
FROM ranked_session
WHERE status = 'active' AND expiresAt <= ?
ORDER BY expiresAt ASC, id ASC
LIMIT 100
```

`runExpirationTransition` first executes the exact-balance no-op account snapshot without a rate statement or a `changes()` predecessor guard, then compare-and-swaps `status = 'expired'` with `WHERE changes() = 1`, clears `activeUserId`, records the precomputed immutable forfeit result only when the account still equals `balanceAfter`, applies ranked loss/forfeit statistics, and never grants Ranked Debut. A stale snapshot returns `balance-changed` without changing the session, so lazy or scheduled callers can rebuild and retry.

- [ ] **Step 6: Run all repository integration tests**

Run: `bun test src/server/ranked/repository.integration.test.ts`

Expected: PASS, including actual parallel batches and strict reward rollback.

- [ ] **Step 7: Commit**

```bash
git add src/server/ranked/repository.ts src/server/ranked/repository.integration.test.ts
git commit -m "feat: settle ranked actions exactly once"
```

---

### Task 9: Orchestrate Start, Resume, Actions, and Thin HTTP Routes

**Files:**

- Create: `src/server/ranked/coordinator.ts`
- Create: `src/server/ranked/coordinator.test.ts`
- Create: `src/server/ranked/http.ts`
- Create: `src/server/ranked/http.test.ts`
- Create: `src/pages/api/ranked/sessions/index.ts`
- Create: `src/pages/api/ranked/sessions/[sessionId]/index.ts`
- Create: `src/pages/api/ranked/sessions/[sessionId]/actions.ts`

**Interfaces:**

- Produces: `createRankedCoordinator(deps)` with `start`, `resume`, `act`, and `expire`.
- Produces: `createRankedHttpHandlers(deps)` with Astro-compatible `start`, `resume`, and `action`.
- Consumes: adapter registry, ranked repository, shared MP reconciler, clock, and secure random bytes.

- [ ] **Step 1: Write coordinator lifecycle tests**

Use dependency injection for repository, clock, adapter registry, and random bytes. Cover matching/mismatched start replay, matching/mismatched old sequence, sequence gaps after settlement, terminal `sequence === nextSequence`, lazy expiration, immutable deadline, opening natural, current-state replay, replay-bucket exhaustion, ownership hiding, orphaned escrow, and exact-balance snapshot retries.

```ts
test('a matching old action returns current authoritative state', async () => {
	repository.findOwnedSession.mockResolvedValue(sessionAtSequence(3));
	const response = await coordinator.act({
		userId,
		sessionId,
		body: { sequence: 0, action: 'hit' },
	});
	expect(response.state.nextSequence).toBe(3);
	expect(repository.consumeStandaloneRateLimit).toHaveBeenCalledWith(
		expect.objectContaining({ operation: 'ranked_replay' }),
	);
});

test('recorded mismatch wins over terminal receipt replay', async () => {
	repository.findOwnedSession.mockResolvedValue(settledSessionAtSequence(2));
	await expect(
		coordinator.act({ userId, sessionId, body: { sequence: 0, action: 'stand' } }),
	).rejects.toMatchObject({ code: 'IDENTIFIER_REUSE_MISMATCH' });
});
```

- [ ] **Step 2: Write HTTP contract tests**

Assert strict JSON parsing, 401 before work, owner/not-owner both returning 404, all stable error/status mappings including retriable `ACCOUNT_BALANCE_CHANGED`, `expectedSequence`, `Retry-After`, and no seed/deck/hole-card leakage in serialized responses.

- [ ] **Step 3: Run coordinator and HTTP tests**

Run: `bun test src/server/ranked/coordinator.test.ts src/server/ranked/http.test.ts`

Expected: FAIL because the coordinator and handlers do not exist.

- [ ] **Step 4: Implement the coordinator**

```ts
export interface RankedCoordinatorDeps {
	repository: RankedRepository;
	getAdapter: typeof getRankedAdapter;
	reconcileMembership: typeof reconcileMultiplayerMembership;
	now: () => Date;
	randomBytes: (length: number) => Uint8Array;
}
```

Start order must match design section 6.1. Resume increments `ranked_resume` and is intentionally D1-writing. Action compares stored entries before transition rate limiting, uses `ranked_replay` for matching replays, and maps repository zero-row outcomes only after a current-state re-read. All response construction uses adapter projection or stored receipt records.

For starts and terminal transitions, read the account before canonical receipt construction and pass the exact expected balance into the repository. On a typed `balance-changed` result, re-read account/session/grant state, replay the action if it is still applicable, recompute `balanceAfter` and `receiptHash`, and retry the same logical request up to three total snapshot attempts. If the new balance cannot fund an additional wager, return `INSUFFICIENT_BALANCE`; if three sufficient snapshots race, return retriable `ACCOUNT_BALANCE_CHANGED`. Never reuse a hash computed from a stale balance.

- [ ] **Step 5: Implement injectable HTTP handlers and route re-exports**

```ts
export function rankedJsonError(error: unknown): Response {
	if (error instanceof RankedServiceError) {
		const headers = new Headers({ 'content-type': 'application/json' });
		if (error.retryAfter !== undefined) headers.set('Retry-After', String(error.retryAfter));
		return new Response(
			JSON.stringify({
				error: error.code,
				...(error.expectedSequence === undefined
					? {}
					: { expectedSequence: error.expectedSequence }),
			}),
			{ status: RANKED_ERROR_STATUS[error.code], headers },
		);
	}
	console.error('[RANKED] unhandled request failure');
	return new Response(JSON.stringify({ error: 'INTERNAL_ERROR' }), {
		status: 500,
		headers: { 'content-type': 'application/json' },
	});
}
```

Routes obtain `locals.user`, `locals.runtime.env.DB`, and `locals.runtime.env.arcturus`; they contain no rule, replay, rate, or settlement logic.

- [ ] **Step 6: Run HTTP, coordinator, and repository tests**

Run: `bun test src/server/ranked src/pages/api/ranked`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server/ranked src/pages/api/ranked
git commit -m "feat: expose ranked blackjack session APIs"
```

---

### Task 10: Integrate Ranked Expiration With Scheduled Work

**Files:**

- Create: `src/server/ranked/expiration.ts`
- Create: `src/server/ranked/expiration.test.ts`
- Modify: `src/server/cleanup.ts`
- Modify: `src/server/cleanup.test.ts`
- Modify: `src/worker.ts`

**Interfaces:**

- Produces: `runRankedExpiration(db, deps): Promise<void>`.
- Produces: `runRankedRateLimitCleanup(db, nowSeconds): Promise<void>`.
- Preserves: `runRetentionCleanup(db)` semantics.
- Consumes: the coordinator's shared `expire(sessionId)` path.

- [ ] **Step 1: Write scheduled-job isolation tests**

```ts
test('continues after a poison session and attempts later expirations', async () => {
	expire.mockRejectedValueOnce(new Error('corrupt row')).mockResolvedValue(undefined);
	await runRankedExpiration(db, { expire });
	expect(expire.mock.calls.map(([sessionId]) => sessionId)).toEqual(['oldest', 'poison-next']);
});

test('a ranked cleanup failure does not suppress retention cleanup', async () => {
	await scheduledHarness({
		expire: async () => {
			throw new Error('ranked failure');
		},
		rateCleanup,
		retentionCleanup,
	});
	expect(rateCleanup).toHaveBeenCalledTimes(1);
	expect(retentionCleanup).toHaveBeenCalledTimes(1);
});
```

- [ ] **Step 2: Run cleanup tests**

Run: `bun test src/server/ranked/expiration.test.ts src/server/cleanup.test.ts`

Expected: FAIL because ranked scheduled jobs do not exist.

- [ ] **Step 3: Implement bounded per-session expiration**

Read the oldest 100 IDs once. Wrap each coordinator expiration call in its own `try/catch`, log a redacted `ranked_session_expired` or invariant event, and continue. Delete `ranked_rate_limit` rows with `expiresAt <= now` in a separate exported function.

- [ ] **Step 4: Compose the Worker scheduled handler with independent guards**

Run jobs in this order:

1. `runRankedExpiration`.
2. `runRankedRateLimitCleanup`.
3. `runRetentionCleanup`.

Each call has its own top-level `try/catch`; missing `env.DB` still logs once and returns. Do not move ranked history into retention cleanup.

- [ ] **Step 5: Run cleanup and Worker build checks**

Run: `bun test src/server/ranked/expiration.test.ts src/server/cleanup.test.ts`

Run: `bun run build`

Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add src/server/ranked/expiration.ts src/server/ranked/expiration.test.ts src/server/cleanup.ts src/server/cleanup.test.ts src/worker.ts
git commit -m "feat: expire ranked sessions from scheduled work"
```

---

### Task 11: Build the Ranked Blackjack Page and Recovery Client

**Files:**

- Create: `src/lib/ranked/blackjack/client.ts`
- Create: `src/lib/ranked/blackjack/client.test.ts`
- Create: `src/lib/ranked/blackjack/ui.ts`
- Create: `src/lib/ranked/blackjack/ui.test.ts`
- Create: `src/pages/games/blackjack/ranked.astro`
- Modify: `src/pages/games/blackjack.astro`

**Interfaces:**

- Produces: `createRankedBlackjackClient(deps)` and `initRankedBlackjackClient()`.
- Produces: `createRankedBlackjackRenderer(root)`.
- Consumes: public protocol types only; never imports the ranked reducer, casual `BlackjackGame`, or `DeckManager`.

- [ ] **Step 1: Write client recovery tests**

```ts
test('persists request id before start and session id after success', async () => {
	await client.start(100);
	expect(storage.events[0]).toEqual(['set', START_REQUEST_KEY, expect.any(String)]);
	expect(storage.getItem(ACTIVE_SESSION_KEY)).toBe('abcdefghijklmnopqrstuv');
});

test('retries one uncertain action then resumes authoritative state', async () => {
	fetchMock
		.mockRejectedValueOnce(new TypeError('network'))
		.mockRejectedValueOnce(new TypeError('network'))
		.mockResolvedValueOnce(jsonResponse(activeState({ nextSequence: 1 })));
	await client.act('stand');
	expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
		'/api/ranked/sessions/abcdefghijklmnopqrstuv/actions',
		'/api/ranked/sessions/abcdefghijklmnopqrstuv/actions',
		'/api/ranked/sessions/abcdefghijklmnopqrstuv',
	]);
});
```

Add terminal-reference cleanup, reload resume before enabling start, one in-flight action, server balance replacement, and countdown-not-authoritative tests.

- [ ] **Step 2: Write renderer secrecy and controls tests**

Assert the renderer creates no dealer-hole DOM node while active, uses only `availableActions`, disables every control while pending, renders structured hand values, updates the authoritative balance/countdown, and resolves `achievementEffectsJson` IDs through `getAchievementById` before enqueueing the shared toast.

- [ ] **Step 3: Run client/UI tests**

Run: `bun test src/lib/ranked/blackjack/client.test.ts src/lib/ranked/blackjack/ui.test.ts`

Expected: FAIL because the browser modules do not exist.

- [ ] **Step 4: Implement the injected client state machine**

```ts
export interface RankedBlackjackClientDeps {
	fetch: typeof fetch;
	storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
	renderer: RankedBlackjackRenderer;
	createRequestId: () => string;
}
```

Persist keys `arcturus:ranked-blackjack:start-request` and `arcturus:ranked-blackjack:session`. Serialize actions with the current server `nextSequence`; retry the same body exactly once after an uncertain response, then `GET` resume. Clear both keys only after rendering a terminal receipt.

- [ ] **Step 5: Implement the renderer and authenticated page**

The page redirects unauthenticated users to `/signin`. Give the root and controls stable IDs/test IDs for wager, start, countdown, dealer/player hands, action buttons, status, committed wager, balance, receipt ID/hash, ranked-stat summary, and achievement toast. The client script calls `initRankedBlackjackClient()` and contains no local game rules.

- [ ] **Step 6: Label Casual Blackjack without changing its client**

Add a visible `Casual` badge beside the existing heading. For authenticated users render a link to `/games/blackjack/ranked`; for guests render a sign-in link explaining Ranked Blackjack requires an account. Do not modify `blackjackClient.ts`, `BlackjackGame.ts`, settings, guest bankroll, or chip sync.

- [ ] **Step 7: Run ranked UI and casual Blackjack regressions**

Run: `bun test src/lib/ranked/blackjack src/lib/blackjack src/lib/public-game-session.test.ts`

Run: `bun run build`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ranked/blackjack src/pages/games/blackjack/ranked.astro src/pages/games/blackjack.astro
git commit -m "feat: add ranked blackjack browser experience"
```

---

### Task 12: Prove the Full Story With Playwright and Final Verification

**Files:**

- Create: `e2e/ranked-blackjack.spec.ts`
- Modify: `e2e/public-single-player-games.spec.ts`
- Modify: `e2e/authed-user-preservation.spec.ts`

**Interfaces:**

- Consumes: stable test IDs from Task 11 and existing guarded E2E auth bootstrap.
- Produces: acceptance-level evidence for ranked authority, retries, recovery, secrecy, and casual independence.

- [ ] **Step 1: Add authenticated ranked E2E coverage**

Use a freshly bootstrapped isolated user for tests that mutate balances. Start with a 10-chip wager, then repeatedly choose `stand` whenever the server reports an active hand; opening naturals are already terminal and need no action. Assert a stored receipt ID/hash, authoritative balance, and ranked-stat summary.

For reload recovery, start new rounds until one is active, capped at five attempts, then reload and assert the same session ID and sequence return. This avoids a flaky assumption that the server-generated opening deal cannot be natural.

- [ ] **Step 2: Add retry, cross-tab, and secrecy coverage**

Capture one start request and replay its exact body; assert the same session/receipt and one wager. Capture a terminal action and replay its exact body; assert byte-equivalent receipt JSON and one reward. In a second page, use the existing casual chip update path to change the account balance, resume ranked state, and assert the displayed balance updates and unfunded `double-down`/`split` controls are disabled.

For every start/action/resume response and active DOM snapshot, assert absence of keys/text matching `seed`, `deck`, generator state, and a second dealer card.

- [ ] **Step 3: Strengthen casual independence assertions**

In the guest suite assert the `Casual` badge, the sign-in-safe ranked prompt, a complete local round, and zero `/api/chips/update` calls. In the authenticated suite assert the Casual label/ranked link and one normal casual settlement without any `/api/ranked/` request.

- [ ] **Step 4: Run focused E2E tests**

Run: `bunx playwright test e2e/ranked-blackjack.spec.ts e2e/public-single-player-games.spec.ts e2e/authed-user-preservation.spec.ts`

Expected: PASS.

- [ ] **Step 5: Run the complete verification ladder**

Run, in order:

```bash
bun test src/lib/ranked src/server/ranked src/server/mp src/lib/achievements
bun run test
bun run test:e2e
bun run lint
bun run format:check
bun run build
```

Expected: every command exits zero. Inspect `git diff --check` and verify no response fixture, log assertion, or rendered markup exposes `ranked_session.seed`.

- [ ] **Step 6: Re-read the live Linear acceptance criteria and map evidence**

Confirm:

- Arbitrary deltas/scores are absent from ranked schemas.
- Duplicate settlement returns the stored receipt.
- Identifier reuse mismatch is covered.
- Ranked Blackjack is end-to-end.
- Determinism, tampering, duplicate, expiry, and insufficient balance tests pass.
- Guest/authenticated Casual Blackjack remains independent.

- [ ] **Step 7: Commit**

```bash
git add e2e/ranked-blackjack.spec.ts e2e/public-single-player-games.spec.ts e2e/authed-user-preservation.spec.ts
git commit -m "test: verify ranked blackjack end to end"
```
