import { describe, expect, test } from 'bun:test';
import { BlackjackRunServiceError } from './service';
import { runBlackjackRunExpiration } from './expiration';

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

// Simulates listExpiredPage: the first call (2 bind args: nowSeconds,
// limit) returns every row; cursor calls (5 bind args: nowSeconds,
// cursorExpiresAt, cursorExpiresAt, cursorId, limit) return only rows
// after the cursor, mirroring the repository's cursor SQL.
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
							if (args.length === 5) {
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
					};
				},
			};
		},
	};
	return { binding: binding as unknown as D1Database, calls };
}

// Simulates paginated listExpiredPage: each all() call returns the next
// page of rows. When all pages are exhausted, returns empty. This mirrors
// the real D1 behaviour where expired runs are removed from the active set
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
					};
				},
			};
		},
	};
	return { binding: binding as unknown as D1Database, calls };
}

describe('runBlackjackRunExpiration', () => {
	test('queries active expired runs with the (expiresAt, id) cursor and a fixed page size', async () => {
		const { binding, calls } = createExpirationDb(['oldest', 'same-time-a', 'same-time-b']);
		const attempted: string[] = [];

		await runBlackjackRunExpiration(binding, {
			expire: async (runId) => {
				attempted.push(runId);
			},
			nowSeconds: () => 1_750_000_000,
			log: () => undefined,
		});

		expect(attempted).toEqual(['oldest', 'same-time-a', 'same-time-b']);
		expect(calls).toHaveLength(1);
		expect(calls[0].sql).toContain("WHERE status = 'active' AND expiresAt <= ?");
		expect(calls[0].sql).toContain('ORDER BY expiresAt ASC, id ASC');
		expect(calls[0].sql).toContain('SELECT id, expiresAt');
		// (nowSeconds, limit): the scanner passes the bounded page size.
		expect(calls[0].args).toEqual([1_750_000_000, 100]);
	});

	test('advances the (expiresAt, id) cursor to the last attempted row before the next page query', async () => {
		// A full first page forces a second query; the cursor must point past
		// the last attempted row so the next page resumes after it.
		const ids = Array.from({ length: 100 }, (_, i) => `run-${String(i).padStart(3, '0')}`);
		const calls: PreparedCall[] = [];
		const rowsByIndex = ids.map((id, index) => rowFor(id, index));
		const binding = {
			prepare(sql: string) {
				return {
					bind(...args: unknown[]) {
						return {
							async all() {
								calls.push({ sql, args });
								if (args.length === 5) {
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
						};
					},
				};
			},
		} as unknown as D1Database;

		await runBlackjackRunExpiration(binding, {
			expire: async () => undefined,
			nowSeconds: () => 1_750_000_000,
			log: () => undefined,
		});

		expect(calls).toHaveLength(2);
		const lastRow = rowsByIndex[99];
		// Cursor binds: nowSeconds, cursorExpiresAt, cursorExpiresAt, cursorId, limit.
		expect(calls[1].args).toEqual([
			1_750_000_000,
			lastRow.expiresAt,
			lastRow.expiresAt,
			lastRow.id,
			100,
		]);
		expect(calls[1].sql).toContain('AND (expiresAt > ? OR (expiresAt = ? AND id > ?))');
	});

	test('continues after a poison run and attempts later expirations', async () => {
		const { binding } = createExpirationDb(['oldest', 'poison-next']);
		const attempted: string[] = [];
		const logs: string[] = [];

		await runBlackjackRunExpiration(binding, {
			expire: async (runId) => {
				attempted.push(runId);
				if (runId === 'oldest') throw new Error('corrupt row');
			},
			nowSeconds: () => 1_750_000_000,
			log: (event) => logs.push(event),
		});

		expect(attempted).toEqual(['oldest', 'poison-next']);
		expect(logs).toEqual(['blackjack_run_expiration_failed', 'blackjack_run_expired']);
	});

	test('logs blackjack_run_expired only for terminal results', async () => {
		const { binding } = createExpirationDb(['still-active', 'settled-now']);
		const logs: string[] = [];

		await runBlackjackRunExpiration(binding, {
			expire: async (runId) =>
				runId === 'still-active' ? { status: 'active' } : { status: 'settled' },
			nowSeconds: () => 1_750_000_000,
			log: (event) => logs.push(event),
		});

		expect(logs).toEqual(['blackjack_run_expired']);
	});

	test('a transient SETTLEMENT_CONFLICT is skipped with a warning and does not stop later rows', async () => {
		const { binding } = createExpirationDb(['conflict-row', 'later-row']);
		const attempted: string[] = [];
		const logs: string[] = [];
		const warnings: string[] = [];

		await runBlackjackRunExpiration(binding, {
			expire: async (runId) => {
				attempted.push(runId);
				if (runId === 'conflict-row') throw new BlackjackRunServiceError('SETTLEMENT_CONFLICT');
			},
			nowSeconds: () => 1_750_000_000,
			log: (event) => logs.push(event),
			warn: (message) => warnings.push(message),
		});

		expect(attempted).toEqual(['conflict-row', 'later-row']);
		expect(logs).toEqual(['blackjack_run_expired']);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('SETTLEMENT_CONFLICT');
	});

	test('the next invocation retries a still-active conflict row', async () => {
		const { binding } = createExpirationDb(['conflict-row']);
		const attempted: string[] = [];

		const deps = {
			expire: async (runId: string) => {
				attempted.push(runId);
				throw new BlackjackRunServiceError('SETTLEMENT_CONFLICT');
			},
			nowSeconds: () => 1_750_000_000,
			log: () => undefined,
			warn: () => undefined,
		};

		// The cursor is scoped to a single invocation, so the still-active
		// row is returned again by the next cron tick.
		await runBlackjackRunExpiration(binding, deps);
		await runBlackjackRunExpiration(binding, deps);

		expect(attempted).toEqual(['conflict-row', 'conflict-row']);
	});

	test('drains more than one page of expired runs when the backlog exceeds the page size', async () => {
		const totalIds = Array.from({ length: 250 }, (_, i) => `run-${String(i).padStart(3, '0')}`);
		const { binding, calls } = createPaginatedExpirationDb(totalIds);
		const attempted: string[] = [];

		await runBlackjackRunExpiration(binding, {
			expire: async (runId) => {
				attempted.push(runId);
			},
			nowSeconds: () => 1_750_000_000,
			log: () => undefined,
		});

		expect(attempted).toEqual(totalIds);
		// Three pages: 100 + 100 + 50.
		expect(calls.filter((c) => c.sql.includes('SELECT id'))).toHaveLength(3);
	});

	test('stops draining when the wall-clock time budget is exceeded', async () => {
		const totalIds = Array.from({ length: 250 }, (_, i) => `run-${i}`);
		const { binding } = createPaginatedExpirationDb(totalIds);
		const attempted: string[] = [];
		let clockMs = 0;

		await runBlackjackRunExpiration(binding, {
			expire: async (runId) => {
				attempted.push(runId);
				clockMs += 10;
			},
			nowSeconds: () => 1_750_000_000,
			timeBudgetMs: 50,
			nowMs: () => clockMs,
			log: () => undefined,
		});

		// The deadline is checked before each expiration. Budget deadline is
		// 0 + 50 = 50ms; each expire advances the clock by 10ms. So runs
		// 0..4 are attempted (clock 0,10,20,30,40 -> all < 50), and run 5
		// sees clock=50 >= deadline and stops the inner loop immediately.
		expect(attempted).toHaveLength(5);
		expect(attempted).toEqual(totalIds.slice(0, 5));
	});

	test('advances past a full page of poison rows and still attempts later runs', async () => {
		// 100 oldest rows all fail, followed by 50 processable rows. Without
		// cursor advancement, the first 100 poison rows would be returned by
		// every page query and the 50 later rows would never be reached.
		const poisonIds = Array.from({ length: 100 }, (_, i) => `poison-${i}`);
		const goodIds = Array.from({ length: 50 }, (_, i) => `good-${i}`);
		const allIds = [...poisonIds, ...goodIds];
		const { binding } = createExpirationDb(allIds);
		const attempted: string[] = [];
		const logs: string[] = [];

		await runBlackjackRunExpiration(binding, {
			expire: async (runId) => {
				attempted.push(runId);
				if (runId.startsWith('poison-')) throw new Error('corrupt row');
			},
			nowSeconds: () => 1_750_000_000,
			log: (event) => logs.push(event),
			warn: () => undefined,
		});

		// Every row is attempted exactly once: the 100 poison rows fail, the
		// cursor advances past them, and the 50 good rows are then returned
		// and processed successfully.
		expect(attempted).toEqual(allIds);
		expect(attempted.filter((id) => id.startsWith('good-'))).toEqual(goodIds);
		expect(logs.filter((event) => event === 'blackjack_run_expiration_failed')).toHaveLength(100);
		expect(logs.filter((event) => event === 'blackjack_run_expired')).toHaveLength(50);
	});

	test('stops when every run in a page is unprocessable to avoid a busy loop', async () => {
		const ids = Array.from({ length: 100 }, (_, i) => `run-${i}`);
		const { binding } = createExpirationDb(ids);
		const attempted: string[] = [];

		await runBlackjackRunExpiration(binding, {
			expire: async (runId) => {
				attempted.push(runId);
				throw new Error('unprocessable');
			},
			nowSeconds: () => 1_750_000_000,
			log: () => undefined,
			warn: () => undefined,
		});

		// Each run attempted exactly once. The cursor advances past every
		// attempted row, so the next query returns no rows and the loop
		// stops rather than re-querying the same unprocessable rows.
		expect(attempted).toEqual(ids);
	});
});
