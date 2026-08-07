import { describe, expect, test } from 'bun:test';
import { GET as metadataGET } from '../../pages/api/mp/rooms/[code]';
import { POST } from '../../pages/api/mp/rooms/index';

const USER_ID = 'rooms-api-user';
const DEFAULT_BODY = { maxSeats: 2, smallBlind: 10, bigBlind: 20 };

interface RequestRecord {
	input: string;
	init?: RequestInit;
}

type FetchHandler = (input: string, init?: RequestInit) => Response | Promise<Response>;

function makeLocals(namespace?: DurableObjectNamespace) {
	return {
		user: { id: USER_ID, name: 'Room Creator' },
		runtime: { env: { arcturus: namespace } },
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

function makeRequest(body: unknown = DEFAULT_BODY): Request {
	return new Request('http://test.local/api/mp/rooms', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});
}

function makeMalformedRequest(): Request {
	return new Request('http://test.local/api/mp/rooms', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{not-json',
	});
}

async function callCreate(
	namespace: DurableObjectNamespace | undefined,
	request: Request = makeRequest(),
): Promise<Response> {
	return POST({ request, locals: makeLocals(namespace) as any } as any);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe('mp/rooms create route', () => {
	test('rejects an unauthenticated request', async () => {
		const response = await POST({
			request: makeRequest(),
			locals: { runtime: { env: { arcturus: undefined } } } as any,
		} as any);

		expect(response.status).toBe(401);
		expect(await readJson(response)).toEqual({ error: 'UNAUTHORIZED' });
	});

	test('rejects malformed JSON', async () => {
		const { namespace, requests } = makeNamespace(() => new Response(null, { status: 200 }));

		const response = await callCreate(namespace, makeMalformedRequest());

		expect(response.status).toBe(400);
		expect(await readJson(response)).toEqual({ error: 'INVALID_JSON' });
		expect(requests).toHaveLength(0);
	});

	test('rejects invalid seat and blind configurations before contacting the Durable Object', async () => {
		const { namespace, requests } = makeNamespace(() => new Response(null, { status: 200 }));
		const invalidBodies = [
			{ ...DEFAULT_BODY, maxSeats: 3 },
			{ ...DEFAULT_BODY, smallBlind: 0 },
			{ ...DEFAULT_BODY, smallBlind: 1.5 },
			{ ...DEFAULT_BODY, bigBlind: 0 },
			{ ...DEFAULT_BODY, bigBlind: 19 },
			{
				...DEFAULT_BODY,
				bigBlind: Math.floor(Number.MAX_SAFE_INTEGER / 100) + 1,
			},
		];

		for (const body of invalidBodies) {
			const response = await callCreate(namespace, makeRequest(body));
			expect(response.status).toBe(400);
			expect(await readJson(response)).toEqual({ error: 'INVALID_CONFIG' });
		}

		expect(requests).toHaveLength(0);
	});

	test('returns DO_UNAVAILABLE when the Durable Object binding is missing', async () => {
		const response = await callCreate(undefined);

		expect(response.status).toBe(503);
		expect(await readJson(response)).toEqual({ error: 'DO_UNAVAILABLE' });
	});

	test('initializes a room with a generated code and returns it', async () => {
		const { namespace, requests } = makeNamespace(() => new Response(null, { status: 200 }));

		const response = await callCreate(namespace);

		expect(response.status).toBe(201);
		const body = (await readJson(response)) as { code: string };
		expect(body.code).toMatch(/^MP-[A-Z0-9]{6}$/);
		expect(requests).toHaveLength(1);
		expect(requests[0].input).toBe('http://do/init');
		expect(requests[0].init?.method).toBe('POST');
		expect(new Headers(requests[0].init?.headers).get('content-type')).toBe('application/json');
		expect(JSON.parse(String(requests[0].init?.body))).toEqual({
			...DEFAULT_BODY,
			roomCode: body.code,
		});
	});

	test('retries a room-code collision and succeeds on the next code', async () => {
		let initCalls = 0;
		const { namespace, requests } = makeNamespace(() => {
			initCalls += 1;
			return new Response(null, { status: initCalls === 1 ? 409 : 200 });
		});

		const response = await callCreate(namespace);

		expect(response.status).toBe(201);
		expect(initCalls).toBe(2);
		expect(requests).toHaveLength(2);
		const body = (await readJson(response)) as { code: string };
		expect(JSON.parse(String(requests[1].init?.body)).roomCode).toBe(body.code);
	});

	test('stops after five room-code collisions', async () => {
		let initCalls = 0;
		const { namespace, requests } = makeNamespace(() => {
			initCalls += 1;
			return new Response(null, { status: 409 });
		});

		const response = await callCreate(namespace);

		expect(response.status).toBe(500);
		expect(await readJson(response)).toEqual({ error: 'CODE_GENERATION_FAILED' });
		expect(initCalls).toBe(5);
		expect(requests).toHaveLength(5);
	});

	test('does not retry a non-409 Durable Object response', async () => {
		let initCalls = 0;
		const { namespace, requests } = makeNamespace(() => {
			initCalls += 1;
			return new Response('{"error":"DO_INTERNAL"}', {
				status: 500,
				headers: { 'content-type': 'application/json' },
			});
		});

		const response = await callCreate(namespace);

		expect(response.status).toBe(502);
		expect(await readJson(response)).toEqual({ error: 'DO_INTERNAL' });
		expect(initCalls).toBe(1);
		expect(requests).toHaveLength(1);
	});

	test('returns DO_UNAVAILABLE when initialization fetch throws', async () => {
		const { namespace } = makeNamespace(() => {
			throw new Error('DO fetch exploded');
		});

		const response = await callCreate(namespace);

		expect(response.status).toBe(502);
		expect(await readJson(response)).toEqual({ error: 'DO_UNAVAILABLE' });
	});
});

describe('mp/rooms metadata route', () => {
	test('rejects an unauthenticated metadata request', async () => {
		const response = await metadataGET({
			params: { code: 'MP-ABC123' },
			locals: { runtime: { env: { arcturus: undefined } } } as any,
		} as any);

		expect(response.status).toBe(401);
		expect(await readJson(response)).toEqual({ error: 'UNAUTHORIZED' });
	});

	test('rejects an invalid metadata room code', async () => {
		const response = await metadataGET({
			params: { code: 'not-a-room' },
			locals: makeLocals() as any,
		} as any);

		expect(response.status).toBe(400);
		expect(await readJson(response)).toEqual({ error: 'INVALID_CODE' });
	});

	test('returns DO_UNAVAILABLE when the metadata binding is missing', async () => {
		const response = await metadataGET({
			params: { code: 'MP-ABC123' },
			locals: makeLocals() as any,
		} as any);

		expect(response.status).toBe(503);
		expect(await readJson(response)).toEqual({ error: 'DO_UNAVAILABLE' });
	});

	test('forwards a valid metadata request to the room Durable Object', async () => {
		const { namespace, requests } = makeNamespace((input) => {
			expect(input).toBe('http://do/metadata');
			return new Response('{"roomCode":"MP-ABC123","occupancy":1}', {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		});

		const response = await metadataGET({
			params: { code: 'MP-ABC123' },
			locals: makeLocals(namespace) as any,
		} as any);

		expect(response.status).toBe(200);
		expect(await readJson(response)).toEqual({ roomCode: 'MP-ABC123', occupancy: 1 });
		expect(requests).toHaveLength(1);
	});
});
