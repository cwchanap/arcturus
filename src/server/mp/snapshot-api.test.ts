import { describe, expect, test } from 'bun:test';
import { POST } from '../../pages/api/mp/snapshot';

/**
 * Full mock D1 that handles both batch (escrow) and chained .all() (fetch).
 * Simulates mp_membership scoping via a membership map.
 */
function createFullMockD1(options: {
	balances: Map<string, number>;
	heldChips: Map<string, number>;
	memberships?: Map<string, string>; // userId -> roomCode
}) {
	const balances = new Map(options.balances);
	const heldChipsMap = new Map(options.heldChips);
	const memberships = new Map(options.memberships ?? []);

	function isMember(userId: string, roomCode: string): boolean {
		return memberships.get(userId) === roomCode;
	}

	return {
		balances,
		heldChipsMap,
		memberships,
		prepare(sql: string) {
			return {
				sql,
				bind(...args: unknown[]) {
					return {
						sql,
						args,
						async all() {
							// SELECT id, heldChips FROM user WHERE id IN (?,?,...)
							// AND EXISTS (SELECT 1 FROM mp_membership WHERE userId = user.id AND roomCode = ?)
							if (sql.includes('SELECT id, heldChips')) {
								const roomCode = args[args.length - 1] as string;
								const ids = args.slice(0, -1) as string[];
								const results = ids
									.filter((id) => isMember(id, roomCode))
									.map((id) => ({
										id,
										heldChips: heldChipsMap.get(id) ?? 0,
									}));
								return { results };
							}
							throw new Error(`Unexpected all() SQL: ${sql}`);
						},
					};
				},
			};
		},
		async batch(
			statements: Array<{ sql: string; args: unknown[] }>,
		): Promise<Array<{ results: unknown[]; meta: { changes: number } }>> {
			const results: Array<{ results: unknown[]; meta: { changes: number } }> = [];

			for (const stmt of statements) {
				const { sql, args } = stmt;

				if (sql.startsWith('UPDATE user SET heldChips') && sql.includes('chipBalance = 0')) {
					const [_ts, userId, _userIdAgain, roomCode] = args as [number, string, string, string];
					if (!isMember(userId, roomCode)) {
						results.push({ results: [], meta: { changes: 0 } });
						continue;
					}
					const currentBal = balances.get(userId) ?? 0;
					const currentHeld = heldChipsMap.get(userId) ?? 0;
					heldChipsMap.set(userId, currentBal + currentHeld);
					balances.set(userId, 0);
					results.push({ results: [], meta: { changes: 1 } });
					continue;
				}

				throw new Error(`Unexpected batch SQL: ${sql}`);
			}

			return results;
		},
	} as unknown as D1Database;
}

