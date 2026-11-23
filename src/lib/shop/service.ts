import type { D1Database } from '@cloudflare/workers-types';
import {
	CATALOG,
	DEFAULT_SHOP_ITEM_ID_BY_KIND,
	SHOP_ITEM_IDS_BY_KIND,
	isShopItemId,
	type ShopItemKind,
	type ShopItemId,
} from './catalog';
import { readWalletBalance } from '../wallet/repository';

/**
 * Focused shop service: ownership/equipment reads, purchase, equip.
 *
 * Money correctness lives in the purchase batch's in-SQL cascade (same
 * pattern as `src/lib/missions/claim.ts`): eligibility is evaluated inside
 * the INSERT against the CURRENT balance, and the debit only fires when the
 * insert changed a row, so duplicates and unaffordable requests can never
 * charge twice or overdraw.
 */

export interface ShopUserState {
	/** Paid item IDs the user owns. Defaults stay implicit (no rows). */
	ownedItemIds: ShopItemId[];
	/** Effective selection per kind, resolved to the catalog default when none equipped. */
	equippedByKind: Record<ShopItemKind, ShopItemId>;
}

export type PurchaseStatus =
	'purchased' | 'already-owned' | 'insufficient' | 'not-purchasable' | 'user-not-found';

export interface PurchaseResult {
	status: PurchaseStatus;
	itemId: ShopItemId;
	/** Post-debit balance on success; the current balance on failure paths. */
	chipBalance: number;
}

export type EquipStatus = 'equipped' | 'not-owned';

export interface EquipResult {
	status: EquipStatus;
	kind: ShopItemKind;
	equippedItemId: ShopItemId;
}

/** Paid (purchasable) item IDs of a kind — the rows a kind-scoped UPDATE may touch. */
function paidIdsForKind(kind: ShopItemKind): ShopItemId[] {
	return SHOP_ITEM_IDS_BY_KIND[kind].filter((id) => CATALOG[id].priceChips > 0);
}

/** Read owned/equipped state in one query; unknown rows are ignored so the catalog stays authoritative. */
export async function readShopState(d1: D1Database, userId: string): Promise<ShopUserState> {
	const rows = await d1
		.prepare('SELECT itemId, equipped FROM user_cosmetic WHERE userId = ?')
		.bind(userId)
		.all<{ itemId: string; equipped: number }>();

	const ownedItemIds: ShopItemId[] = [];
	const equippedByKind: Record<ShopItemKind, ShopItemId> = { ...DEFAULT_SHOP_ITEM_ID_BY_KIND };
	for (const row of rows.results ?? []) {
		if (!isShopItemId(row.itemId)) continue;
		ownedItemIds.push(row.itemId);
		if (row.equipped) equippedByKind[CATALOG[row.itemId].kind] = row.itemId;
	}
	return { ownedItemIds, equippedByKind };
}

async function ownsItem(d1: D1Database, userId: string, itemId: ShopItemId): Promise<boolean> {
	const row = await d1
		.prepare('SELECT 1 FROM user_cosmetic WHERE userId = ? AND itemId = ?')
		.bind(userId, itemId)
		.first();
	return row !== null;
}

/**
 * Purchase a paid catalog item with one D1 batch: a conditional ownership
 * INSERT … SELECT (eligibility checked in-SQL against the current balance)
 * immediately followed by the price debit gated on `changes() = 1`, whose
 * `RETURNING` row is the authoritative post-debit balance. On no insert, the
 * failure is classified without debiting; a missing user is an error, never
 * "insufficient".
 *
 * shortcut: eligibility reads the committed wallet, but an in-flight Poker
 * hand's outcome is not reserved until settlement. Spending chips that a losing
 * hand is about to lose makes that settlement underflow and fail, so the loss is
 * never charged. Upgrade when wallet settlement reserves stakes at deal time (or
 * clamps and records the loss).
 */
