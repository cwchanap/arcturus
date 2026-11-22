/**
 * Chip shop DOM updates: the smallest shared seam between the shop page's
 * inline script and its markup. Each function applies one API response to the
 * rendered tiles — balances go through `formatChips` on every
 * `[data-chip-balance]` node (the shop's own visible pill plus the shared
 * AppLayout header pill), and tile state flips in place so a reload-free
 * purchase/equip leaves SSR-visible markup consistent.
 */

import type { Locale } from '../i18n/locale';
import { formatChips } from '../i18n/messages/common';
import { getShopItemName, shopTranslator } from '../i18n/messages/shop';
import { CATALOG, SHOP_ITEM_IDS_BY_KIND, type ShopItemKind, type ShopItemId } from './catalog';

/** The document a root belongs to: the root itself when it is a document. */
function docOf(root: Element | Document): Document {
	return root.ownerDocument ?? (root as Document);
}

/** Sync every balance mirror (page pill + shared header pill) in one loop. */
export function applyBalanceToDocument(
	root: Element | Document,
	balance: number,
	locale: Locale,
): void {
	docOf(root)
		.querySelectorAll<HTMLElement>('[data-chip-balance]')
		.forEach((element) => {
			element.textContent = formatChips(balance, locale);
		});
}

/** Re-render one tile's owned/equipped state, price line, and action button. */
function renderTile(tile: HTMLElement, owned: boolean, equipped: boolean, locale: Locale): void {
	const id = tile.dataset.shopItem;
	if (!id) return;
	const t = shopTranslator(locale);
	const itemLabel = getShopItemName(locale, id as ShopItemId);

	tile.dataset.owned = String(owned);
	tile.dataset.equipped = String(equipped);

	const price = tile.querySelector<HTMLElement>('[data-shop-price]');
	if (price)
		price.textContent = owned
			? t('owned')
			: formatChips(CATALOG[id as ShopItemId].priceChips, locale);

	const equippedLabel = tile.querySelector<HTMLElement>('[data-shop-equipped-label]');
	if (equippedLabel) equippedLabel.hidden = !equipped;

	const button = tile.querySelector<HTMLButtonElement>('[data-shop-action]');
	if (button) {
		// Visible text carries the state (not color alone); the aria-label adds
		// the item name so screen readers announce item + action together.
		const label = equipped ? t('equipped') : owned ? t('equip') : t('buy');
		const announcement = equipped
			? t('equippedItem', { item: itemLabel })
			: owned
				? t('equipItem', { item: itemLabel })
				: t('buyItem', { item: itemLabel });
		button.textContent = label;
		button.disabled = equipped;
		button.setAttribute('aria-pressed', String(equipped));
		button.setAttribute('aria-label', announcement);
		// Drives the page script's delegation: equipped tiles no-op.
		button.dataset.shopAction = equipped ? 'equipped' : owned ? 'equip' : 'purchase';
	}
}

/** Apply a purchase response: sync balances and flip the tile to owned. */
export function applyPurchaseToDocument(
	root: Element | Document,
	itemId: ShopItemId,
	balance: number,
	locale: Locale,
): void {
	applyBalanceToDocument(root, balance, locale);
	const tile = docOf(root).querySelector<HTMLElement>(`[data-shop-item="${itemId}"]`);
	if (!tile) return;
	renderTile(tile, true, false, locale);
}

/**
 * Apply an equip response to the equipped kind only: the target tile (which
 * may be the kind's default) becomes equipped and the kind's other tiles
 * clear; the other kind is untouched.
 */
export function applyEquipToDocument(
	root: Element | Document,
	kind: ShopItemKind,
	equippedItemId: ShopItemId,
	locale: Locale,
): void {
	const doc = docOf(root);
	for (const id of SHOP_ITEM_IDS_BY_KIND[kind]) {
		const tile = doc.querySelector<HTMLElement>(`[data-shop-item="${id}"]`);
		if (!tile) continue;
		renderTile(tile, true, id === equippedItemId, locale);
	}
}
