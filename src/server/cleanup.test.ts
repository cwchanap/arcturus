import { describe, expect, test } from 'bun:test';
import {
	runRetentionCleanup,
	runScheduledJobs,
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
		expect(calls).toHaveLength(5);
		expect(calls[0].sql).toBe('DELETE FROM roulette_round WHERE createdAt < ?');
		expect(calls[1].sql).toBe(
			'DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType NOT IN (?, ?)',
		);
		expect(calls[2].sql).toBe('DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType = ?');
		expect(calls[3].sql).toBe('DELETE FROM mission_progress WHERE periodKey < ?');
		expect(calls[4].sql).toBe('DELETE FROM mission_override WHERE periodKey < ?');
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
		const { binding, calls } = createMockDbBinding();
		await runRetentionCleanup(binding);
		const expected = (() => {
			const d = new Date();
			d.setUTCDate(d.getUTCDate() - RETENTION_DAYS);
			return d.toISOString().slice(0, 10);
		})();
		// Both mission deletes use the same YYYY-MM-DD cutoff string, computed
		// deterministically from "30 days ago" in UTC. The cutoff format makes
		// lexicographic comparison meaningful for daily keys; weekly keys
		// (YYYY-Www) sort after any YYYY-MM-DD and so are deliberately spared.
		expect(typeof calls[3].args[0]).toBe('string');
		expect(calls[3].args[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(calls[4].args[0]).toBe(calls[3].args[0]);
		// Same calendar day as the directly-computed expected cutoff.
		expect(calls[3].args[0]).toBe(expected);
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

	test('runs ranked expiration, ranked rate cleanup, and retention cleanup in order', async () => {
		const harness = scheduledHarness();

		await harness.run();

		expect(harness.events).toEqual([
			'ranked-expiration',
			'ranked-rate-cleanup',
			'retention-cleanup',
		]);
	});

	test('a ranked expiration failure does not suppress rate or retention cleanup', async () => {
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
		]);
		expect(harness.warnings).toEqual(['[SCHEDULED] Ranked expiration failed']);
	});

	test('a rate cleanup failure does not suppress retention cleanup', async () => {
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
		]);
		expect(harness.warnings).toEqual(['[SCHEDULED] Ranked rate-limit cleanup failed']);
	});

	test('a retention failure is isolated to its own scheduled job', async () => {
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
		]);
		expect(harness.warnings).toEqual(['[SCHEDULED] Retention cleanup failed']);
	});

	test('missing DB logs once and skips every scheduled job', async () => {
		const harness = scheduledHarness({}, {});

		await harness.run();

		expect(harness.events).toEqual([]);
		expect(harness.warnings).toEqual(['[SCHEDULED] DB binding unavailable, skipping cleanup']);
	});
});
