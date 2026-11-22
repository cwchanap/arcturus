import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { CATALOG, SHOP_ITEM_IDS, type ShopItemId } from './catalog';
import {
	applyBalanceToDocument,
	applyEquipToDocument,
	applyPurchaseToDocument,
	createShopMutationGuard,
	runShopAction,
	type ShopActionEnv,
} from './shop-ui';
import { SUPPORTED_LOCALES } from '../i18n/locale';
import {
	getShopErrorMessage,
	getShopItemName,
	getShopNetworkErrorMessage,
	shopTranslator,
} from '../i18n/messages/shop';
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
			const variant = id.split('-')[2];
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
		// Server state: sapphire card back currently equipped (equipped implies owned).
		tile(root, 'card-back-sapphire').dataset.owned = 'true';
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
		tile(root, 'card-back-sapphire').dataset.owned = 'true';
		tile(root, 'card-back-sapphire').dataset.equipped = 'true';
		applyEquipToDocument(root, 'card-back', 'card-back-default', 'en');
		expect(tile(root, 'card-back-default').dataset.equipped).toBe('true');
		expect(tile(root, 'card-back-sapphire').dataset.equipped).toBe('false');
	});

	test('equipping keeps unowned same-kind tiles purchasable: price and Buy action retained', () => {
		const root = renderShopScaffold();
		// Buy only sapphire, then equip it: its unowned siblings must stay Buy.
		applyPurchaseToDocument(root, 'card-back-sapphire', 25_000, 'en');
		applyEquipToDocument(root, 'card-back', 'card-back-sapphire', 'en');

		const equipped = tile(root, 'card-back-sapphire');
		expect(equipped.dataset.owned).toBe('true');
		expect(equipped.dataset.equipped).toBe('true');
		expect(button(root, 'card-back-sapphire').disabled).toBe(true);

		for (const id of ['card-back-crimson', 'card-back-jade'] as const) {
			const unowned = tile(root, id);
			expect(unowned.dataset.owned).toBe('false');
			expect(unowned.querySelector<HTMLElement>('[data-shop-price]')?.textContent).toBe(
				formatChips(CATALOG[id].priceChips, 'en'),
			);
			const btn = button(root, id);
			expect(btn.textContent).toBe('Buy');
			expect(btn.dataset.shopAction).toBe('purchase');
			expect(btn.disabled).toBe(false);
		}

		// The kind's default stays owned and equipable, just not equipped.
		const fallback = tile(root, 'card-back-default');
		expect(fallback.dataset.owned).toBe('true');
		expect(fallback.dataset.equipped).toBe('false');
		expect(button(root, 'card-back-default').dataset.shopAction).toBe('equip');
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

describe('runShopAction', () => {
	function makeEnv(
		post: ShopActionEnv['post'],
		locale: ShopActionEnv['locale'] = 'en',
	): { env: ShopActionEnv; errors: string[] } {
		const errors: string[] = [];
		return {
			errors,
			env: {
				post,
				showError: (message) => errors.push(message),
				guard: createShopMutationGuard(),
				locale,
			},
		};
	}

	test('a successful purchase syncs balances and flips the tile owned', async () => {
		const root = renderShopScaffold();
		const { env } = makeEnv(async () => ({
			ok: true,
			data: { status: 'purchased', itemId: 'felt-jade', balance: 42 },
		}));
		await runShopAction(env, button(root, 'felt-jade'), 'purchase', 'felt-jade');

		expect(tile(root, 'felt-jade').dataset.owned).toBe('true');
		root
			.querySelectorAll<HTMLElement>('[data-chip-balance]')
			.forEach((el) => expect(el.textContent).toBe(formatChips(42, 'en')));
	});

	test('a failed equip re-enables the button and shows the localized error', async () => {
		const root = renderShopScaffold();
		const { env, errors } = makeEnv(
			async () => ({ ok: false, data: { error: 'NOT_OWNED' } }),
			'ja',
		);
		await runShopAction(env, button(root, 'felt-jade'), 'equip', 'felt-jade');

		expect(errors).toEqual([getShopErrorMessage('ja', 'NOT_OWNED')]);
		const btn = button(root, 'felt-jade');
		expect(btn.disabled).toBe(false);
		expect(btn.dataset.shopAction).toBe('purchase');
	});

	test('a network failure re-enables the button and shows the network copy', async () => {
		const root = renderShopScaffold();
		const { env, errors } = makeEnv(async () => {
			throw new Error('offline');
		});
		await runShopAction(env, button(root, 'card-back-jade'), 'equip', 'card-back-jade');

		expect(errors).toEqual([getShopNetworkErrorMessage('en')]);
		expect(button(root, 'card-back-jade').disabled).toBe(false);
	});

	test('a second action while one is pending is refused before fetch, so a delayed response cannot apply out of order', async () => {
		const root = renderShopScaffold();
		const calls: string[] = [];
		let releaseFirst: (() => void) | undefined;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const { env, errors } = makeEnv(async (url, itemId) => {
			calls.push(`${url}:${itemId}`);
			if (calls.length === 1) {
				await firstGate; // the first response is delayed
				return { ok: true, data: { status: 'purchased', itemId, balance: 500 } };
			}
			return { ok: true, data: { status: 'purchased', itemId, balance: 100 } };
		});

		const first = runShopAction(
			env,
			button(root, 'card-back-crimson'),
			'purchase',
			'card-back-crimson',
		);
		// Second click while the first is in flight: refused before any fetch.
		const second = runShopAction(env, button(root, 'felt-jade'), 'purchase', 'felt-jade');

		expect(calls).toEqual(['/api/shop/purchase:card-back-crimson']);
		// The refused click never disabled its button (no pending state to clobber).
		expect(button(root, 'felt-jade').disabled).toBe(false);
		expect(button(root, 'felt-jade').dataset.shopAction).toBe('purchase');

		releaseFirst?.();
		await first;
		await second;

		// The delayed response applied exactly once at its own balance: no later,
		// stale overwrite of the balance mirrors.
		root
			.querySelectorAll<HTMLElement>('[data-chip-balance]')
			.forEach((el) => expect(el.textContent).toBe(formatChips(500, 'en')));
		expect(tile(root, 'card-back-crimson').dataset.owned).toBe('true');
		// The refused action left its tile untouched and only the success cleared
		// the status region (one empty message).
		expect(tile(root, 'felt-jade').dataset.owned).toBe('false');
		expect(errors).toEqual(['']);
	});

	test('a new action is accepted again after the pending one finishes', async () => {
		const root = renderShopScaffold();
		const { env } = makeEnv(async (_url, itemId) => ({
			ok: true,
			data: { status: 'purchased', itemId, balance: 10 },
		}));
		await runShopAction(env, button(root, 'felt-jade'), 'purchase', 'felt-jade');
		await runShopAction(env, button(root, 'felt-crimson'), 'purchase', 'felt-crimson');
		expect(tile(root, 'felt-crimson').dataset.owned).toBe('true');
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
