import { describe, expect, test } from 'bun:test';
import { runRetentionCleanup, RETENTION_DAYS } from './cleanup';

interface PreparedCall {
	sql: string;
	args: unknown[];
}

function createMockDbBinding() {
	const calls: PreparedCall[] = [];
	const runResults: Record<string, { meta: { changes: number } }> = {
		'DELETE FROM roulette_round': { meta: { changes: 5 } },
		'DELETE FROM chip_sync_receipt': { meta: { changes: 3 } },
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
	test('deletes from both roulette_round and chip_sync_receipt', async () => {
		const { binding, calls } = createMockDbBinding();
		await runRetentionCleanup(binding);
		expect(calls).toHaveLength(2);
		expect(calls[0].sql).toBe('DELETE FROM roulette_round WHERE createdAt < ?');
		expect(calls[1].sql).toBe(
			'DELETE FROM chip_sync_receipt WHERE createdAt < ? AND gameType NOT IN (?, ?)',
		);
	});

	test('excludes poker_mp and roulette receipts from the chip_sync_receipt delete', async () => {
		const { binding, calls } = createMockDbBinding();
		await runRetentionCleanup(binding);
		const receiptCall = calls[1];
		expect(receiptCall.args[1]).toBe('poker_mp');
		expect(receiptCall.args[2]).toBe('roulette');
	});

	test('uses a retention cutoff of 30 days in seconds', async () => {
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
		const binding = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							run: async () => {
								if (sql.startsWith('DELETE FROM roulette_round')) {
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
		expect(receiptDeleted).toBe(true);
	});

	test('swallows errors from chip_sync_receipt delete', async () => {
		let rouletteDeleted = false;
		const binding = {
			prepare(sql: string) {
				return {
					bind() {
						return {
							run: async () => {
								if (sql.startsWith('DELETE FROM chip_sync_receipt')) {
									throw new Error('D1 error');
								}
								rouletteDeleted = true;
								return { meta: { changes: 1 } };
							},
						};
					},
				};
			},
		} as unknown as D1Database;
		await runRetentionCleanup(binding);
		expect(rouletteDeleted).toBe(true);
	});
});
