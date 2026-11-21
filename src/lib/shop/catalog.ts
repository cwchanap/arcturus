/**
 * Closed shop item catalog: the sole price/image authority for the chip shop.
 * Adding an item means adding its ID here first — ownership rows, the shop UI
 * and the poker cosmetic seam all key off this union. Client-supplied prices
 * or image paths are never trusted; every server decision looks the value up
 * in this catalog.
 */
export const SHOP_ITEM_KINDS = ['card-back', 'felt'] as const;

export type ShopItemKind = (typeof SHOP_ITEM_KINDS)[number];

export const SHOP_ITEM_IDS = [
	'card-back-default',
	'card-back-sapphire',
	'card-back-crimson',
	'card-back-jade',
	'felt-default',
	'felt-sapphire',
	'felt-crimson',
	'felt-jade',
] as const;

export type ShopItemId = (typeof SHOP_ITEM_IDS)[number];

export interface ShopItem {
	id: ShopItemId;
	kind: ShopItemKind;
	/** Chip price; free defaults cost 0 and are never purchased or stored. */
	priceChips: number;
	/** Server-known asset path used for previews and the poker CSS seam. */
	imagePath: string;
}

export const CATALOG: Record<ShopItemId, ShopItem> = {
	'card-back-default': {
		id: 'card-back-default',
		kind: 'card-back',
		priceChips: 0,
		imagePath: '/images/poker/card-back.webp',
	},
	'card-back-sapphire': {
		id: 'card-back-sapphire',
		kind: 'card-back',
		priceChips: 5_000,
		imagePath: '/images/shop/card-back-sapphire.webp',
	},
	'card-back-crimson': {
		id: 'card-back-crimson',
		kind: 'card-back',
		priceChips: 15_000,
		imagePath: '/images/shop/card-back-crimson.webp',
	},
	'card-back-jade': {
		id: 'card-back-jade',
		kind: 'card-back',
		priceChips: 40_000,
		imagePath: '/images/shop/card-back-jade.webp',
	},
	'felt-default': {
		id: 'felt-default',
		kind: 'felt',
		priceChips: 0,
		imagePath: '/images/poker/felt.webp',
	},
	'felt-sapphire': {
		id: 'felt-sapphire',
		kind: 'felt',
		priceChips: 5_000,
		imagePath: '/images/shop/felt-sapphire.webp',
	},
	'felt-crimson': {
		id: 'felt-crimson',
		kind: 'felt',
		priceChips: 15_000,
		imagePath: '/images/shop/felt-crimson.webp',
	},
	'felt-jade': {
		id: 'felt-jade',
		kind: 'felt',
		priceChips: 40_000,
		imagePath: '/images/shop/felt-jade.webp',
	},
};

export const SHOP_ITEM_IDS_BY_KIND: Record<ShopItemKind, readonly ShopItemId[]> = {
	'card-back': SHOP_ITEM_IDS.filter((id) => CATALOG[id].kind === 'card-back'),
	felt: SHOP_ITEM_IDS.filter((id) => CATALOG[id].kind === 'felt'),
};

/** Defaults stay implicit: no user_cosmetic row is ever written for them. */
export const DEFAULT_SHOP_ITEM_ID_BY_KIND: Record<ShopItemKind, ShopItemId> = {
	'card-back': 'card-back-default',
	felt: 'felt-default',
};

export function isShopItemId(value: string): value is ShopItemId {
	return Object.prototype.hasOwnProperty.call(CATALOG, value);
}
