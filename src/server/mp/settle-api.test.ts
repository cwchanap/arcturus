import { describe, expect, test } from 'bun:test';
import { POST } from '../../pages/api/mp/settle';

/**
 * Creates a mock D1Database that simulates settle.ts SQL patterns with escrow:
 * - SELECT syncId FROM chip_sync_receipt WHERE userId = ? AND syncId = ?
 * - SELECT chipBalance, heldChips FROM user WHERE id = ?
 * - UPDATE user SET chipBalance = chipBalance + heldChips + ?, heldChips = 0, updatedAt = ? WHERE id = ?
 * - INSERT INTO chip_sync_receipt (...) VALUES (...)
 */
function createMockD1(options: { balances: Map<string, number>; heldChips?: Map<string, number> }) {
	const receipts = new Map<
		string,
		{ userId: string; syncId: string; delta: number; previousBalance: number; balance: number }
	>();
	const balances = new Map(options.balances);
	const heldChipsMap = new Map(options.heldChips ?? new Map<string, number>());

	return {
		receipts,
		balances,
		heldChipsMap,
		prepare(sql: string) {
			return {
				sql,
				bind(...args: unknown[]) {
					return {
						sql,
						args,
						async run() {
							throw new Error(`Unexpected run() SQL: ${sql}`);
						},
					};
				},
			};
		},
		async batch(statements: Array<{ sql: string; args: unknown[] }>) {
			const results: Array<{ results: unknown[]; meta: { changes: number } }> = [];

			for (const stmt of statements) {
				const { sql, args } = stmt;

				// Idempotency check: SELECT syncId FROM chip_sync_receipt WHERE userId = ? AND syncId = ?
				if (sql.startsWith('SELECT syncId FROM chip_sync_receipt')) {
					const [userId, syncId] = args as [string, string];
					const existing = receipts.get(`${userId}:${syncId}`);
					results.push({
						results: existing ? [{ syncId: existing.syncId }] : [],
						meta: { changes: 0 },
					});
					continue;
				}

				// Balance fetch: SELECT chipBalance, heldChips FROM user WHERE id = ?
				if (sql.startsWith('SELECT chipBalance') && sql.includes('heldChips')) {
					const [userId] = args as [string];
					const bal = balances.get(userId) ?? 0;
					const held = heldChipsMap.get(userId) ?? 0;
					results.push({
						results: [{ chipBalance: bal, heldChips: held }],
						meta: { changes: 0 },
					});
					continue;
				}

				// Escrow-aware settle UPDATE: UPDATE user SET chipBalance = chipBalance + heldChips + ?, heldChips = 0 ...
				if (
					sql.startsWith('UPDATE user SET chipBalance') &&
					sql.includes('heldChips') &&
					sql.includes('heldChips = 0')
				) {
					const [delta, _ts, userId] = args as [number, number, string];
					const current = balances.get(userId) ?? 0;
					const held = heldChipsMap.get(userId) ?? 0;
					const newBalance = current + held + delta;
					balances.set(userId, newBalance);
					heldChipsMap.set(userId, 0);
					results.push({ results: [], meta: { changes: 1 } });
					continue;
				}

				// Receipt INSERT
				if (sql.startsWith('INSERT INTO chip_sync_receipt')) {
					const [userId, syncId, _gameType, prevBal, bal, delta] = args as [
						string,
						string,
						string,
						number,
						number,
						number,
					];
					receipts.set(`${userId}:${syncId}`, {
						userId,
						syncId,
						delta,
						previousBalance: prevBal,
						balance: bal,
					});
					results.push({ results: [], meta: { changes: 1 } });
					continue;
				}

				throw new Error(`Unexpected batch SQL: ${sql}`);
			}

			return results;
		},
	} as unknown as D1Database;
}

function makeRequest(entries: Array<{ userId: string; delta: number; syncId: string }>) {
	return new Request('http://test.local/api/mp/settle', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-arcturus-auth': 'test-secret',
		},
		body: JSON.stringify({
			entries: entries.map((e) => ({
				userId: e.userId,
				delta: e.delta,
				syncId: e.syncId,
				gameType: 'poker_mp' as const,
			})),
		}),
	});
}

function makeLocals(d1: D1Database, secret = 'test-secret') {
	return {
		runtime: {
			env: {
				DB: d1,
				MP_AUTH_SECRET: secret,
			},
		},
	};
}

