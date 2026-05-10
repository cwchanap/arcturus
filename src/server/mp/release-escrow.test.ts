import { describe, expect, test } from 'bun:test';
import { POST } from '../../pages/api/mp/release-escrow';

/**
 * Creates a mock D1Database that simulates release-escrow SQL patterns.
 * Supports both the scoped (with roomCode) and unscoped release paths.
 *
 * When a `roomCode` is provided in the request, the mock checks an
 * in-memory membership map to decide whether each user's escrow should
 * be released. When no roomCode is given, the release is unconditional
 * (legacy path).
 */
function createMockD1(options: {
	balances: Map<string, number>;
	heldChips: Map<string, number>;
	memberships?: Map<string, string>; // userId → roomCode
}) {
	const balances = new Map(options.balances);
	const heldChipsMap = new Map(options.heldChips);
	const memberships = new Map(options.memberships ?? []);

	return {
		balances,
		heldChipsMap,
		memberships,
		prepare(sql: string) {
			return {
				sql,
				bind(...args: unknown[]) {
					return { sql, args };
				},
			};
		},
		async batch(
			statements: Array<{ sql: string; args: unknown[] }>,
		): Promise<Array<{ results: unknown[]; meta: { changes: number } }>> {
			const results: Array<{ results: unknown[]; meta: { changes: number } }> = [];

			for (const stmt of statements) {
				const { sql, args } = stmt;

				// Scoped release: checks mp_membership roomCode match
				if (sql.includes('EXISTS') && sql.includes('mp_membership') && sql.includes('roomCode')) {
					const [_ts, userId, _userId2, roomCode] = args as [number, string, string, string];
					const currentHeld = heldChipsMap.get(userId) ?? 0;
					const memberRoom = memberships.get(userId);
					if (currentHeld > 0 && memberRoom === roomCode) {
						const currentBal = balances.get(userId) ?? 0;
						balances.set(userId, currentBal + currentHeld);
						heldChipsMap.set(userId, 0);
						results.push({ results: [], meta: { changes: 1 } });
					} else {
						results.push({ results: [], meta: { changes: 0 } });
					}
					continue;
				}

				// Unscoped release (legacy / no roomCode)
				if (
					sql.startsWith('UPDATE user SET chipBalance') &&
					sql.includes('heldChips = 0') &&
					sql.includes('heldChips > 0')
				) {
					const [_ts, userId] = args as [number, string];
					const currentHeld = heldChipsMap.get(userId) ?? 0;
					if (currentHeld > 0) {
						const currentBal = balances.get(userId) ?? 0;
						balances.set(userId, currentBal + currentHeld);
						heldChipsMap.set(userId, 0);
						results.push({ results: [], meta: { changes: 1 } });
					} else {
						results.push({ results: [], meta: { changes: 0 } });
					}
					continue;
				}

				throw new Error(`Unexpected batch SQL: ${sql}`);
			}

			return results;
		},
	} as unknown as D1Database;
}

