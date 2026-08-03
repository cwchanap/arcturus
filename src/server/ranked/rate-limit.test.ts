import { describe, expect, test } from 'bun:test';
import {
	AUTHENTICATED_RATE_LIMITS,
	DAILY_CHALLENGE_RATE_LIMITS,
	RANKED_RATE_LIMITS,
	buildRateLimitContinuationStatement,
	buildRateLimitStatement,
	consumeStandaloneRateLimit,
	getRetryAfterSeconds,
	type AuthenticatedRateLimitInput,
	type AuthenticatedRateOperation,
	type DailyChallengeRateOperation,
	type RankedRateLimitInput,
	type RankedRateOperation,
} from './rate-limit';

describe('RANKED_RATE_LIMITS remain unchanged', () => {
	test('keeps the original ranked policy values', () => {
		expect(RANKED_RATE_LIMITS.ranked_start).toEqual({ limit: 6, windowSeconds: 60 });
		expect(RANKED_RATE_LIMITS.ranked_action).toEqual({ limit: 30, windowSeconds: 60 });
		expect(RANKED_RATE_LIMITS.ranked_resume).toEqual({ limit: 120, windowSeconds: 60 });
		expect(RANKED_RATE_LIMITS.ranked_replay).toEqual({ limit: 120, windowSeconds: 60 });
	});
});

describe('DAILY_CHALLENGE_RATE_LIMITS', () => {
	test('exposes the exact daily challenge policy values', () => {
		expect(DAILY_CHALLENGE_RATE_LIMITS.daily_challenge_start).toEqual({
			limit: 6,
			windowSeconds: 60,
		});
		expect(DAILY_CHALLENGE_RATE_LIMITS.daily_challenge_command).toEqual({
			limit: 30,
			windowSeconds: 60,
		});
		expect(DAILY_CHALLENGE_RATE_LIMITS.daily_challenge_resume).toEqual({
			limit: 120,
			windowSeconds: 60,
		});
		expect(DAILY_CHALLENGE_RATE_LIMITS.daily_challenge_replay).toEqual({
			limit: 120,
			windowSeconds: 60,
		});
	});
});

describe('AUTHENTICATED_RATE_LIMITS', () => {
	test('merges ranked and daily policies without overlap', () => {
		expect(Object.keys(AUTHENTICATED_RATE_LIMITS).sort()).toEqual([
			'daily_challenge_command',
			'daily_challenge_replay',
			'daily_challenge_resume',
			'daily_challenge_start',
			'ranked_action',
			'ranked_replay',
			'ranked_resume',
			'ranked_start',
		]);
	});

	test('daily challenge entries match the brief exact values', () => {
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
	});

	test('ranked entries are still present on the merged map', () => {
		expect(AUTHENTICATED_RATE_LIMITS.ranked_start).toBe(RANKED_RATE_LIMITS.ranked_start);
		expect(AUTHENTICATED_RATE_LIMITS.ranked_action).toBe(RANKED_RATE_LIMITS.ranked_action);
		expect(AUTHENTICATED_RATE_LIMITS.ranked_resume).toBe(RANKED_RATE_LIMITS.ranked_resume);
		expect(AUTHENTICATED_RATE_LIMITS.ranked_replay).toBe(RANKED_RATE_LIMITS.ranked_replay);
	});
});

describe('authenticated rate-limit operation types', () => {
	test('RankedRateOperation remains a subtype of AuthenticatedRateOperation', () => {
		const ranked: RankedRateOperation = 'ranked_start';
		const authenticated: AuthenticatedRateOperation = ranked;
		expect(authenticated).toBe('ranked_start');
	});

	test('DailyChallengeRateOperation is a subtype of AuthenticatedRateOperation', () => {
		const daily: DailyChallengeRateOperation = 'daily_challenge_start';
		const authenticated: AuthenticatedRateOperation = daily;
		expect(authenticated).toBe('daily_challenge_start');
	});

	test('a RankedRateLimitInput is assignable where an AuthenticatedRateLimitInput is expected', () => {
		const ranked: RankedRateLimitInput = {
			userId: 'user-1',
			operation: 'ranked_action',
			nowSeconds: 1000,
		};
		const authenticated: AuthenticatedRateLimitInput = ranked;
		expect(authenticated.operation).toBe('ranked_action');
	});
});

