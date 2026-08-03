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

export interface RankedRateLimitInput {
	userId: string;
	operation: RankedRateOperation;
	nowSeconds: number;
}

export interface AuthenticatedRateLimitInput {
	userId: string;
	operation: AuthenticatedRateOperation;
	nowSeconds: number;
}

export type RankedRateLimitResult =
	| { kind: 'allowed' }
	| { kind: 'rate-limited'; retryAfter: number };

/**
 * Rate-limit strategy: standalone pre-consume + batch continuation.
 *
 * The coordinator calls {@link consumeStandaloneRateLimit} to short-circuit
 * BEFORE building the expensive transition batch (replay, hash, receipt). If
 * the pre-consume returns `rate-limited`, the batch is never built. When the
 * pre-consume succeeds, the same row is carried forward into the batch via
 * {@link buildRateLimitContinuationStatement} so the count increment survives
 * the batch's atomic commit (or rolls back with it if the batch fails).
 *
 * This two-phase approach is preferred over a single-batch upsert because it
 * avoids the cost of replay + receipt construction on requests that would be
 * rejected anyway, while still keeping the count increment atomic with the
 * transition via the continuation statement inside the same D1 batch.
 */
export const RANKED_RATE_LIMIT_UPSERT_SQL = `INSERT INTO ranked_rate_limit (
	userId, operation, windowStart, count, expiresAt
)
VALUES (?, ?, ?, 1, ?)
ON CONFLICT (userId, operation, windowStart)
DO UPDATE SET count = ranked_rate_limit.count + 1, expiresAt = excluded.expiresAt
WHERE ranked_rate_limit.count < ?`;

export const RANKED_RATE_LIMIT_CONTINUATION_SQL = `UPDATE ranked_rate_limit
SET count = count
WHERE userId = ?
	AND operation = ?
	AND windowStart = ?
	AND count >= 1
	AND count <= ?`;

function assertNowSeconds(nowSeconds: number): void {
	if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
		throw new TypeError('Authenticated rate-limit time must be a non-negative safe integer');
	}
}

function getWindowStart(operation: AuthenticatedRateOperation, nowSeconds: number): number {
	assertNowSeconds(nowSeconds);
	const { windowSeconds } = AUTHENTICATED_RATE_LIMITS[operation];
	return Math.floor(nowSeconds / windowSeconds) * windowSeconds;
}

export function getRetryAfterSeconds(
	operation: AuthenticatedRateOperation,
	nowSeconds: number,
): number {
	const { windowSeconds } = AUTHENTICATED_RATE_LIMITS[operation];
	return getWindowStart(operation, nowSeconds) + windowSeconds - nowSeconds;
}

export function buildRateLimitStatement(
	db: D1Database,
	input: AuthenticatedRateLimitInput,
): D1PreparedStatement {
	const policy = AUTHENTICATED_RATE_LIMITS[input.operation];
	const windowStart = getWindowStart(input.operation, input.nowSeconds);
	const expiresAt = windowStart + policy.windowSeconds;
	return db
		.prepare(RANKED_RATE_LIMIT_UPSERT_SQL)
		.bind(input.userId, input.operation, windowStart, expiresAt, policy.limit);
}

export function buildRateLimitContinuationStatement(
	db: D1Database,
	input: AuthenticatedRateLimitInput,
): D1PreparedStatement {
	const policy = AUTHENTICATED_RATE_LIMITS[input.operation];
	const windowStart = getWindowStart(input.operation, input.nowSeconds);
	return db
		.prepare(RANKED_RATE_LIMIT_CONTINUATION_SQL)
		.bind(input.userId, input.operation, windowStart, policy.limit);
}

export async function consumeStandaloneRateLimit(
	db: D1Database,
	userId: string,
	operation: AuthenticatedRateOperation,
	nowSeconds: number,
): Promise<RankedRateLimitResult> {
	const result = await buildRateLimitStatement(db, { userId, operation, nowSeconds }).run();
	const changes = result.meta.changes;
	if (changes === 1) return { kind: 'allowed' };
	if (changes === 0) {
		return {
			kind: 'rate-limited',
			retryAfter: getRetryAfterSeconds(operation, nowSeconds),
		};
	}
	throw new Error('Authenticated rate-limit mutation count invariant failed');
}
