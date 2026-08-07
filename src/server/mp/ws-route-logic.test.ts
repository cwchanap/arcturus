import { describe, expect, test } from 'bun:test';
import { GET } from '../../pages/api/mp/rooms/[code]/ws';

const USER_ID = 'ws-route-user';

interface RequestRecord {
	input: string;
	init?: RequestInit;
}

type FetchHandler = (input: string, init?: RequestInit) => Response | Promise<Response>;

function makeLocals(
	namespace?: DurableObjectNamespace,
	user: { id: string; name: string } | null = { id: USER_ID, name: 'WebSocket User' },
) {
	return {
		...(user ? { user } : {}),
		runtime: { env: { MULTIPLAYER_POKER_ROOMS: namespace } },
	};
}

function makeNamespace(handler: FetchHandler): {
	namespace: DurableObjectNamespace;
	requests: RequestRecord[];
} {
	const requests: RequestRecord[] = [];
	const namespace = {
		idFromName: (name: string) => ({ name }) as unknown as DurableObjectId,
		get: () => ({
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push({ input: String(input), init });
				return handler(String(input), init);
			},
		}),
	} as unknown as DurableObjectNamespace;
	return { namespace, requests };
}

function makeRequest(
	code = 'MP-JOIN01',
	headers: Record<string, string> = { Upgrade: 'websocket' },
): Request {
	return new Request(`http://test.local/api/mp/rooms/${code}/ws`, { headers });
}

async function callGet({
	code = 'MP-JOIN01',
	headers = { Upgrade: 'websocket' },
	namespace,
	user = { id: USER_ID, name: 'WebSocket User' },
}: {
	code?: string;
	headers?: Record<string, string>;
	namespace?: DurableObjectNamespace;
	user?: { id: string; name: string } | null;
} = {}): Promise<Response> {
	const request = makeRequest(code, headers);
	return GET({
		params: { code },
		request,
		locals: makeLocals(namespace, user) as any,
		url: new URL(request.url),
	} as any);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe('mp/rooms WebSocket route validation', () => {
	test('rejects a malformed room code', async () => {
		const response = await callGet({ code: 'not-a-code' });

		expect(response.status).toBe(400);
	});

	test('rejects an unauthenticated request', async () => {
		const response = await callGet({ user: null });

		expect(response.status).toBe(401);
	});

	test('rejects a cross-origin upgrade', async () => {
		const response = await callGet({
			headers: { Upgrade: 'websocket', Origin: 'http://evil.test' },
		});

		expect(response.status).toBe(403);
	});

	test('rejects a malformed Origin header', async () => {
		const response = await callGet({
			headers: { Upgrade: 'websocket', Origin: 'http://[invalid' },
		});

		expect(response.status).toBe(403);
	});

	test('allows same-origin upgrades through validation', async () => {
		const response = await callGet({
			headers: { Upgrade: 'websocket', Origin: 'http://test.local' },
		});

		expect(response.status).toBe(503);
		expect(await readJson(response)).toEqual({ error: 'DO_UNAVAILABLE' });
	});

	test('rejects a non-WebSocket request', async () => {
		const response = await callGet({ headers: { Origin: 'http://test.local' } });

		expect(response.status).toBe(426);
	});
});

describe('mp/rooms WebSocket route forwarding', () => {
	test('forwards the upgrade with trusted identity headers', async () => {
		const user = { id: USER_ID, name: 'Trusted User / こんにちは' };
		const { namespace, requests } = makeNamespace((input, init) => {
			expect(input).toBe('http://do/ws');
			expect(init?.method).toBeUndefined();
			const headers = new Headers(init?.headers);
			expect(headers.get('upgrade')).toBe('websocket');
			expect(headers.get('origin')).toBe('http://test.local');
			expect(headers.get('x-client-header')).toBe('keep-me');
			expect(headers.get('x-arcturus-user-id')).toBe(USER_ID);
			expect(headers.get('x-arcturus-display-name')).toBe(encodeURIComponent(user.name));
			return new Response('forwarded', { status: 200 });
		});

		const response = await callGet({
			namespace,
			user,
			headers: {
				Upgrade: 'websocket',
				Origin: 'http://test.local',
				'x-client-header': 'keep-me',
				'x-arcturus-user-id': 'attacker-id',
				'x-arcturus-display-name': 'attacker-name',
			},
		});

		expect(response.status).toBe(200);
		expect(await response.text()).toBe('forwarded');
		expect(requests).toHaveLength(1);
	});

	test('returns the Durable Object response unchanged', async () => {
		const { namespace } = makeNamespace(() => new Response('room rejected', { status: 404 }));

		const response = await callGet({ namespace });

		expect(response.status).toBe(404);
		expect(await response.text()).toBe('room rejected');
	});

	test('maps a thrown Durable Object fetch to DO_ERROR', async () => {
		const { namespace } = makeNamespace(() => {
			throw new Error('DO upgrade exploded');
		});

		const response = await callGet({ namespace });

		expect(response.status).toBe(502);
		expect(await readJson(response)).toEqual({ error: 'DO_ERROR' });
	});
});