describe('generalized helpers accept daily challenge operations', () => {
	test('getRetryAfterSeconds computes the daily_challenge_start 60s window', () => {
		expect(getRetryAfterSeconds('daily_challenge_start', 1020)).toBe(60);
		expect(getRetryAfterSeconds('daily_challenge_start', 1079)).toBe(1);
		expect(getRetryAfterSeconds('daily_challenge_start', 1080)).toBe(60);
	});

	test('buildRateLimitStatement reuses ranked_rate_limit with the daily_challenge_start key', () => {
		const seen: { sql: string; args: unknown[] }[] = [];
		const db = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						seen.push({ sql, args });
						return {
							sql,
							args,
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		buildRateLimitStatement(db, {
			userId: 'user-daily',
			operation: 'daily_challenge_start',
			nowSeconds: 1000,
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.sql).toContain('ranked_rate_limit');
		expect(seen[0]?.args[0]).toBe('user-daily');
		expect(seen[0]?.args[1]).toBe('daily_challenge_start');
	});

	test('buildRateLimitContinuationStatement binds the daily_challenge_start key', () => {
		const seen: { sql: string; args: unknown[] }[] = [];
		const db = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						seen.push({ sql, args });
						return {
							sql,
							args,
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		buildRateLimitContinuationStatement(db, {
			userId: 'user-daily',
			operation: 'daily_challenge_start',
			nowSeconds: 1000,
		});

		expect(seen).toHaveLength(1);
		expect(seen[0]?.sql).toContain('ranked_rate_limit');
		expect(seen[0]?.args[0]).toBe('user-daily');
		expect(seen[0]?.args[1]).toBe('daily_challenge_start');
	});

	test('consumeStandaloneRateLimit reports allowed on a fresh daily_challenge_start bucket', async () => {
		const db = {
			prepare(sql: string) {
				return {
					bind(..._args: unknown[]) {
						return {
							sql,
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		const result = await consumeStandaloneRateLimit(
			db,
			'user-daily',
			'daily_challenge_start',
			1000,
		);
		expect(result).toEqual({ kind: 'allowed' });
	});

	test('consumeStandaloneRateLimit reports rate-limited when the daily_challenge_start bucket is full', async () => {
		const db = {
			prepare(_sql: string) {
				return {
					bind(..._args: unknown[]) {
						return {
							async run() {
								return { meta: { changes: 0 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		const result = await consumeStandaloneRateLimit(
			db,
			'user-daily',
			'daily_challenge_start',
			1000,
		);
		expect(result.kind).toBe('rate-limited');
		if (result.kind === 'rate-limited') {
			expect(result.retryAfter).toBeGreaterThan(0);
			expect(result.retryAfter).toBeLessThanOrEqual(60);
		}
	});

	test('consumeStandaloneRateLimit reports allowed on a fresh daily_challenge_command bucket', async () => {
		const db = {
			prepare(_sql: string) {
				return {
					bind(..._args: unknown[]) {
						return {
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		const result = await consumeStandaloneRateLimit(
			db,
			'user-daily',
			'daily_challenge_command',
			1000,
		);
		expect(result).toEqual({ kind: 'allowed' });
	});

	test('consumeStandaloneRateLimit reports rate-limited when the daily_challenge_command bucket is full', async () => {
		const db = {
			prepare(_sql: string) {
				return {
					bind(..._args: unknown[]) {
						return {
							async run() {
								return { meta: { changes: 0 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		const result = await consumeStandaloneRateLimit(
			db,
			'user-daily',
			'daily_challenge_command',
			1000,
		);
		expect(result.kind).toBe('rate-limited');
		if (result.kind === 'rate-limited') {
			expect(result.retryAfter).toBeGreaterThan(0);
			expect(result.retryAfter).toBeLessThanOrEqual(60);
		}
	});

	test('consumeStandaloneRateLimit reports allowed on a fresh daily_challenge_resume bucket', async () => {
		const db = {
			prepare(_sql: string) {
				return {
					bind(..._args: unknown[]) {
						return {
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		const result = await consumeStandaloneRateLimit(
			db,
			'user-daily',
			'daily_challenge_resume',
			1000,
		);
		expect(result).toEqual({ kind: 'allowed' });
	});

	test('consumeStandaloneRateLimit reports rate-limited when the daily_challenge_resume bucket is full', async () => {
		const db = {
			prepare(_sql: string) {
				return {
					bind(..._args: unknown[]) {
						return {
							async run() {
								return { meta: { changes: 0 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		const result = await consumeStandaloneRateLimit(
			db,
			'user-daily',
			'daily_challenge_resume',
			1000,
		);
		expect(result.kind).toBe('rate-limited');
		if (result.kind === 'rate-limited') {
			expect(result.retryAfter).toBeGreaterThan(0);
			expect(result.retryAfter).toBeLessThanOrEqual(60);
		}
	});

	test('getRetryAfterSeconds rejects negative and fractional nowSeconds with TypeError', () => {
		expect(() => getRetryAfterSeconds('daily_challenge_start', -1)).toThrow(TypeError);
		expect(() => getRetryAfterSeconds('daily_challenge_start', 0.5)).toThrow(TypeError);
	});

	test('consumeStandaloneRateLimit rejects an invariant-violating meta.changes of 2', async () => {
		const db = {
			prepare(_sql: string) {
				return {
					bind(..._args: unknown[]) {
						return {
							async run() {
								return { meta: { changes: 2 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;

		await expect(
			consumeStandaloneRateLimit(db, 'user-daily', 'daily_challenge_start', 1000),
		).rejects.toThrow('Authenticated rate-limit mutation count invariant failed');
	});
});

describe('assertNowSeconds invariants', () => {
	test('buildRateLimitStatement throws TypeError for a negative nowSeconds', () => {
		const db = {
			prepare() {
				return {
					bind() {
						return {
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		expect(() =>
			buildRateLimitStatement(db, {
				userId: 'user-inv',
				operation: 'ranked_start',
				nowSeconds: -1,
			}),
		).toThrow(TypeError);
	});

	test('buildRateLimitStatement throws TypeError for a non-integer nowSeconds', () => {
		const db = {
			prepare() {
				return {
					bind() {
						return {
							async run() {
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		expect(() =>
			buildRateLimitStatement(db, {
				userId: 'user-inv',
				operation: 'ranked_start',
				nowSeconds: 1.5,
			}),
		).toThrow(TypeError);
	});

	test('getRetryAfterSeconds throws TypeError for a negative nowSeconds', () => {
		expect(() => getRetryAfterSeconds('ranked_start', -1)).toThrow(TypeError);
	});
});

describe('consumeStandaloneRateLimit invariant failure', () => {
	test('throws when the mutation count is neither 0 nor 1', async () => {
		const db = {
			prepare() {
				return {
					bind() {
						return {
							async run() {
								return { meta: { changes: 2 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		await expect(consumeStandaloneRateLimit(db, 'user-inv', 'ranked_start', 1000)).rejects.toThrow(
			'Authenticated rate-limit mutation count invariant failed',
		);
	});
});
