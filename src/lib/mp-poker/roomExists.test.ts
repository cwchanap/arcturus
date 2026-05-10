import { describe, expect, test } from 'bun:test';
import { roomExists } from './roomExists';

function makeMockNamespace(responseStatus: number, shouldThrow = false): DurableObjectNamespace {
	return {
		idFromName(_name: string): DurableObjectId {
			return {} as DurableObjectId;
		},
		get(_id: DurableObjectId): DurableObjectStub {
			return {
				async fetch(_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> {
					if (shouldThrow) throw new Error('network error');
					return new Response(null, { status: responseStatus });
				},
			} as unknown as DurableObjectStub;
		},
	} as unknown as DurableObjectNamespace;
}

describe('roomExists', () => {
	test('returns "exists" when DO responds with 200', async () => {
		const ns = makeMockNamespace(200);
		expect(await roomExists(ns, 'MP-ABC123')).toBe('exists');
	});

	test('returns "gone" when DO responds with 404', async () => {
		const ns = makeMockNamespace(404);
		expect(await roomExists(ns, 'MP-ABC123')).toBe('gone');
	});

	test('returns "unknown" when DO responds with 500', async () => {
		const ns = makeMockNamespace(500);
		expect(await roomExists(ns, 'MP-ABC123')).toBe('unknown');
	});

	test('returns "unknown" when DO responds with 502', async () => {
		const ns = makeMockNamespace(502);
		expect(await roomExists(ns, 'MP-ABC123')).toBe('unknown');
	});

	test('returns "unknown" when DO responds with 503', async () => {
		const ns = makeMockNamespace(503);
		expect(await roomExists(ns, 'MP-ABC123')).toBe('unknown');
	});

	test('returns "unknown" when DO fetch throws (timeout/network)', async () => {
		const ns = makeMockNamespace(200, true);
		expect(await roomExists(ns, 'MP-ABC123')).toBe('unknown');
	});
});
