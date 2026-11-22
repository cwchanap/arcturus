import type { APIRoute } from 'astro';
import { isShopItemId } from '../../../lib/shop/catalog';
import { equipShopItem, type EquipResult } from '../../../lib/shop/service';

type EquipShopItem = typeof equipShopItem;

function respond(result: EquipResult): Response {
	if (result.status === 'equipped') {
		// Exact contract: only kind and the equipped item — clients update
		// that kind's tiles without an extra read. Defaults are inferred.
		return Response.json({ kind: result.kind, equippedItemId: result.equippedItemId });
	}
	return Response.json({ error: 'NOT_OWNED' }, { status: 403 });
}

export function createPostHandler({
	equip = equipShopItem,
}: {
	equip?: EquipShopItem;
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

		// { itemId } only: kind is derived from the server catalog, and any
		// client-supplied kind payload is simply ignored.
		if (typeof body?.itemId !== 'string' || !isShopItemId(body.itemId)) {
			return Response.json({ error: 'INVALID_ITEM' }, { status: 400 });
		}

		try {
			return respond(await equip(d1, userId, body.itemId));
		} catch (error) {
			console.error('[SHOP_EQUIP] Failed to equip item:', error);
			return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
		}
	};
}

export const POST: APIRoute = createPostHandler();
