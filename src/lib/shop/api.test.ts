import { describe, expect, test } from 'bun:test';
import type { APIRoute } from 'astro';
import type { D1Database } from '@cloudflare/workers-types';
import { createPostHandler as createPurchaseHandler } from '../../pages/api/shop/purchase';
import { createPostHandler as createEquipHandler } from '../../pages/api/shop/equip';

const PURCHASED = {
	status: 'purchased' as const,
	itemId: 'card-back-sapphire',
	chipBalance: 5000,
};

function context({
	session = true,
	db = {} as D1Database | null,
	body = { itemId: 'card-back-sapphire' },
}: {
	session?: boolean;
	db?: D1Database | null;
	body?: unknown;
} = {}): Parameters<APIRoute>[0] {
	return {
		locals: {
			session: session ? ({ user: { id: 'user-1' } } as App.Locals['session']) : null,
			env: db ? { DB: db } : {},
		},
		request: new Request('https://arcturus.example/api/shop/purchase', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	} as unknown as Parameters<APIRoute>[0];
}

async function json(response: Response): Promise<unknown> {
	return response.json();
}

describe('POST /api/shop/purchase', () => {
	test('requires an authenticated session', async () => {
		let called = false;
		const response = await createPurchaseHandler({
			purchase: async () => {
				called = true;
				return PURCHASED;
			},
		})(context({ session: false }));

		expect(response.status).toBe(401);
		expect(await json(response)).toEqual({ error: 'UNAUTHORIZED' });
		expect(called).toBe(false);
	});

	test('rejects requests without a database binding', async () => {
		let called = false;
		const response = await createPurchaseHandler({
			purchase: async () => {
				called = true;
				return PURCHASED;
			},
		})(context({ db: null }));

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'DATABASE_UNAVAILABLE' });
		expect(called).toBe(false);
	});

	test('rejects malformed JSON before invoking the service', async () => {
		let called = false;
		const response = await createPurchaseHandler({
			purchase: async () => {
				called = true;
				return PURCHASED;
			},
		})({
			...context(),
			request: new Request('https://arcturus.example/api/shop/purchase', {
				method: 'POST',
				body: '{not-json',
			}),
		});

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_JSON' });
		expect(called).toBe(false);
	});

	test('rejects item IDs outside the closed catalog union', async () => {
		let called = false;
		const response = await createPurchaseHandler({
			purchase: async () => {
				called = true;
				return PURCHASED;
			},
		})(context({ body: { itemId: 'card-back-gold' } }));

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_ITEM' });
		expect(called).toBe(false);
	});

	test('rejects a non-string itemId', async () => {
		const response = await createPurchaseHandler({
			purchase: async () => PURCHASED,
		})(context({ body: { itemId: 123 } }));

		expect(response.status).toBe(400);
		expect(await json(response)).toEqual({ error: 'INVALID_ITEM' });
	});

	test('passes session user, binding and validated item to the service and returns its result', async () => {
		const calls: Array<{ d1: D1Database; userId: string; itemId: string }> = [];
		const db = {} as D1Database;
		const response = await createPurchaseHandler({
			purchase: async (d1, userId, itemId) => {
				calls.push({ d1, userId, itemId });
				return PURCHASED;
			},
		})(context({ db }));

		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({
			status: 'purchased',
			itemId: 'card-back-sapphire',
			balance: 5000,
		});
		expect(calls).toEqual([{ d1: db, userId: 'user-1', itemId: 'card-back-sapphire' }]);
	});

	test('maps insufficient to 400 and already-owned to 409 with the current balance', async () => {
		const insufficient = await createPurchaseHandler({
			purchase: async () => ({
				status: 'insufficient' as const,
				itemId: 'card-back-jade' as const,
				chipBalance: 4999,
			}),
		})(context({ body: { itemId: 'card-back-jade' } }));

		expect(insufficient.status).toBe(400);
		expect(await json(insufficient)).toEqual({
			error: 'INSUFFICIENT_CHIPS',
			balance: 4999,
		});

		const already = await createPurchaseHandler({
			purchase: async () => ({
				status: 'already-owned' as const,
				itemId: 'felt-sapphire' as const,
				chipBalance: 5000,
			}),
		})(context({ body: { itemId: 'felt-sapphire' } }));

		expect(already.status).toBe(409);
		expect(await json(already)).toEqual({ error: 'ALREADY_OWNED', balance: 5000 });
	});

	test('maps default-item purchase to 400 and missing user to 500 (never insufficient)', async () => {
		const notPurchasable = await createPurchaseHandler({
			purchase: async () => ({
				status: 'not-purchasable' as const,
				itemId: 'felt-default' as const,
				chipBalance: 0,
			}),
		})(context({ body: { itemId: 'felt-default' } }));

		expect(notPurchasable.status).toBe(400);
		expect(await json(notPurchasable)).toEqual({ error: 'INVALID_ITEM' });

		const missingUser = await createPurchaseHandler({
			purchase: async () => ({
				status: 'user-not-found' as const,
				itemId: 'card-back-sapphire' as const,
				chipBalance: 0,
			}),
		})(context());

		expect(missingUser.status).toBe(500);
		expect(await json(missingUser)).toEqual({ error: 'USER_NOT_FOUND' });
	});

	test('maps unexpected service failures to 500 INTERNAL_ERROR', async () => {
		const response = await createPurchaseHandler({
			purchase: async () => {
				throw new Error('d1 exploded');
			},
		})(context());

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});
});