export async function purchaseShopItem(
	d1: D1Database,
	userId: string,
	itemId: ShopItemId,
	nowSeconds: number = Math.trunc(Date.now() / 1000),
): Promise<PurchaseResult> {
	const item = CATALOG[itemId];
	if (item.priceChips === 0) {
		// Defaults are implicitly owned and never stored or charged.
		return { status: 'not-purchasable', itemId, chipBalance: 0 };
	}

	const insertStmt = d1
		.prepare(
			`INSERT INTO user_cosmetic (userId, itemId, purchasedAt, equipped)
			 SELECT ?, ?, ?, 0 FROM user
			 WHERE id = ? AND chipBalance >= ?
			 ON CONFLICT(userId, itemId) DO NOTHING`,
		)
		.bind(userId, itemId, nowSeconds, userId, item.priceChips);

	const debitStmt = d1
		.prepare(
			`UPDATE user SET chipBalance = chipBalance - ?, updatedAt = ?
			 WHERE id = ? AND changes() = 1
			 RETURNING chipBalance`,
		)
		.bind(item.priceChips, nowSeconds, userId);

	const results = await d1.batch([insertStmt, debitStmt]);
	const insertChanges = results[0]?.meta?.changes ?? 0;

	if (insertChanges === 1) {
		const debited = (results[1]?.results ?? []) as Array<{ chipBalance: number }>;
		if (debited.length === 0 || typeof debited[0].chipBalance !== 'number') {
			// The batch has committed, so this cannot be undone here. The insert is
			// gated on changes() = 1 within the same transaction, which makes this
			// a theoretical inconsistency; log the pair needed to reconcile it.
			console.error('[SHOP_PURCHASE] Ownership inserted without a debit:', {
				userId,
				itemId,
				priceChips: item.priceChips,
			});
			throw new Error(`purchase debit returned no balance for user ${userId}`);
		}
		return { status: 'purchased', itemId, chipBalance: debited[0].chipBalance };
	}

	// Insert didn't fire: duplicate, insufficient funds, or missing user.
	const balance = await readWalletBalance(d1, userId);
	if (balance === null) {
		return { status: 'user-not-found', itemId, chipBalance: 0 };
	}
	if (await ownsItem(d1, userId, itemId)) {
		return { status: 'already-owned', itemId, chipBalance: balance };
	}
	return { status: 'insufficient', itemId, chipBalance: balance };
}

/**
 * Equip a catalog item; the kind is derived from the item, never trusted
 * from the client. Paid items need an ownership row (enforced inside the
 * UPDATE via EXISTS so an unowned target cannot clear the current
 * selection); defaults just clear the kind's flags — no row is written.
 * The other kind is never touched.
 */
export async function equipShopItem(
	d1: D1Database,
	userId: string,
	itemId: ShopItemId,
): Promise<EquipResult> {
	const item = CATALOG[itemId];
	const kind = item.kind;
	const paidIds = paidIdsForKind(kind);
	const inList = paidIds.map(() => '?').join(', ');

	if (item.priceChips > 0) {
		const result = await d1
			.prepare(
				`UPDATE user_cosmetic
				 SET equipped = CASE WHEN itemId = ? THEN 1 ELSE 0 END
				 WHERE userId = ? AND itemId IN (${inList})
				   AND EXISTS (SELECT 1 FROM user_cosmetic WHERE userId = ? AND itemId = ?)`,
			)
			.bind(itemId, userId, ...paidIds, userId, itemId)
			.run();
		const changes = result.meta?.changes ?? 0;
		if (changes === 0) {
			return { status: 'not-owned', kind, equippedItemId: itemId };
		}
	} else {
		await d1
			.prepare(
				`UPDATE user_cosmetic SET equipped = 0
				 WHERE userId = ? AND itemId IN (${inList})`,
			)
			.bind(userId, ...paidIds)
			.run();
	}

	return { status: 'equipped', kind, equippedItemId: itemId };
}
