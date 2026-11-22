import type { APIRoute } from 'astro';
import { isShopItemId } from '../../../lib/shop/catalog';
import { purchaseShopItem, type PurchaseResult } from '../../../lib/shop/service';

type PurchaseShopItem = typeof purchaseShopItem;

function respond(result: PurchaseResult): Response {
	// HTTP surface uses `balance` per the design contract; the service result
	// keeps the missions-style `chipBalance` field name internally.
	switch (result.status) {
		case 'purchased':
			return Response.json({
				status: result.status,
				itemId: result.itemId,
				balance: result.chipBalance,
			});
		case 'already-owned':
			return Response.json(
				{ error: 'ALREADY_OWNED', balance: result.chipBalance },
				{ status: 409 },
			);
		case 'insufficient':
			return Response.json(
				{ error: 'INSUFFICIENT_CHIPS', balance: result.chipBalance },
				{ status: 400 },
			);
		case 'not-purchasable':
			return Response.json({ error: 'INVALID_ITEM' }, { status: 400 });
		case 'user-not-found':
			return Response.json({ error: 'USER_NOT_FOUND' }, { status: 500 });
	}
}

export function createPostHandler({
	purchase = purchaseShopItem,
}: {
	purchase?: PurchaseShopItem;
} = {}): APIRoute {
	return async ({ locals, request }) => {
		const userId = locals.session?.user.id ?? locals.user?.id;
		if (!userId) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

		const d1 = locals.env?.DB;
		if (!d1) return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });

		let body: { itemId?: unknown };
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: 'INVALID_JSON' }, { status: 400 });
		}

		// Only the closed catalog union passes; kind and price are derived
		// server-side from the catalog, never from the client.
		if (typeof body?.itemId !== 'string' || !isShopItemId(body.itemId)) {
			return Response.json({ error: 'INVALID_ITEM' }, { status: 400 });
		}

		try {
			return respond(await purchase(d1, userId, body.itemId));
		} catch (error) {
			console.error('[SHOP_PURCHASE] Failed to purchase item:', error);
			return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
		}
	};
}

export const POST: APIRoute = createPostHandler();
