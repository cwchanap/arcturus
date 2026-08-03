import { describe, expect, test } from 'bun:test';
import {
	runRetentionCleanup,
	runScheduledJobs,
	isDailyPeriodKey,
	RETENTION_DAYS,
	ROULETTE_RECEIPT_RETENTION_DAYS,
	type ScheduledJobDeps,
} from './cleanup';

interface PreparedCall {
	sql: string;
	args: unknown[];
}

function createMockDbBinding() {
	const calls: PreparedCall[] = [];
	const runResults: Record<string, { meta: { changes: number } }> = {
		'DELETE FROM roulette_round': { meta: { changes: 5 } },
		'DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType NOT IN': {
			meta: { changes: 3 },
		},
		'DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType = ?': {
			meta: { changes: 2 },
		},
		'DELETE FROM mission_progress': { meta: { changes: 7 } },
		'DELETE FROM mission_override': { meta: { changes: 1 } },
		'DELETE FROM mission_game_tried': { meta: { changes: 4 } },
	};
	const binding = {
		prepare(sql: string) {
			return {
				sql,
				bind(...args: unknown[]) {
					return {
						sql,
						args,
						run: async () => {
							calls.push({ sql, args });
							for (const prefix of Object.keys(runResults)) {
								if (sql.startsWith(prefix)) return runResults[prefix];
							}
							return { meta: { changes: 0 } };
						},
					};
				},
			};
		},
	};
	return { binding: binding as unknown as D1Database, calls };
}

