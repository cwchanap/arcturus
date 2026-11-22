/**
 * Chip shop presentation messages: page copy for /shop, the per-item display
 * names typed exhaustively against the closed `ShopItemId` catalog union (so
 * a new item without localized copy fails `astro check`), and the localized
 * copy for the shop API's error codes. Prices render through the shared
 * `formatChips` chip phrase, never currency.
 */

import type { ShopItemId } from '../../shop/catalog';
import type { Locale } from '../locale';
import { createTranslator, defineMessages, type MessageKey } from '../translate';

/** Display names for every catalog item, complete per locale. */
const SHOP_ITEM_NAMES = defineMessages({
	en: {
		'card-back-default': 'Classic Card Back',
		'card-back-sapphire': 'Sapphire Card Back',
		'card-back-crimson': 'Crimson Card Back',
		'card-back-jade': 'Jade Card Back',
		'felt-default': 'Classic Felt',
		'felt-sapphire': 'Sapphire Felt',
		'felt-crimson': 'Crimson Felt',
		'felt-jade': 'Jade Felt',
	} satisfies Record<ShopItemId, string>,
	'zh-Hant': {
		'card-back-default': '經典牌背',
		'card-back-sapphire': '藍寶石牌背',
		'card-back-crimson': '緋紅牌背',
		'card-back-jade': '翡翠牌背',
		'felt-default': '經典檯面',
		'felt-sapphire': '藍寶石檯面',
		'felt-crimson': '緋紅檯面',
		'felt-jade': '翡翠檯面',
	} satisfies Record<ShopItemId, string>,
	'zh-Hans': {
		'card-back-default': '经典牌背',
		'card-back-sapphire': '蓝宝石牌背',
		'card-back-crimson': '绯红牌背',
		'card-back-jade': '翡翠牌背',
		'felt-default': '经典台面',
		'felt-sapphire': '蓝宝石台面',
		'felt-crimson': '绯红台面',
		'felt-jade': '翡翠台面',
	} satisfies Record<ShopItemId, string>,
	ja: {
		'card-back-default': 'クラシックカードバック',
		'card-back-sapphire': 'サファイアのカードバック',
		'card-back-crimson': 'クリムゾンのカードバック',
		'card-back-jade': 'ジェイドのカードバック',
		'felt-default': 'クラシックフェルト',
		'felt-sapphire': 'サファイアのフェルト',
		'felt-crimson': 'クリムゾンのフェルト',
		'felt-jade': 'ジェイドのフェルト',
	} satisfies Record<ShopItemId, string>,
});

/** Display name for a catalog item in the request locale. */
export function getShopItemName(locale: Locale, id: ShopItemId): string {
	return createTranslator(SHOP_ITEM_NAMES, locale)(id);
}

/** Copy for the chip shop page and its tile controls. */
export const SHOP_MESSAGES = defineMessages({
	en: {
		pageTitle: 'Chip Shop - Arcturus Casino',
		shopHeading: 'Chip Shop',
		yourBalance: 'Your Balance',
		cardBacks: 'Card Backs',
		tableFelts: 'Table Felts',
		owned: 'Owned',
		equipped: 'Equipped',
		buy: 'Buy',
		equip: 'Equip',
		buyItem: 'Buy {item}',
		equipItem: 'Equip {item}',
		equippedItem: '{item} equipped',
		backToPoker: 'Back to Poker',
		serviceUnavailable: 'Service temporarily unavailable',
	},
	'zh-Hant': {
		pageTitle: '籌碼商店 - Arcturus Casino',
		shopHeading: '籌碼商店',
		yourBalance: '你的餘額',
		cardBacks: '牌背',
		tableFelts: '檯面絨布',
		owned: '已擁有',
		equipped: '使用中',
		buy: '購買',
		equip: '使用',
		buyItem: '購買{item}',
		equipItem: '使用{item}',
		equippedItem: '{item}使用中',
		backToPoker: '返回撲克',
		serviceUnavailable: '服務暫時無法使用',
	},
	'zh-Hans': {
		pageTitle: '筹码商店 - Arcturus Casino',
		shopHeading: '筹码商店',
		yourBalance: '你的余额',
		cardBacks: '牌背',
		tableFelts: '台面绒布',
		owned: '已拥有',
		equipped: '使用中',
		buy: '购买',
		equip: '使用',
		buyItem: '购买{item}',
		equipItem: '使用{item}',
		equippedItem: '{item}使用中',
		backToPoker: '返回扑克',
		serviceUnavailable: '服务暂时无法使用',
	},
	ja: {
		pageTitle: 'チップショップ - Arcturus Casino',
		shopHeading: 'チップショップ',
		yourBalance: 'あなたの残高',
		cardBacks: 'カードバック',
		tableFelts: 'テーブルフェルト',
		owned: '所持済み',
		equipped: '使用中',
		buy: '購入',
		equip: '使用',
		buyItem: '{item}を購入',
		equipItem: '{item}を使用',
		equippedItem: '{item}使用中',
		backToPoker: 'ポーカーに戻る',
		serviceUnavailable: 'サービスは一時的に利用できません',
	},
});