function makeRequest(userIds: string[], roomCode = 'ROOM01', secret = 'test-secret') {
	return new Request('http://test.local/api/mp/snapshot', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-arcturus-auth': secret,
		},
		body: JSON.stringify({ userIds, roomCode }),
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

describe('mp/snapshot API', () => {
	test('rejects requests without auth secret', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/snapshot', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ userIds: ['u1'] }),
		});
		const response = await POST({
			request,
			locals: { runtime: { env: { DB: d1 } } } as any,
		});
		expect(response.status).toBe(403);
	});

	test('rejects requests with wrong auth secret', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = makeRequest(['u1'], 'ROOM01', 'wrong-secret');
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(403);
	});

	test('rejects malformed JSON', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/snapshot', {
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

	test('rejects invalid payload', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/snapshot', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({ not_userIds: true }),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects userIds with non-string elements', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/snapshot', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({ userIds: [123, 'valid'] }),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('rejects empty string userIds', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/snapshot', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({ userIds: ['valid', '  '] }),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('returns empty balances for empty userIds array', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = makeRequest([]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body).toEqual({ balances: {} });
	});

	test('escrows chipBalance to heldChips for multiple users', async () => {
		const d1 = createFullMockD1({
			balances: new Map([
				['u1', 1000],
				['u2', 500],
			]),
			heldChips: new Map([
				['u1', 0],
				['u2', 0],
			]),
			memberships: new Map([
				['u1', 'ROOM01'],
				['u2', 'ROOM01'],
			]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['u1', 'u2']);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { balances: Record<string, number> };

		// Both users' chipBalance moved to heldChips
		expect(body.balances['u1']).toBe(1000);
		expect(body.balances['u2']).toBe(500);
		expect(mockD1.balances.get('u1')).toBe(0);
		expect(mockD1.balances.get('u2')).toBe(0);
		expect(mockD1.heldChipsMap.get('u1')).toBe(1000);
		expect(mockD1.heldChipsMap.get('u2')).toBe(500);
	});

	test('recovers stale heldChips from crashed room (self-healing)', async () => {
		// Scenario: previous DO crashed, leaving heldChips=100 from that room.
		// Player has since earned chipBalance=900 from single-player games.
		// Total bankroll = 1000. Snapshot should escrow everything.
		const d1 = createFullMockD1({
			balances: new Map([['u1', 900]]),
			heldChips: new Map([['u1', 100]]),
			memberships: new Map([['u1', 'ROOM01']]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['u1']);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { balances: Record<string, number> };

		// Full bankroll (900 + 100) escrowed as heldChips
		expect(body.balances['u1']).toBe(1000);
		expect(mockD1.balances.get('u1')).toBe(0);
		expect(mockD1.heldChipsMap.get('u1')).toBe(1000);
	});

	test('is idempotent — second snapshot with chipBalance=0 is a no-op', async () => {
		// First snapshot already moved everything
		const d1 = createFullMockD1({
			balances: new Map([['u1', 0]]),
			heldChips: new Map([['u1', 1000]]),
			memberships: new Map([['u1', 'ROOM01']]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['u1']);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { balances: Record<string, number> };

		// heldChips unchanged (0 + 1000 = 1000)
		expect(body.balances['u1']).toBe(1000);
		expect(mockD1.balances.get('u1')).toBe(0);
		expect(mockD1.heldChipsMap.get('u1')).toBe(1000);
	});

	test('handles single user snapshot', async () => {
		const d1 = createFullMockD1({
			balances: new Map([['only', 2500]]),
			heldChips: new Map([['only', 0]]),
			memberships: new Map([['only', 'ROOM01']]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['only']);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { balances: Record<string, number> };

		expect(body.balances['only']).toBe(2500);
		expect(mockD1.balances.get('only')).toBe(0);
		expect(mockD1.heldChipsMap.get('only')).toBe(2500);
	});

	test('rejects missing roomCode', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/snapshot', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({ userIds: ['u1'] }),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toMatch(/Invalid userIds or roomCode/);
	});

	test('rejects empty roomCode', async () => {
		const d1 = createFullMockD1({ balances: new Map(), heldChips: new Map() });
		const request = makeRequest(['u1'], '  ');
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
		const body = await response.json();
		expect(body.error).toMatch(/Invalid userIds or roomCode/);
	});

	test('skips users who have moved to another room (scoped by roomCode)', async () => {
		// u1 is in ROOM01, u2 has moved to ROOM02.
		const d1 = createFullMockD1({
			balances: new Map([
				['u1', 1000],
				['u2', 500],
			]),
			heldChips: new Map([
				['u1', 0],
				['u2', 0],
			]),
			memberships: new Map([
				['u1', 'ROOM01'],
				['u2', 'ROOM02'],
			]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['u1', 'u2']);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		const body = (await response.json()) as { balances: Record<string, number> };

		// Only u1 escrowed; u2 skipped because membership points at ROOM02
		expect(body.balances).toEqual({ u1: 1000 });
		expect(mockD1.balances.get('u1')).toBe(0);
		expect(mockD1.balances.get('u2')).toBe(500);
		expect(mockD1.heldChipsMap.get('u1')).toBe(1000);
		expect(mockD1.heldChipsMap.get('u2')).toBe(0);
	});
});
