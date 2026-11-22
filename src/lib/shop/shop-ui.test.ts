import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { SHOP_ITEM_IDS, type ShopItemId } from './catalog';
import { applyBalanceToDocument, applyEquipToDocument, applyPurchaseToDocument } from './shop-ui';
import { SUPPORTED_LOCALES } from '../i18n/locale';
import { getShopErrorMessage, getShopItemName, shopTranslator } from '../i18n/messages/shop';
import { formatChips } from '../i18n/messages/common';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const happyWindow = new Window();

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
});

afterAll(() => {
	happyWindow.close();
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

/**
 * The one tile layout contract shared with `src/pages/shop.astro`: each tile
 * carries `data-shop-item`/`data-item-kind`, a price/owned line, an equipped
 * marker, and the single action button.
 */
function renderShopScaffold(): HTMLElement {
	// Same pattern as ranked-ui tests: the global `document` is happy-dom at
	// runtime but types as the DOM Document, keeping helpers lib-dom typed.
	const root = document.createElement('main');
	// One shop at a time: earlier scaffolds must not leak into document-scoped queries.
	happyWindow.document.body.innerHTML = '';
	root.innerHTML = `
		<div class="deco-chip-pill"><span data-chip-balance>0 chips</span></div>
		<span data-chip-balance>0 chips</span>
		${SHOP_ITEM_IDS.map((id) => {
			const variant = id.split('-')[1];
			const owned = variant === 'default';
			return `<article data-shop-item="${id}" data-owned="${owned}" data-equipped="false">
				<p data-shop-price>${owned ? 'Owned' : 'price'}</p>
				<span data-shop-equipped-label hidden>Equipped</span>
				<button type="button" data-shop-action="${owned ? 'equip' : 'purchase'}" data-item-id="${id}" aria-pressed="false">action</button>
			</article>`;
		}).join('')}`;
	document.body.appendChild(root);
	return root;
}

function tile(root: HTMLElement, id: ShopItemId): HTMLElement {
	const el = root.querySelector<HTMLElement>(`[data-shop-item="${id}"]`);
	if (!el) throw new Error(`missing tile ${id}`);
	return el;
}

function button(root: HTMLElement, id: ShopItemId): HTMLButtonElement {
	const el = tile(root, id).querySelector<HTMLButtonElement>('[data-shop-action]');
	if (!el) throw new Error(`missing action button for ${id}`);
	return el;
}

afterEach(() => {
	happyWindow.document.body.innerHTML = '';
});

describe('applyBalanceToDocument', () => {
	test('updates every [data-chip-balance] node with the localized chip phrase', () => {
		const root = renderShopScaffold();
		applyBalanceToDocument(root, 742, 'en');
		const nodes = root.querySelectorAll<HTMLElement>('[data-chip-balance]');
		expect(nodes.length).toBe(2);
		nodes.forEach((el) => expect(el.textContent).toBe(formatChips(742, 'en')));
	});
});

describe('applyPurchaseToDocument', () => {
	test('marks the tile owned, swaps Buy for Equip, and syncs both balances', () => {
		const root = renderShopScaffold();
		applyPurchaseToDocument(root, 'card-back-sapphire', 25_000, 'en');

		const sapphire = tile(root, 'card-back-sapphire');
		expect(sapphire.dataset.owned).toBe('true');
		expect(sapphire.querySelector<HTMLElement>('[data-shop-price]')?.textContent).toBe('Owned');
		const btn = button(root, 'card-back-sapphire');
		expect(btn.dataset.shopAction).toBe('equip');
		expect(btn.disabled).toBe(false);
		expect(btn.getAttribute('aria-pressed')).toBe('false');

		root
			.querySelectorAll<HTMLElement>('[data-chip-balance]')
			.forEach((el) => expect(el.textContent).toBe(formatChips(25_000, 'en')));

		// Unrelated tiles keep their state.
		expect(tile(root, 'felt-jade').dataset.owned).toBe('false');
	});

	test('a purchased tile stays unequipped: the equipped marker stays hidden', () => {
		const root = renderShopScaffold();
		applyPurchaseToDocument(root, 'felt-crimson', 1, 'en');
		expect(tile(root, 'felt-crimson').dataset.equipped).toBe('false');
		expect(
			tile(root, 'felt-crimson').querySelector<HTMLElement>('[data-shop-equipped-label]')?.hidden,
		).toBe(true);
	});
});

describe('applyEquipToDocument', () => {
	test('equips the target and clears only that kind\u2019s previous selection', () => {
		const root = renderShopScaffold();
		// Server state: sapphire card back currently equipped.
		tile(root, 'card-back-sapphire').dataset.equipped = 'true';
		applyEquipToDocument(root, 'card-back', 'card-back-jade', 'en');

		const jade = tile(root, 'card-back-jade');
		expect(jade.dataset.equipped).toBe('true');
		expect(jade.querySelector<HTMLElement>('[data-shop-equipped-label]')?.hidden).toBe(false);
		const jadeBtn = button(root, 'card-back-jade');
		expect(jadeBtn.textContent).toBe('Equipped');
		expect(jadeBtn.disabled).toBe(true);
		expect(jadeBtn.getAttribute('aria-pressed')).toBe('true');

		const sapphire = tile(root, 'card-back-sapphire');
		expect(sapphire.dataset.equipped).toBe('false');
		expect(sapphire.querySelector<HTMLElement>('[data-shop-equipped-label]')?.hidden).toBe(true);
		const sapphireBtn = button(root, 'card-back-sapphire');
		expect(sapphireBtn.textContent).toBe('Equip');
		expect(sapphireBtn.disabled).toBe(false);
		expect(sapphireBtn.getAttribute('aria-pressed')).toBe('false');

		// The other kind is untouched.
		expect(tile(root, 'felt-jade').dataset.equipped).toBe('false');
		expect(button(root, 'felt-jade').textContent).toBe('action');
	});

	test('equipping a default resolves the kind to the default tile', () => {
		const root = renderShopScaffold();
		tile(root, 'card-back-sapphire').dataset.equipped = 'true';
		applyEquipToDocument(root, 'card-back', 'card-back-default', 'en');
		expect(tile(root, 'card-back-default').dataset.equipped).toBe('true');
		expect(tile(root, 'card-back-sapphire').dataset.equipped).toBe('false');
	});
});

describe('button announcements', () => {
	test('aria-label announces the item name and action in every locale', () => {
		for (const locale of SUPPORTED_LOCALES) {
			const root = renderShopScaffold();
			const t = shopTranslator(locale);
			const name = getShopItemName(locale, 'felt-sapphire');
			applyPurchaseToDocument(root, 'felt-sapphire', 99, locale);
			expect(button(root, 'felt-sapphire').getAttribute('aria-label')).toBe(
				t('equipItem', { item: name }),
			);
			applyEquipToDocument(root, 'felt', 'felt-sapphire', locale);
			expect(button(root, 'felt-sapphire').getAttribute('aria-label')).toBe(
				t('equippedItem', { item: name }),
			);
		}
	});
});

describe('shop message dictionary', () => {
	test('every catalog item has a display name in all four locales', () => {
		for (const locale of SUPPORTED_LOCALES) {
			for (const id of SHOP_ITEM_IDS) {
				expect(getShopItemName(locale, id).length).toBeGreaterThan(0);
			}
		}
	});

	test('known API error codes map to localized copy; unknown codes fall back', () => {
		expect(getShopErrorMessage('en', 'INSUFFICIENT_CHIPS')).toBeTruthy();
		expect(getShopErrorMessage('ja', 'NOT_OWNED')).toBeTruthy();
		expect(getShopErrorMessage('en', 'SOMETHING_ELSE')).toBe(getShopErrorMessage('en', undefined));
	});
});