/** Localized copy for the shop API's machine error codes, plus fallbacks. */
const SHOP_ERROR_MESSAGES = defineMessages({
	en: {
		INSUFFICIENT_CHIPS: 'Not enough chips for this item.',
		ALREADY_OWNED: 'You already own this item.',
		NOT_OWNED: 'You do not own this item yet.',
		INVALID_ITEM: 'That item is not in the shop.',
		INVALID_JSON: 'The request could not be processed.',
		UNAUTHORIZED: 'Please sign in first.',
		USER_NOT_FOUND: 'Your player profile could not be found.',
		DATABASE_UNAVAILABLE: 'The casino vault is temporarily unavailable.',
		INTERNAL_ERROR: 'Something went wrong. Please try again.',
		network: 'Connection problem. Please try again.',
		unknown: 'The shop could not complete that request.',
	},
	'zh-Hant': {
		INSUFFICIENT_CHIPS: '籌碼不足，無法購買此物品。',
		ALREADY_OWNED: '你已經擁有此物品。',
		NOT_OWNED: '你尚未擁有此物品。',
		INVALID_ITEM: '商店裡沒有這個物品。',
		INVALID_JSON: '無法處理此請求。',
		UNAUTHORIZED: '請先登入。',
		USER_NOT_FOUND: '找不到你的玩家資料。',
		DATABASE_UNAVAILABLE: '賭場金庫暫時無法使用。',
		INTERNAL_ERROR: '發生錯誤，請再試一次。',
		network: '連線發生問題，請再試一次。',
		unknown: '商店無法完成此請求。',
	},
	'zh-Hans': {
		INSUFFICIENT_CHIPS: '筹码不足，无法购买此物品。',
		ALREADY_OWNED: '你已经拥有此物品。',
		NOT_OWNED: '你尚未拥有此物品。',
		INVALID_ITEM: '商店里没有这个物品。',
		INVALID_JSON: '无法处理此请求。',
		UNAUTHORIZED: '请先登录。',
		USER_NOT_FOUND: '找不到你的玩家资料。',
		DATABASE_UNAVAILABLE: '赌场金库暂时无法使用。',
		INTERNAL_ERROR: '发生错误，请再试一次。',
		network: '连接出现问题，请再试一次。',
		unknown: '商店无法完成此请求。',
	},
	ja: {
		INSUFFICIENT_CHIPS: 'チップが足りず、このアイテムを購入できません。',
		ALREADY_OWNED: 'このアイテムはすでに所持しています。',
		NOT_OWNED: 'このアイテムはまだ所持していません。',
		INVALID_ITEM: 'そのアイテムはショップにありません。',
		INVALID_JSON: 'リクエストを処理できませんでした。',
		UNAUTHORIZED: '先にサインインしてください。',
		USER_NOT_FOUND: 'プレイヤープロフィールが見つかりません。',
		DATABASE_UNAVAILABLE: 'カジノの金庫は一時的に利用できません。',
		INTERNAL_ERROR: '問題が発生しました。もう一度お試しください。',
		network: '接続に問題があります。もう一度お試しください。',
		unknown: 'ショップはそのリクエストを完了できませんでした。',
	},
});

type ShopErrorKey = MessageKey<typeof SHOP_ERROR_MESSAGES>;

/**
 * Localized message for a shop API error code. Unknown or missing codes (for
 * example a network failure) fall back to generic copy instead of leaking a
 * raw code.
 */
export function getShopErrorMessage(locale: Locale, code: string | null | undefined): string {
	const t = createTranslator(SHOP_ERROR_MESSAGES, locale);
	const key: ShopErrorKey =
		code && code in SHOP_ERROR_MESSAGES.en ? (code as ShopErrorKey) : 'unknown';
	return t(key);
}

/** Network-level failure copy (fetch threw before any response arrived). */
export function getShopNetworkErrorMessage(locale: Locale): string {
	return createTranslator(SHOP_ERROR_MESSAGES, locale)('network');
}

/** Bind the shop page dictionary to a locale. */
export function shopTranslator(locale: Locale) {
	return createTranslator(SHOP_MESSAGES, locale);
}