describe('runRetentionCleanup', () => {
	test('deletes from roulette_round and both chip_sync_receipt passes', async () => {
		const { binding, calls } = createMockDbBinding();
		await runRetentionCleanup(binding);
		expect(calls).toHaveLength(6);
		expect(calls[0].sql).toBe('DELETE FROM roulette_round WHERE createdAt < ?');
		expect(calls[1].sql).toBe(
			'DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType NOT IN (?, ?)',
		);
		expect(calls[2].sql).toBe('DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType = ?');
		expect(calls[3].sql).toBe(
			"DELETE FROM mission_progress WHERE periodKey < ? AND periodKey LIKE '____-__-__'",
		);
		expect(calls[4].sql).toBe(
			"DELETE FROM mission_override WHERE periodKey < ? AND periodKey LIKE '____-__-__'",
		);
		expect(calls[5].sql).toBe(
			"DELETE FROM mission_game_tried WHERE periodKey < ? AND periodKey LIKE '____-__-__'",
		);
	});

	test('excludes poker_mp and roulette receipts from the 30-day chip_sync_receipt delete', async () => {
		const { binding, calls } = createMockDbBinding();
		await runRetentionCleanup(binding);
		const receiptCall = calls[1];
		expect(receiptCall.args[1]).toBe('poker_mp');
		expect(receiptCall.args[2]).toBe('roulette');
	});

	test('reaps roulette receipts on the longer bounded schedule', async () => {
		const { binding, calls } = createMockDbBinding();
		// Capture the lower cutoff before cleanup runs so the bound is
		// meaningful — computing both before/after the call makes the
		// assertion trivially true since the two timestamps are nearly
		// identical.
		const before = Math.trunc(
			(Date.now() - ROULETTE_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000,
		);
		await runRetentionCleanup(binding);
		const rouletteReceiptCall = calls[2];
		expect(rouletteReceiptCall.args[1]).toBe('roulette');
		const after = Math.trunc(
			(Date.now() - ROULETTE_RECEIPT_RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000,
		);
		expect(rouletteReceiptCall.args[0]).toBeGreaterThanOrEqual(before);
		expect(rouletteReceiptCall.args[0]).toBeLessThanOrEqual(after);
	});

	test('roulette receipt retention window is longer than the round retention window', async () => {
		// Tombstones must outlive roulette_round rows so a replay after
		// round reaping is still rejected.
		expect(ROULETTE_RECEIPT_RETENTION_DAYS).toBeGreaterThan(RETENTION_DAYS);
	});

	test('uses a retention cutoff of 30 days in seconds for round and non-roulette receipts', async () => {
		const { binding, calls } = createMockDbBinding();
		const before = Math.trunc((Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000);
		await runRetentionCleanup(binding);
		const after = Math.trunc((Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000) / 1000);
		expect(calls[0].args[0]).toBeGreaterThanOrEqual(before);
		expect(calls[0].args[0]).toBeLessThanOrEqual(after);
		expect(calls[1].args[0]).toBeGreaterThanOrEqual(before);
		expect(calls[1].args[0]).toBeLessThanOrEqual(after);
	});

	test('reaps mission_progress and mission_override by a 30-day-ago YYYY-MM-DD period key', async () => {
		// Freeze the clock so the cutoff is deterministic — both the
		// cleanup code and the expected-value derivation read from the
		// same instant, so the assertion is exact even at midnight UTC.
		const fixedMs = Date.UTC(2026, 6, 15, 12, 30, 0);
		const RealDate = globalThis.Date;
		globalThis.Date = class extends RealDate {
			constructor(...args: number[]) {
				if (args.length === 0) {
					super(fixedMs);
				} else {
					super(...args);
				}
			}
			static now() {
				return fixedMs;
			}
		} as unknown as DateConstructor;
		try {
			const { binding, calls } = createMockDbBinding();
			await runRetentionCleanup(binding);
			const expected = (() => {
				const d = new RealDate(fixedMs);
				d.setUTCDate(d.getUTCDate() - RETENTION_DAYS);
				return d.toISOString().slice(0, 10);
			})();
			// Both mission deletes use the same YYYY-MM-DD cutoff string,
			// computed deterministically from the frozen instant. The SQL
			// includes an explicit daily-only predicate (LIKE '____-__-__')
			// so weekly keys (YYYY-Www) are never matched regardless of
			// lexicographic ordering or year boundaries.
			expect(calls[3].sql).toBe(
				"DELETE FROM mission_progress WHERE periodKey < ? AND periodKey LIKE '____-__-__'",
			);
			expect(calls[4].sql).toBe(
				"DELETE FROM mission_override WHERE periodKey < ? AND periodKey LIKE '____-__-__'",
			);
			expect(calls[5].sql).toBe(
				"DELETE FROM mission_game_tried WHERE periodKey < ? AND periodKey LIKE '____-__-__'",
			);
			expect(typeof calls[3].args[0]).toBe('string');
			expect(calls[3].args[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(calls[4].args[0]).toBe(calls[3].args[0]);
			expect(calls[5].args[0]).toBe(calls[3].args[0]);
			expect(calls[3].args[0]).toBe(expected);
		} finally {
			globalThis.Date = RealDate;
		}
	});

	test('isDailyPeriodKey distinguishes daily from weekly keys across year boundaries', () => {
		// Daily keys: YYYY-MM-DD format
		expect(isDailyPeriodKey('2025-12-31')).toBe(true);
		expect(isDailyPeriodKey('2026-01-01')).toBe(true);
		expect(isDailyPeriodKey('2026-07-15')).toBe(true);
		expect(isDailyPeriodKey('2024-02-29')).toBe(true); // leap day
		// Weekly keys: YYYY-Www format — must NOT match the daily predicate
		expect(isDailyPeriodKey('2025-W52')).toBe(false);
		expect(isDailyPeriodKey('2026-W01')).toBe(false);
		expect(isDailyPeriodKey('2026-W26')).toBe(false);
		// Malformed / empty
		expect(isDailyPeriodKey('')).toBe(false);
		expect(isDailyPeriodKey('2026-07-15T12:00:00Z')).toBe(false);
		expect(isDailyPeriodKey('2026-7-5')).toBe(false);
	});

	test('swallows errors from roulette_round delete and still cleans chip_sync_receipt', async () => {
		let receiptDeleted = false;
		let rouletteReceiptDeleted = false;
		const binding = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							run: async () => {
								if (sql.startsWith('DELETE FROM roulette_round')) {
									throw new Error('D1 error');
								}
								if (sql.includes('gameType = ?')) {
									rouletteReceiptDeleted = true;
									return { meta: { changes: 1 } };
								}
								receiptDeleted = true;
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		await runRetentionCleanup(binding);
		expect(receiptDeleted).toBe(true);
		expect(rouletteReceiptDeleted).toBe(true);
	});

	test('swallows errors from the 30-day chip_sync_receipt delete and still runs the roulette pass', async () => {
		let rouletteRoundDeleted = false;
		let rouletteReceiptDeleted = false;
		const binding = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							run: async () => {
								if (sql.startsWith('DELETE FROM roulette_round')) {
									rouletteRoundDeleted = true;
									return { meta: { changes: 1 } };
								}
								if (sql.includes('gameType NOT IN')) {
									throw new Error('D1 error');
								}
								if (sql.includes('gameType = ?')) {
									rouletteReceiptDeleted = true;
									return { meta: { changes: 1 } };
								}
								return { meta: { changes: 0 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		await runRetentionCleanup(binding);
		expect(rouletteRoundDeleted).toBe(true);
		expect(rouletteReceiptDeleted).toBe(true);
	});

	test('swallows errors from the roulette receipt delete', async () => {
		let rouletteRoundDeleted = false;
		let receiptDeleted = false;
		const binding = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							run: async () => {
								if (sql.startsWith('DELETE FROM roulette_round')) {
									rouletteRoundDeleted = true;
									return { meta: { changes: 1 } };
								}
								if (sql.includes('gameType = ?')) {
									throw new Error('D1 error');
								}
								receiptDeleted = true;
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		await runRetentionCleanup(binding);
		expect(rouletteRoundDeleted).toBe(true);
		expect(receiptDeleted).toBe(true);
	});

	test('swallows errors from the mission_progress delete and still reaps mission_override and mission_game_tried', async () => {
		let overrideDeleted = false;
		let gameTriedDeleted = false;
		const binding = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							run: async () => {
								if (sql.startsWith('DELETE FROM mission_progress')) {
									throw new Error('D1 error');
								}
								if (sql.startsWith('DELETE FROM mission_override')) {
									overrideDeleted = true;
									return { meta: { changes: 1 } };
								}
								if (sql.startsWith('DELETE FROM mission_game_tried')) {
									gameTriedDeleted = true;
									return { meta: { changes: 1 } };
								}
								return { meta: { changes: 0 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		await runRetentionCleanup(binding);
		expect(overrideDeleted).toBe(true);
		expect(gameTriedDeleted).toBe(true);
	});

	test('swallows errors from the mission_override delete and still reaps mission_game_tried', async () => {
		let progressDeleted = false;
		let gameTriedDeleted = false;
		const binding = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							run: async () => {
								if (sql.startsWith('DELETE FROM mission_progress')) {
									progressDeleted = true;
									return { meta: { changes: 1 } };
								}
								if (sql.startsWith('DELETE FROM mission_override')) {
									throw new Error('D1 error');
								}
								if (sql.startsWith('DELETE FROM mission_game_tried')) {
									gameTriedDeleted = true;
									return { meta: { changes: 1 } };
								}
								return { meta: { changes: 0 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		await runRetentionCleanup(binding);
		expect(progressDeleted).toBe(true);
		expect(gameTriedDeleted).toBe(true);
	});

	test('swallows errors from the mission_game_tried delete', async () => {
		let progressDeleted = false;
		let overrideDeleted = false;
		const binding = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							run: async () => {
								if (sql.startsWith('DELETE FROM mission_progress')) {
									progressDeleted = true;
									return { meta: { changes: 1 } };
								}
								if (sql.startsWith('DELETE FROM mission_override')) {
									overrideDeleted = true;
									return { meta: { changes: 1 } };
								}
								if (sql.startsWith('DELETE FROM mission_game_tried')) {
									throw new Error('D1 error');
								}
								return { meta: { changes: 0 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		await runRetentionCleanup(binding);
		expect(progressDeleted).toBe(true);
		expect(overrideDeleted).toBe(true);
	});
});

describe('runScheduledJobs', () => {
	function scheduledHarness(
		overrides: Partial<ScheduledJobDeps> = {},
		env: Parameters<typeof runScheduledJobs>[0] = {
			DB: {} as D1Database,
			arcturus: {} as DurableObjectNamespace,
		},
	) {
		const events: string[] = [];
		const warnings: string[] = [];
		const deps: ScheduledJobDeps = {
			async rankedExpiration(_db, _namespace) {
				events.push('ranked-expiration');
			},
			async rankedRateCleanup(_db, _nowSeconds) {
				events.push('ranked-rate-cleanup');
			},
			async retentionCleanup(_db) {
				events.push('retention-cleanup');
			},
			async dailyChallengeExpiration(_db, _nowSeconds) {
				events.push('daily-expiration');
			},
			async dailyChallengeRetention(_db, _nowSeconds) {
				events.push('daily-retention');
			},
			nowSeconds: () => 1_750_000_000,
			warn(message, _error) {
				warnings.push(message);
			},
			...overrides,
		};
		return {
			events,
			warnings,
			run: () => runScheduledJobs(env, deps),
		};
	}

	test('runs ranked, retention, and daily challenge jobs in their scheduled order', async () => {
		const harness = scheduledHarness();

		await harness.run();

		expect(harness.events).toEqual([
			'ranked-expiration',
			'ranked-rate-cleanup',
			'retention-cleanup',
			'daily-expiration',
			'daily-retention',
		]);
	});

	test('a ranked expiration failure does not suppress later jobs', async () => {
		const harness = scheduledHarness({
			async rankedExpiration() {
				harness.events.push('ranked-expiration');
				throw new Error('ranked failure');
			},
		});

		await harness.run();

		expect(harness.events).toEqual([
			'ranked-expiration',
			'ranked-rate-cleanup',
			'retention-cleanup',
			'daily-expiration',
			'daily-retention',
		]);
		expect(harness.warnings).toEqual(['[SCHEDULED] Ranked expiration failed']);
	});

	test('a rate cleanup failure does not suppress later jobs', async () => {
		const harness = scheduledHarness({
			async rankedRateCleanup() {
				harness.events.push('ranked-rate-cleanup');
				throw new Error('rate failure');
			},
		});

		await harness.run();

		expect(harness.events).toEqual([
			'ranked-expiration',
			'ranked-rate-cleanup',
			'retention-cleanup',
			'daily-expiration',
			'daily-retention',
		]);
		expect(harness.warnings).toEqual(['[SCHEDULED] Ranked rate-limit cleanup failed']);
	});

	test('a global retention failure does not suppress daily challenge jobs', async () => {
		const harness = scheduledHarness({
			async retentionCleanup() {
				harness.events.push('retention-cleanup');
				throw new Error('retention failure');
			},
		});

		await harness.run();

		expect(harness.events).toEqual([
			'ranked-expiration',
			'ranked-rate-cleanup',
			'retention-cleanup',
			'daily-expiration',
			'daily-retention',
		]);
		expect(harness.warnings).toEqual(['[SCHEDULED] Retention cleanup failed']);
	});

	test('a daily challenge expiration failure does not suppress daily retention', async () => {
		const harness = scheduledHarness({
			async dailyChallengeExpiration() {
				harness.events.push('daily-expiration');
				throw new Error('daily expiration failure');
			},
		});

		await harness.run();

		expect(harness.events).toEqual([
			'ranked-expiration',
			'ranked-rate-cleanup',
			'retention-cleanup',
			'daily-expiration',
			'daily-retention',
		]);
		expect(harness.warnings).toEqual(['[SCHEDULED] Daily Challenge expiration failed']);
	});

	test('a daily challenge retention failure is isolated to its own scheduled job', async () => {
		const harness = scheduledHarness({
			async dailyChallengeRetention() {
				harness.events.push('daily-retention');
				throw new Error('daily retention failure');
			},
		});

		await harness.run();

		expect(harness.events).toEqual([
			'ranked-expiration',
			'ranked-rate-cleanup',
			'retention-cleanup',
			'daily-expiration',
			'daily-retention',
		]);
		expect(harness.warnings).toEqual(['[SCHEDULED] Daily Challenge retention failed']);
	});

	test('missing DB logs once and skips every scheduled job', async () => {
		const harness = scheduledHarness({}, {});

		await harness.run();

		expect(harness.events).toEqual([]);
		expect(harness.warnings).toEqual(['[SCHEDULED] DB binding unavailable, skipping cleanup']);
	});
});
