import { describe, expect, test } from 'bun:test';

import {
	CATALOG,
	DEFAULT_SHOP_ITEM_ID_BY_KIND,
	SHOP_ITEM_IDS,
	SHOP_ITEM_IDS_BY_KIND,
	isShopItemId,
	type ShopItem,
	type ShopItemKind,
} from './catalog';

const EXPECTED_ITEM_IDS = [
	'card-back-default',
	'card-back-sapphire',
	'card-back-crimson',
	'card-back-jade',
	'felt-default',
	'felt-sapphire',
	'felt-crimson',
	'felt-jade',
] as const;

describe('shop catalog', () => {
	test('SHOP_ITEM_IDS is the closed eight-item set', () => {
		expect([...SHOP_ITEM_IDS].sort()).toEqual([...EXPECTED_ITEM_IDS].sort());
	});

	test('catalog is an exhaustive record keyed by every shop item ID', () => {
		const catalogRecord: Record<string, ShopItem> = CATALOG;
		expect(Object.keys(catalogRecord).sort()).toEqual([...EXPECTED_ITEM_IDS].sort());
		for (const id of SHOP_ITEM_IDS) {
			expect(catalogRecord[id].id).toBe(id);
		}
	});

	test('prices follow 0 / 5k / 15k / 40k per variant for both kinds', () => {
		expect(CATALOG['card-back-default'].priceChips).toBe(0);
		expect(CATALOG['card-back-sapphire'].priceChips).toBe(5_000);
		expect(CATALOG['card-back-crimson'].priceChips).toBe(15_000);
		expect(CATALOG['card-back-jade'].priceChips).toBe(40_000);
		expect(CATALOG['felt-default'].priceChips).toBe(0);
		expect(CATALOG['felt-sapphire'].priceChips).toBe(5_000);
		expect(CATALOG['felt-crimson'].priceChips).toBe(15_000);
		expect(CATALOG['felt-jade'].priceChips).toBe(40_000);
	});

	test('image paths point at the shipped HPA-730 WebPs and poker defaults', () => {
		expect(CATALOG['card-back-default'].imagePath).toBe('/images/poker/card-back.webp');
		expect(CATALOG['card-back-sapphire'].imagePath).toBe('/images/shop/card-back-sapphire.webp');
		expect(CATALOG['card-back-crimson'].imagePath).toBe('/images/shop/card-back-crimson.webp');
		expect(CATALOG['card-back-jade'].imagePath).toBe('/images/shop/card-back-jade.webp');
		expect(CATALOG['felt-default'].imagePath).toBe('/images/poker/felt.webp');
		expect(CATALOG['felt-sapphire'].imagePath).toBe('/images/shop/felt-sapphire.webp');
		expect(CATALOG['felt-crimson'].imagePath).toBe('/images/shop/felt-crimson.webp');
		expect(CATALOG['felt-jade'].imagePath).toBe('/images/shop/felt-jade.webp');
	});

	test('each item carries the correct kind', () => {
		for (const id of SHOP_ITEM_IDS_BY_KIND['card-back']) {
			expect(CATALOG[id].kind).toBe<ShopItemKind>('card-back');
		}
		for (const id of SHOP_ITEM_IDS_BY_KIND.felt) {
			expect(CATALOG[id].kind).toBe<ShopItemKind>('felt');
		}
		expect(SHOP_ITEM_IDS_BY_KIND['card-back']).toHaveLength(4);
		expect(SHOP_ITEM_IDS_BY_KIND.felt).toHaveLength(4);
	});

	test('defaults are exactly the two free items, one per kind', () => {
		expect(DEFAULT_SHOP_ITEM_ID_BY_KIND['card-back']).toBe('card-back-default');
		expect(DEFAULT_SHOP_ITEM_ID_BY_KIND.felt).toBe('felt-default');
		for (const id of Object.values(DEFAULT_SHOP_ITEM_ID_BY_KIND)) {
			expect(CATALOG[id].priceChips).toBe(0);
		}
	});

	test('isShopItemId accepts catalog IDs and rejects unknown strings', () => {
		for (const id of SHOP_ITEM_IDS) {
			expect(isShopItemId(id)).toBe(true);
		}
		expect(isShopItemId('card-back-gold')).toBe(false);
		expect(isShopItemId('felt-DEFAULT')).toBe(false);
		expect(isShopItemId('card-back-defaultx')).toBe(false);
		expect(isShopItemId('card-back-default ')).toBe(false);
	});
});
