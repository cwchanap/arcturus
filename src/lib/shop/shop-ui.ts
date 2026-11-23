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
import {
	getShopErrorMessage,
	getShopItemName,
	getShopNetworkErrorMessage,
	shopTranslator,
} from '../i18n/messages/shop';
import {
	CATALOG,
	isShopItemId,
	SHOP_ITEM_IDS_BY_KIND,
	SHOP_ITEM_KINDS,
	type ShopItemKind,
	type ShopItemId,
} from './catalog';

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
		// Keep the SSR "done" styling in sync with the equipped tile. Buy/Equip
		// are action buttons, not toggles: state is carried by the visible text,
		// disabled state and this styling — never aria-pressed.
		button.classList.toggle('deco-btn-done', equipped);
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
		// Equip changes only the kind's selection: each tile keeps its existing
		// ownership so unpurchased siblings keep their price and Buy action.
		renderTile(tile, tile.dataset.owned === 'true', id === equippedItemId, locale);
	}
}

/** Wire format shared with the shop page's inline script: purchase/equip responses. */
export interface ShopActionResponse {
	status?: string;
	itemId?: string;
	balance?: number;
	kind?: string;
	equippedItemId?: string;
	error?: string;
}

/** Serializes a page's shop mutations: at most one request in flight. */
export interface ShopMutationGuard {
	/** Starts a mutation unless one is already in flight; false means refused. */
	begin(): boolean;
	end(): void;
}

/**
 * Shared pending guard for one shop page: while a request is in flight further
 * mutations are refused, so a slow earlier response can never overwrite a newer
 * one (stale balance/selection) and a tile re-render can never re-enable
 * another pending button.
 */
export function createShopMutationGuard(): ShopMutationGuard {
	let pending = false;
	return {
		begin: () => {
			if (pending) return false;
			pending = true;
			return true;
		},
		end: () => {
			pending = false;
		},
	};
}

/** Everything `runShopAction` needs from the page: transport, error display, locale. */
export interface ShopActionEnv {
	post(url: string, itemId: string): Promise<{ ok: boolean; data: ShopActionResponse | null }>;
	showError(message: string): void;
	guard: ShopMutationGuard;
	locale: Locale;
}

/**
 * One shop mutation: refused while another is in flight (the shared guard),
 * with the clicked button disabled until the response is applied — success
 * re-renders the tiles, which own the button's final state — and re-enabled
 * on a failed or failed-to-send request.
 */
export async function runShopAction(
	env: ShopActionEnv,
	button: HTMLButtonElement,
	action: 'purchase' | 'equip',
	itemId: string,
): Promise<void> {
	if (!env.guard.begin()) return;
	button.disabled = true;
	try {
		if (action === 'purchase') {
			const { ok, data } = await env.post('/api/shop/purchase', itemId);
			const purchasedId = data?.itemId;
			if (
				ok &&
				data?.status === 'purchased' &&
				typeof purchasedId === 'string' &&
				isShopItemId(purchasedId) &&
				typeof data.balance === 'number'
			) {
				// One loop updates the shop pill and the shared header pill.
				applyPurchaseToDocument(docOf(button), purchasedId, data.balance, env.locale);
				env.showError('');
				return;
			}
			// Failure bodies for purchases carry the authoritative current
			// balance (INSUFFICIENT_CHIPS/ALREADY_OWNED): refresh the stale pill
			// mirrors so the tab never keeps showing an outdated amount.
			if (typeof data?.balance === 'number') {
				applyBalanceToDocument(docOf(button), data.balance, env.locale);
			}
			env.showError(getShopErrorMessage(env.locale, data?.error));
		} else {
			const { ok, data } = await env.post('/api/shop/equip', itemId);
			const equippedId = data?.equippedItemId;
			if (
				ok &&
				data &&
				typeof equippedId === 'string' &&
				isShopItemId(equippedId) &&
				(SHOP_ITEM_KINDS as readonly string[]).includes(data.kind ?? '')
			) {
				applyEquipToDocument(
					docOf(button),
					data.kind as (typeof SHOP_ITEM_KINDS)[number],
					equippedId,
					env.locale,
				);
				env.showError('');
				return;
			}
			env.showError(getShopErrorMessage(env.locale, data?.error));
		}
		button.disabled = false;
	} catch {
		env.showError(getShopNetworkErrorMessage(env.locale));
		button.disabled = false;
	} finally {
		env.guard.end();
	}
}
