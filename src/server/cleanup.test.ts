import { describe, expect, test } from 'bun:test';
import { runRetentionCleanup, RETENTION_DAYS, ROULETTE_RECEIPT_RETENTION_DAYS } from './cleanup';

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
		expect(calls).toHaveLength(3);
		expect(calls[0].sql).toBe('DELETE FROM roulette_round WHERE createdAt < ?');
		expect(calls[1].sql).toBe(
			'DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType NOT IN (?, ?)',
		);
		expect(calls[2].sql).toBe('DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType = ?');
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