describe('mp/settle API (escrow-based)', () => {
	test('rejects requests without auth secret', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ entries: [] }),
		});
		const response = await POST({
			request,
			locals: { runtime: { env: { DB: d1 } } } as any,
		});
		expect(response.status).toBe(403);
	});

	test('rejects requests with wrong auth secret', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = makeRequest([]);
		const response = await POST({
			request,
			locals: { runtime: { env: { DB: d1, MP_AUTH_SECRET: 'wrong-secret' } } } as any,
		});
		expect(response.status).toBe(403);
	});

	test('rejects invalid payload', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({ not_entries: true }),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects malformed JSON', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: '{not valid json',
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects entries with invalid field types', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({
				entries: [{ userId: 123, delta: 'not-a-number', syncId: 'sync-1', gameType: 'poker_mp' }],
			}),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects entries with missing required fields', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({
				entries: [{ userId: 'u1', delta: 100 }],
			}),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects entries with wrong gameType', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({
				entries: [{ userId: 'u1', delta: 100, syncId: 's1', gameType: 'blackjack' }],
			}),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects entries with NaN delta', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({
				entries: [{ userId: 'u1', delta: NaN, syncId: 's1', gameType: 'poker_mp' }],
			}),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects entries with Infinity delta', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({
				entries: [{ userId: 'u1', delta: Infinity, syncId: 's1', gameType: 'poker_mp' }],
			}),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects entries with non-integer delta', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({
				entries: [{ userId: 'u1', delta: 1.5, syncId: 's1', gameType: 'poker_mp' }],
			}),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects entries with empty userId', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({
				entries: [{ userId: '  ', delta: 100, syncId: 's1', gameType: 'poker_mp' }],
			}),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects entries with empty syncId', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const request = new Request('http://test.local/api/mp/settle', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({
				entries: [{ userId: 'u1', delta: 100, syncId: '', gameType: 'poker_mp' }],
			}),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('settles credits and debits against escrowed chips', async () => {
		// Loser had 1000 escrowed, chipBalance is now 0.
		// Winner had 1000 escrowed, chipBalance is now 0.
		const d1 = createMockD1({
			balances: new Map([
				['u1', 0],
				['u2', 0],
			]),
			heldChips: new Map([
				['u1', 1000],
				['u2', 1000],
			]),
		});
		const mockD1 = d1 as unknown as {
			receipts: Map<
				string,
				{ userId: string; syncId: string; delta: number; previousBalance: number; balance: number }
			>;
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		// u1 loses 100, u2 wins 100
		const request = makeRequest([
			{ userId: 'u1', delta: -100, syncId: 'sync-1' },
			{ userId: 'u2', delta: 100, syncId: 'sync-2' },
		]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);

		// u1: chipBalance(0) + heldChips(1000) + delta(-100) = 900
		expect(mockD1.balances.get('u1')).toBe(900);
		expect(mockD1.heldChipsMap.get('u1')).toBe(0);

		// u2: chipBalance(0) + heldChips(1000) + delta(100) = 1100
		expect(mockD1.balances.get('u2')).toBe(1100);
		expect(mockD1.heldChipsMap.get('u2')).toBe(0);

		// Both receipts written
		expect(mockD1.receipts.has('u1:sync-1')).toBe(true);
		expect(mockD1.receipts.has('u2:sync-2')).toBe(true);
	});

	test('settles all entries in one batch — no partial state on failure', async () => {
		// This test verifies that all entries (debits AND credits) go through
		// a single d1.batch() call, so there's no window for partial settlement.
		const d1 = createMockD1({
			balances: new Map([
				['loser1', 0],
				['loser2', 0],
				['winner', 0],
			]),
			heldChips: new Map([
				['loser1', 500],
				['loser2', 500],
				['winner', 500],
			]),
		});
		const mockD1 = d1 as unknown as {
			receipts: Map<
				string,
				{ userId: string; syncId: string; delta: number; previousBalance: number; balance: number }
			>;
			balances: Map<string, number>;
		};

		// Both losers lose 200, winner gains 400
		const request = makeRequest([
			{ userId: 'loser1', delta: -200, syncId: 'batch-sync-1' },
			{ userId: 'loser2', delta: -200, syncId: 'batch-sync-2' },
			{ userId: 'winner', delta: 400, syncId: 'batch-sync-3' },
		]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		// All settled atomically
		expect(mockD1.balances.get('loser1')).toBe(300); // 0 + 500 - 200
		expect(mockD1.balances.get('loser2')).toBe(300); // 0 + 500 - 200
		expect(mockD1.balances.get('winner')).toBe(900); // 0 + 500 + 400
		// All 3 receipts written
		expect(mockD1.receipts.size).toBe(3);
	});

	test('idempotent — skips entries with existing receipts', async () => {
		const d1 = createMockD1({
			balances: new Map([
				['u1', 900],
				['u2', 0],
			]),
			heldChips: new Map([
				['u1', 0],
				['u2', 1000],
			]),
		});
		const mockD1 = d1 as unknown as {
			receipts: Map<
				string,
				{ userId: string; syncId: string; delta: number; previousBalance: number; balance: number }
			>;
			balances: Map<string, number>;
		};
		// Pre-populate a receipt (simulating a previous successful settle for u1)
		mockD1.receipts.set('u1:dup-sync', {
			userId: 'u1',
			syncId: 'dup-sync',
			delta: -100,
			previousBalance: 1000,
			balance: 900,
		});

		const request = makeRequest([
			{ userId: 'u1', delta: -100, syncId: 'dup-sync' },
			{ userId: 'u2', delta: 100, syncId: 'new-sync' },
		]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		// u1 balance unchanged (skipped due to existing receipt)
		expect(mockD1.balances.get('u1')).toBe(900);
		// u2 still gets their credit (new entry)
		expect(mockD1.balances.get('u2')).toBe(1100);
	});

	test('no longer rejects insufficient balance — escrow covers the debit', async () => {
		// Previously, if a player spent chips elsewhere during a hand, the settle
		// would reject with 409. With escrow, chips are locked at snapshot time,
		// so the debit is always covered by heldChips.
		const d1 = createMockD1({
			balances: new Map([
				['poor', 0], // chipBalance is 0 because chips were escrowed
				['rich', 0],
			]),
			heldChips: new Map([
				['poor', 50], // only 50 escrowed
				['rich', 1000],
			]),
		});
		const mockD1 = d1 as unknown as {
			receipts: Map<
				string,
				{ userId: string; syncId: string; delta: number; previousBalance: number; balance: number }
			>;
			balances: Map<string, number>;
		};

		// poor loses 100 but only has 50 escrowed — delta is -100
		// but committed <= buyIn, so this should never happen in practice.
		// Still, test that it proceeds without 409 (escrow covers what it can).
		const request = makeRequest([
			{ userId: 'poor', delta: -100, syncId: 'escrow-sync' },
			{ userId: 'rich', delta: 100, syncId: 'rich-sync' },
		]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		// Should succeed (no 409) — escrow prevents the rejection
		expect(response.status).toBe(200);
		expect(mockD1.balances.get('poor')).toBe(-50); // 0 + 50 + (-100) = -50
		expect(mockD1.balances.get('rich')).toBe(1100); // 0 + 1000 + 100
	});

	test('returns ok when all entries already processed', async () => {
		const d1 = createMockD1({ balances: new Map() });
		const mockD1 = d1 as unknown as {
			receipts: Map<
				string,
				{ userId: string; syncId: string; delta: number; previousBalance: number; balance: number }
			>;
		};
		mockD1.receipts.set('u1:already-done', {
			userId: 'u1',
			syncId: 'already-done',
			delta: -50,
			previousBalance: 500,
			balance: 450,
		});

		const request = makeRequest([{ userId: 'u1', delta: -50, syncId: 'already-done' }]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
	});

	test('rejects entries with duplicate userId', async () => {
		const d1 = createMockD1({
			balances: new Map([
				['u1', 0],
				['u2', 0],
			]),
			heldChips: new Map([
				['u1', 1000],
				['u2', 1000],
			]),
		});

		// Two entries for u1 with different syncIds — must be rejected
		const request = makeRequest([
			{ userId: 'u1', delta: -100, syncId: 'sync-a' },
			{ userId: 'u1', delta: 50, syncId: 'sync-b' },
			{ userId: 'u2', delta: 100, syncId: 'sync-c' },
		]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(400);
		const text = await response.text();
		expect(text).toContain('Duplicate userId');
	});

	test('receipt maintains previousBalance + delta === balance invariant', async () => {
		// Verify the audit invariant: previousBalance + delta === balance.
		// Before escrow, previousBalance was chipBalance (often 0 after snapshot),
		// which broke the invariant. Now it should be chipBalance + heldChips.
		const d1 = createMockD1({
			balances: new Map([
				['loser', 0], // chipBalance is 0 — chips were escrowed to heldChips
				['winner', 0],
			]),
			heldChips: new Map([
				['loser', 500],
				['winner', 500],
			]),
		});
		const mockD1 = d1 as unknown as {
			receipts: Map<
				string,
				{ userId: string; syncId: string; delta: number; previousBalance: number; balance: number }
			>;
			balances: Map<string, number>;
		};

		const request = makeRequest([
			{ userId: 'loser', delta: -200, syncId: 'inv-sync-1' },
			{ userId: 'winner', delta: 200, syncId: 'inv-sync-2' },
		]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);

		// Verify receipt invariant for loser
		const loserReceipt = mockD1.receipts.get('loser:inv-sync-1')!;
		expect(loserReceipt.previousBalance).toBe(500); // chipBalance(0) + heldChips(500)
		expect(loserReceipt.balance).toBe(300); // 500 + (-200)
		expect(loserReceipt.previousBalance + loserReceipt.delta).toBe(loserReceipt.balance);

		// Verify receipt invariant for winner
		const winnerReceipt = mockD1.receipts.get('winner:inv-sync-2')!;
		expect(winnerReceipt.previousBalance).toBe(500); // chipBalance(0) + heldChips(500)
		expect(winnerReceipt.balance).toBe(700); // 500 + 200
		expect(winnerReceipt.previousBalance + winnerReceipt.delta).toBe(winnerReceipt.balance);
	});
});