describe('POST /api/shop/equip', () => {
	const EQUIPPED = {
		status: 'equipped' as const,
		kind: 'felt' as const,
		equippedItemId: 'felt-sapphire' as const,
	};

	test('requires an authenticated session', async () => {
		const response = await createEquipHandler({
			equip: async () => EQUIPPED,
		})(context({ session: false }));

		expect(response.status).toBe(401);
		expect(await json(response)).toEqual({ error: 'UNAUTHORIZED' });
	});

	test('rejects requests without a database binding', async () => {
		const response = await createEquipHandler({
			equip: async () => EQUIPPED,
		})(context({ db: null }));

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'DATABASE_UNAVAILABLE' });
	});

	test('enforces the { itemId } contract and rejects unknown items', async () => {
		for (const body of [{}, { itemId: '' }, { itemId: 'felt-gold' }, { itemId: null }]) {
			const response = await createEquipHandler({
				equip: async () => EQUIPPED,
			})(context({ body }));
			expect(response.status).toBe(400);
			expect(await json(response)).toEqual({ error: 'INVALID_ITEM' });
		}
	});

	test('derives kind from the item and returns { kind, equippedItemId } without a client kind', async () => {
		const calls: Array<{ d1: D1Database; userId: string; itemId: string }> = [];
		const db = {} as D1Database;
		const response = await createEquipHandler({
			equip: async (d1, userId, itemId) => {
				calls.push({ d1, userId, itemId });
				return { status: 'equipped', kind: 'felt', equippedItemId: 'felt-sapphire' };
			},
		})(context({ db, body: { itemId: 'felt-sapphire' } }));

		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({ kind: 'felt', equippedItemId: 'felt-sapphire' });
		// No redundant kind payload is forwarded — only the validated item.
		expect(calls).toEqual([{ d1: db, userId: 'user-1', itemId: 'felt-sapphire' }]);
	});

	test('maps unowned paid equip to 403 NOT_OWNED', async () => {
		const response = await createEquipHandler({
			equip: async () => ({
				status: 'not-owned' as const,
				kind: 'card-back' as const,
				equippedItemId: 'card-back-jade' as const,
			}),
		})(context({ body: { itemId: 'card-back-jade' } }));

		expect(response.status).toBe(403);
		expect(await json(response)).toEqual({ error: 'NOT_OWNED' });
	});

	test('maps unexpected service failures to 500 INTERNAL_ERROR', async () => {
		const response = await createEquipHandler({
			equip: async () => {
				throw new Error('d1 exploded');
			},
		})(context());

		expect(response.status).toBe(500);
		expect(await json(response)).toEqual({ error: 'INTERNAL_ERROR' });
	});
});
