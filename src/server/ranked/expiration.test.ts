import { describe, expect, test } from 'bun:test';
import { RankedServiceError } from '../../lib/ranked/protocol';
import type { RankedLogEntry } from './logging';
import { runRankedExpiration, runRankedRateLimitCleanup } from './expiration';

interface PreparedCall {
	sql: string;
	args: unknown[];
}

// Each id is assigned a monotonically increasing expiresAt so the array
// index matches the ORDER BY expiresAt ASC, id ASC ordering used by the
// real query, and the cursor pagination can advance forward through it.
function rowFor(id: string, index: number): { id: string; expiresAt: number } {
	return { id, expiresAt: 1_740_000_000 + index };
}

function createExpirationDb(ids: readonly string[]) {
	const calls: PreparedCall[] = [];
	const rowsByIndex = ids.map((id, index) => rowFor(id, index));
	const binding = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							calls.push({ sql, args });
							// Cursor pagination: when a cursor is supplied (4 bind args:
							// nowSeconds, cursorExpiresAt, cursorExpiresAt, cursorId),
							// return only rows after that cursor. The first call has 1
							// bind arg (nowSeconds only) and returns the first page.
							if (args.length === 4) {
								const cursorExpiresAt = args[1] as number;
								const cursorId = args[3] as string;
								const filtered = rowsByIndex.filter(
									(row) =>
										row.expiresAt > cursorExpiresAt ||
										(row.expiresAt === cursorExpiresAt && row.id > cursorId),
								);
								return { results: filtered };
							}
							return { results: rowsByIndex };
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

// Simulates paginated listExpiredSessions: each all() call returns the next
// page of IDs. When all pages are exhausted, returns empty. This mirrors the
// real D1 behaviour where expired sessions are removed from the active set
// after expire() succeeds, so subsequent queries return the next batch.
function createPaginatedExpirationDb(totalIds: readonly string[], pageSize = 100) {
	const calls: PreparedCall[] = [];
	let page = 0;
	const rowsByIndex = totalIds.map((id, index) => rowFor(id, index));
	const binding = {
		prepare(sql: string) {
			return {
				bind(...args: unknown[]) {
					return {
						async all() {
							calls.push({ sql, args });
							const start = page * pageSize;
							const pageIds = rowsByIndex.slice(start, start + pageSize);
							page += 1;
							return { results: pageIds };
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
		expect(calls[0].sql).toContain('SELECT id, expiresAt');
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

	test('does not log ranked_session_expired when expire returns an active status', async () => {
		const { binding } = createExpirationDb(['still-active']);
		const logs: RankedLogEntry[] = [];

		await runRankedExpiration(binding, {
			expire: async () => ({ status: 'active' }),
			nowSeconds: () => 1_750_000_000,
			log: (entry) => logs.push(entry),
		});

		expect(logs).toEqual([]);
	});

	test('logs ranked_session_expired when expire returns a settled status', async () => {
		const { binding } = createExpirationDb(['settled-now']);
		const logs: RankedLogEntry[] = [];

		await runRankedExpiration(binding, {
			expire: async () => ({ status: 'settled' }),
			nowSeconds: () => 1_750_000_000,
			log: (entry) => logs.push(entry),
		});

		expect(logs.map(({ event }) => event)).toEqual(['ranked_session_expired']);
	});

	test('does not log ranked_invariant_violation for expected MULTIPLAYER_CONFLICT errors', async () => {
		const { binding } = createExpirationDb(['conflict-session']);
		const logs: RankedLogEntry[] = [];
		const warnings: string[] = [];

		await runRankedExpiration(binding, {
			expire: async () => {
				throw new RankedServiceError('MULTIPLAYER_CONFLICT');
			},
			nowSeconds: () => 1_750_000_000,
			log: (entry) => logs.push(entry),
			warn: (message) => warnings.push(message),
		});

		expect(logs).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('MULTIPLAYER_CONFLICT');
	});

	test('does not log ranked_invariant_violation for ACCOUNT_BALANCE_CHANGED (benign casual-play race)', async () => {
		const { binding } = createExpirationDb(['balance-race-session']);
		const logs: RankedLogEntry[] = [];
		const warnings: string[] = [];

		await runRankedExpiration(binding, {
			expire: async () => {
				throw new RankedServiceError('ACCOUNT_BALANCE_CHANGED');
			},
			nowSeconds: () => 1_750_000_000,
			log: (entry) => logs.push(entry),
			warn: (message) => warnings.push(message),
		});

		// Concurrent casual play changing chipBalance between expiration
		// retry snapshots is a benign race, not an invariant violation.
		expect(logs).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('ACCOUNT_BALANCE_CHANGED');
	});

	test('logs ranked_invariant_violation and warns for unexpected errors', async () => {
		const { binding } = createExpirationDb(['unexpected']);
		const logs: RankedLogEntry[] = [];
		const warnings: string[] = [];

		await runRankedExpiration(binding, {
			expire: async () => {
				throw new Error('unexpected failure');
			},
			nowSeconds: () => 1_750_000_000,
			log: (entry) => logs.push(entry),
			warn: (message) => warnings.push(message),
		});

		expect(logs.map(({ event }) => event)).toEqual(['ranked_invariant_violation']);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('unexpected expiration failure');
	});

	test('drains more than one page of expired sessions when the backlog exceeds the page size', async () => {
		const totalIds = Array.from({ length: 250 }, (_, i) => `session-${String(i).padStart(3, '0')}`);
		const { binding, calls } = createPaginatedExpirationDb(totalIds);
		const attempted: string[] = [];

		await runRankedExpiration(binding, {
			expire: async (sessionId) => {
				attempted.push(sessionId);
			},
			nowSeconds: () => 1_750_000_000,
			log: () => undefined,
		});

		expect(attempted).toEqual(totalIds);
		// Three pages: 100 + 100 + 50.
		expect(calls.filter((c) => c.sql.includes('SELECT id'))).toHaveLength(3);
	});

	test('stops draining when the wall-clock time budget is exceeded', async () => {
		const totalIds = Array.from({ length: 250 }, (_, i) => `session-${i}`);
		const { binding } = createPaginatedExpirationDb(totalIds);
		const attempted: string[] = [];
		let clockMs = 0;

		await runRankedExpiration(binding, {
			expire: async (sessionId) => {
				attempted.push(sessionId);
				clockMs += 10;
			},
			nowSeconds: () => 1_750_000_000,
			timeBudgetMs: 50,
			nowMs: () => clockMs,
			log: () => undefined,
		});

		// The deadline is checked before each expiration. Budget deadline is
		// 0 + 50 = 50ms; each expire advances the clock by 10ms. So sessions
		// 0..4 are attempted (clock 0,10,20,30,40 -> all < 50), and session 5
		// sees clock=50 >= deadline and stops the inner loop immediately.
		expect(attempted).toHaveLength(5);
		expect(attempted).toEqual(totalIds.slice(0, 5));
	});

	test('stops when every session in a page is unprocessable to avoid a busy loop', async () => {
		const ids = Array.from({ length: 100 }, (_, i) => `session-${i}`);
		// createExpirationDb returns the 100 rows on the first call, then
		// filters by cursor on subsequent calls (returning empty once the
		// cursor has advanced past every row).
		const { binding } = createExpirationDb(ids);
		const attempted: string[] = [];

		await runRankedExpiration(binding, {
			expire: async (sessionId) => {
				attempted.push(sessionId);
				throw new Error('unprocessable');
			},
			nowSeconds: () => 1_750_000_000,
			log: () => undefined,
			warn: () => undefined,
		});

		// Each session attempted exactly once. The cursor advances past
		// every attempted row, so the next query returns no rows and the
		// loop stops rather than re-querying the same unprocessable rows.
		expect(attempted).toEqual(ids);
	});

	test('advances past a full page of poison rows and still attempts later sessions', async () => {
		// 100 oldest rows all fail, followed by 50 processable rows. Without
		// cursor advancement, the first 100 poison rows would be returned by
		// every page query and the 50 later rows would never be reached.
		const poisonIds = Array.from({ length: 100 }, (_, i) => `poison-${i}`);
		const goodIds = Array.from({ length: 50 }, (_, i) => `good-${i}`);
		const allIds = [...poisonIds, ...goodIds];
		const { binding } = createExpirationDb(allIds);
		const attempted: string[] = [];
		const logs: RankedLogEntry[] = [];

		await runRankedExpiration(binding, {
			expire: async (sessionId) => {
				attempted.push(sessionId);
				if (sessionId.startsWith('poison-')) throw new Error('corrupt row');
			},
			nowSeconds: () => 1_750_000_000,
			log: (entry) => logs.push(entry),
			warn: () => undefined,
		});

		// Every row is attempted exactly once: the 100 poison rows fail, the
		// cursor advances past them, and the 50 good rows are then returned
		// and processed successfully.
		expect(attempted).toEqual(allIds);
		expect(attempted.filter((id) => id.startsWith('good-'))).toEqual(goodIds);
		// 100 invariant violations for poison rows + 50 successful expirations.
		expect(logs.filter((entry) => entry.event === 'ranked_invariant_violation')).toHaveLength(100);
		expect(logs.filter((entry) => entry.event === 'ranked_session_expired')).toHaveLength(50);
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