function makeRequest(userIds: string[], secret = 'test-secret', roomCode?: string) {
	const body: Record<string, unknown> = { userIds };
	if (roomCode !== undefined) {
		body.roomCode = roomCode;
	}
	return new Request('http://test.local/api/mp/release-escrow', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-arcturus-auth': secret,
		},
		body: JSON.stringify(body),
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

describe('mp/release-escrow API', () => {
	test('rejects requests without auth secret', async () => {
		const d1 = createMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/release-escrow', {
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
		const d1 = createMockD1({ balances: new Map(), heldChips: new Map() });
		const request = makeRequest(['u1'], 'wrong-secret');
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(403);
	});

	test('rejects invalid payload', async () => {
		const d1 = createMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/release-escrow', {
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

	test('rejects malformed JSON', async () => {
		const d1 = createMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/release-escrow', {
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

	test('rejects userIds with non-string elements', async () => {
		const d1 = createMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/release-escrow', {
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
		const d1 = createMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/release-escrow', {
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

	test('rejects non-string roomCode', async () => {
		const d1 = createMockD1({ balances: new Map(), heldChips: new Map() });
		const request = new Request('http://test.local/api/mp/release-escrow', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-arcturus-auth': 'test-secret',
			},
			body: JSON.stringify({ userIds: ['u1'], roomCode: 123 }),
		});
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(400);
	});

	test('returns ok for empty userIds array (no-op)', async () => {
		const d1 = createMockD1({ balances: new Map(), heldChips: new Map() });
		const request = makeRequest([]);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});
		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.ok).toBe(true);
	});

	test('releases escrowed heldChips back to chipBalance (unscoped)', async () => {
		const d1 = createMockD1({
			balances: new Map([
				['u1', 0],
				['u2', 0],
			]),
			heldChips: new Map([
				['u1', 1000],
				['u2', 500],
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
		const body = await response.json();
		expect(body.ok).toBe(true);

		// heldChips moved back to chipBalance
		expect(mockD1.balances.get('u1')).toBe(1000);
		expect(mockD1.heldChipsMap.get('u1')).toBe(0);
		expect(mockD1.balances.get('u2')).toBe(500);
		expect(mockD1.heldChipsMap.get('u2')).toBe(0);
	});

	test('is idempotent — no-op when heldChips is already 0', async () => {
		const d1 = createMockD1({
			balances: new Map([['u1', 1000]]),
			heldChips: new Map([['u1', 0]]),
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
		// Balance unchanged — already released
		expect(mockD1.balances.get('u1')).toBe(1000);
		expect(mockD1.heldChipsMap.get('u1')).toBe(0);
	});

	test('releases only users with heldChips > 0', async () => {
		const d1 = createMockD1({
			balances: new Map([
				['u1', 500],
				['u2', 0],
				['u3', 200],
			]),
			heldChips: new Map([
				['u1', 0],
				['u2', 800],
				['u3', 300],
			]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['u1', 'u2', 'u3']);
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);

		// u1: no held chips, balance unchanged
		expect(mockD1.balances.get('u1')).toBe(500);
		expect(mockD1.heldChipsMap.get('u1')).toBe(0);

		// u2: 800 released → 0 + 800 = 800
		expect(mockD1.balances.get('u2')).toBe(800);
		expect(mockD1.heldChipsMap.get('u2')).toBe(0);

		// u3: 300 released → 200 + 300 = 500
		expect(mockD1.balances.get('u3')).toBe(500);
		expect(mockD1.heldChipsMap.get('u3')).toBe(0);
	});

	test('handles single user release', async () => {
		const d1 = createMockD1({
			balances: new Map([['only', 0]]),
			heldChips: new Map([['only', 2000]]),
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
		expect(mockD1.balances.get('only')).toBe(2000);
		expect(mockD1.heldChipsMap.get('only')).toBe(0);
	});
});

describe('mp/release-escrow API — scoped by roomCode', () => {
	test('releases escrow when membership matches roomCode', async () => {
		const d1 = createMockD1({
			balances: new Map([['u1', 0]]),
			heldChips: new Map([['u1', 1000]]),
			memberships: new Map([['u1', 'ROOM-A']]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['u1'], 'test-secret', 'ROOM-A');
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		expect(mockD1.balances.get('u1')).toBe(1000);
		expect(mockD1.heldChipsMap.get('u1')).toBe(0);
	});

	test('does NOT release escrow when membership points to different room', async () => {
		const d1 = createMockD1({
			balances: new Map([['u1', 0]]),
			heldChips: new Map([['u1', 1000]]),
			memberships: new Map([['u1', 'ROOM-B']]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		// Room A's DO tries to release escrow, but user is now in Room B
		const request = makeRequest(['u1'], 'test-secret', 'ROOM-A');
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		// Escrow NOT released — Room B's chips are safe
		expect(mockD1.balances.get('u1')).toBe(0);
		expect(mockD1.heldChipsMap.get('u1')).toBe(1000);
	});

	test('does NOT release escrow when user has no membership row', async () => {
		const d1 = createMockD1({
			balances: new Map([['u1', 0]]),
			heldChips: new Map([['u1', 500]]),
			memberships: new Map(), // no membership
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['u1'], 'test-secret', 'ROOM-A');
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		expect(mockD1.balances.get('u1')).toBe(0);
		expect(mockD1.heldChipsMap.get('u1')).toBe(500);
	});

	test('releases for multiple users with mixed membership states', async () => {
		const d1 = createMockD1({
			balances: new Map([
				['u1', 0],
				['u2', 0],
				['u3', 0],
			]),
			heldChips: new Map([
				['u1', 1000],
				['u2', 500],
				['u3', 200],
			]),
			memberships: new Map([
				['u1', 'ROOM-A'], // matches — release
				['u2', 'ROOM-B'], // different room — don't release
				// u3: no membership — don't release
			]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		const request = makeRequest(['u1', 'u2', 'u3'], 'test-secret', 'ROOM-A');
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);

		// u1: membership matches ROOM-A → released
		expect(mockD1.balances.get('u1')).toBe(1000);
		expect(mockD1.heldChipsMap.get('u1')).toBe(0);

		// u2: membership points to ROOM-B → NOT released
		expect(mockD1.balances.get('u2')).toBe(0);
		expect(mockD1.heldChipsMap.get('u2')).toBe(500);

		// u3: no membership → NOT released
		expect(mockD1.balances.get('u3')).toBe(0);
		expect(mockD1.heldChipsMap.get('u3')).toBe(200);
	});

	test('ignores empty roomCode (falls through to unscoped path)', async () => {
		const d1 = createMockD1({
			balances: new Map([['u1', 0]]),
			heldChips: new Map([['u1', 1000]]),
			memberships: new Map([['u1', 'ROOM-B']]),
		});
		const mockD1 = d1 as unknown as {
			balances: Map<string, number>;
			heldChipsMap: Map<string, number>;
		};

		// Empty roomCode should use unscoped (legacy) path
		const request = makeRequest(['u1'], 'test-secret', '');
		const response = await POST({
			request,
			locals: makeLocals(d1) as any,
		});

		expect(response.status).toBe(200);
		// Unscoped path releases regardless of membership
		expect(mockD1.balances.get('u1')).toBe(1000);
		expect(mockD1.heldChipsMap.get('u1')).toBe(0);
	});
});
