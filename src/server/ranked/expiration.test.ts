import { describe, expect, test } from 'bun:test';
import type { RankedLogEntry } from './logging';
import { runRankedExpiration, runRankedRateLimitCleanup } from './expiration';

interface PreparedCall {
	sql: string;
	args: unknown[];
}

function createExpirationDb(ids: readonly string[]) {
	const calls: PreparedCall[] = [];
	const binding = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							calls.push({ sql, args });
							return { results: ids.map((id) => ({ id })) };
						},
						async run() {
							calls.push({ sql, args });
							return { meta: { changes: 2 } };
						},
					};
				},
			};
		},
	};
	return { binding: binding as unknown as D1Database, calls };
}

describe('runRankedExpiration', () => {
	test('reads the bounded ordered session list once and attempts each returned ID in order', async () => {
		const { binding, calls } = createExpirationDb(['oldest', 'same-time-a', 'same-time-b']);
		const attempted: string[] = [];

		await runRankedExpiration(binding, {
			expire: async (sessionId) => {
				attempted.push(sessionId);
			},
			nowSeconds: () => 1_750_000_000,
			log: () => undefined,
		});

		expect(attempted).toEqual(['oldest', 'same-time-a', 'same-time-b']);
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toContain("WHERE status = 'active' AND expiresAt <= ?");
		expect(calls[0].sql).toContain('ORDER BY expiresAt ASC, id ASC');
		expect(calls[0].sql).toContain('LIMIT 100');
		expect(calls[0].args).toEqual([1_750_000_000]);
	});

	test('continues after a poison session and attempts later expirations', async () => {
		const { binding } = createExpirationDb(['oldest', 'poison-next']);
		const attempted: string[] = [];
		const logs: RankedLogEntry[] = [];

		await runRankedExpiration(binding, {
			expire: async (sessionId) => {
				attempted.push(sessionId);
				if (sessionId === 'oldest') throw new Error('corrupt row');
			},
			nowSeconds: () => 1_750_000_000,
			log: (entry) => logs.push(entry),
		});

		expect(attempted).toEqual(['oldest', 'poison-next']);
		expect(logs.map(({ event }) => event)).toEqual([
			'ranked_invariant_violation',
			'ranked_session_expired',
		]);
	});

	test('logs only redacted session references for success and poison rows', async () => {
		const rawIds = ['raw-session-poison', 'raw-session-success'];
		const { binding } = createExpirationDb(rawIds);
		const logs: RankedLogEntry[] = [];

		await runRankedExpiration(binding, {
			expire: async (sessionId) => {
				if (sessionId === rawIds[0]) throw new Error('contains raw-session-poison');
			},
			nowSeconds: () => 1_750_000_000,
			log: (entry) => logs.push(entry),
		});

		expect(logs).toHaveLength(2);
		for (const [index, entry] of logs.entries()) {
			expect(entry.sessionRef).toMatch(/^[0-9a-f]{12}$/);
			expect(entry.sessionRef).not.toBe(rawIds[index]);
			expect(JSON.stringify(entry)).not.toContain(rawIds[index]);
		}
	});
});

describe('runRankedRateLimitCleanup', () => {
	test('deletes only rate buckets whose expiry is at or before the supplied cutoff', async () => {
		const { binding, calls } = createExpirationDb([]);

		await runRankedRateLimitCleanup(binding, 1_750_000_123);

		expect(calls).toEqual([
			{
				sql: 'DELETE FROM ranked_rate_limit WHERE expiresAt <= ?',
				args: [1_750_000_123],
			},
		]);
	});
});
