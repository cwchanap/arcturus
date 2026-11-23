import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

/**
 * Task 4 (HPA-731): executed SSR coverage for the two Poker routes sharing the
 * template — cache header, CSS fallback for defaults/guests, and emission of
 * equipped cosmetics as complete url() values.
 * Task 5: the full isolated chip-shop journey — UI purchase/equip/default
 * restore, both balance mirrors, cache headers on /shop and Poker, computed
 * cash/Sit & Go cosmetics, inventory isolation, and the unauthenticated gate.
 */

const POKER_ROUTES = ['/games/poker', '/games/poker?mode=sng'] as const;

const FRESH_BALANCE = '10,000 chips';
const AFTER_CARD_BACK_BALANCE = '5,000 chips';
const AFTER_BOTH_BALANCE = '0 chips';
const PAID_ITEM_IDS = [
	'card-back-sapphire',
	'card-back-crimson',
	'card-back-jade',
	'felt-sapphire',
	'felt-crimson',
	'felt-jade',
] as const;

/** The shared styled root's opening tag, sliced out of the SSR HTML. */
function pokerRootTag(html: string): string {
	const rootIndex = html.indexOf('id="poker-root"');
	const tagStart = html.lastIndexOf('<div', rootIndex);
	const tagEnd = html.indexOf('>', rootIndex);
	return html.slice(tagStart, tagEnd + 1);
}

/** Shop-page pill: the only balance mirror visible on mobile viewports. */
function shopBalance(page: Page) {
	return page.getByTestId('shop-balance');
}

/** Shared AppLayout header pill: desktop-only, first [data-chip-balance] in the DOM. */
function headerBalance(page: Page) {
	return page.locator('[data-chip-balance]').first();
}

function openShop(browser: Browser, baseURL: string | undefined, emailPrefix: string) {
	return createIsolatedPage(browser, baseURL, {
		emailPrefix,
		namePrefix: 'Shop E2E',
		navigate: async (page) => {
			await page.goto('/shop', { waitUntil: 'domcontentloaded' });
		},
	});
}

/** Buy from a tile and wait for the applied response: tile owned, both balance mirrors updated. */
async function buyFromShop(page: Page, itemId: string, expectedBalance: string): Promise<void> {
	await page.getByTestId(`shop-action-${itemId}`).click();
	await expect(page.getByTestId(`shop-item-${itemId}`)).toHaveAttribute('data-owned', 'true');
	await expect(shopBalance(page)).toHaveText(expectedBalance);
	await expect(headerBalance(page)).toHaveText(expectedBalance);
}

/** Equip from a tile (the UI posts the { itemId } contract) and wait for the flip. */
async function equipFromShop(page: Page, itemId: string): Promise<void> {
	await page.getByTestId(`shop-action-${itemId}`).click();
	await expect(page.getByTestId(`shop-item-${itemId}`)).toHaveAttribute('data-equipped', 'true');
}

/** Resolved background-image of the first element matching a selector. */
function computedBackgroundImage(page: Page, selector: string): Promise<string> {
	return page.evaluate((sel) => {
		const el = document.querySelector(sel);
		if (!el) throw new Error(`${sel} not found`);
		return getComputedStyle(el).backgroundImage;
	}, selector);
}

async function buyAndEquipSapphireSet(context: BrowserContext, baseURL: string): Promise<void> {
	for (const itemId of ['felt-sapphire', 'card-back-sapphire'] as const) {
		const purchase = await context.request.post(`${baseURL}/api/shop/purchase`, {
			data: { itemId },
		});
		expect(purchase.status()).toBe(200);
		const equip = await context.request.post(`${baseURL}/api/shop/equip`, { data: { itemId } });
		expect(equip.status()).toBe(200);
	}
}
test.describe('Poker SSR cosmetics (guest)', () => {
	// Empty storage state so the shared fixture user cannot leak into what
	// must be an unauthenticated request.
	test.use({ storageState: { cookies: [], origins: [] } });

	test('guests get neither cache header nor cosmetic vars on either route', async ({
		page,
		baseURL,
	}) => {
		for (const route of POKER_ROUTES) {
			const response = await page.request.get(`${baseURL}${route}`);
			expect(response.status()).toBe(200);
			expect(response.headers()['cache-control']).toBeUndefined();

			const rootTag = pokerRootTag(await response.text());
			expect(rootTag).toContain('id="poker-root"');
			expect(rootTag).not.toContain('--poker-felt-image');
			expect(rootTag).not.toContain('--poker-card-back-image');
		}
	});
});

test.describe('Poker SSR cosmetics (authenticated)', () => {
	for (const route of POKER_ROUTES) {
		test(`authenticated ${route} sends private, no-store and keeps the CSS fallback for a fresh user`, async ({
			browser,
			baseURL,
		}) => {
			const { context } = await createIsolatedPage(browser, baseURL, {
				emailPrefix: 'shop-defaults',
				namePrefix: 'Shop Defaults',
			});
			const response = await context.request.get(`${baseURL}${route}`);
			expect(response.status()).toBe(200);
			expect(response.headers()['cache-control']).toBe('private, no-store');

			const rootTag = pokerRootTag(await response.text());
			expect(rootTag).toContain('id="poker-root"');
			// No rows exist yet: both declarations must be omitted so the
			// stylesheet's default artwork stays active.
			expect(rootTag).not.toContain('--poker-felt-image');
			expect(rootTag).not.toContain('--poker-card-back-image');
			await context.close();
		});

		test(`authenticated ${route} emits equipped cosmetics as complete url() values on #poker-root`, async ({
			browser,
			baseURL,
		}) => {
			const { context, page } = await createIsolatedPage(browser, baseURL, {
				emailPrefix: 'shop-equipped',
				namePrefix: 'Shop Equipped',
			});
			await buyAndEquipSapphireSet(context, baseURL!);

			await page.goto(`${baseURL}${route}`, { waitUntil: 'domcontentloaded' });
			// Both kinds join in felt→card-back order as exact CSS url tokens.
			await expect(page.locator('#poker-root')).toHaveAttribute(
				'style',
				/--poker-felt-image:url\('\/images\/shop\/felt-sapphire\.webp'\);--poker-card-back-image:url\('\/images\/shop\/card-back-sapphire\.webp'\)/,
			);
			await context.close();
		});
	}
});

test.describe('chip shop journey (isolated 10,000-chip user, cross-user isolation)', () => {
	test('buy, reject, equip, refresh, isolation, cash gate, SNG hand, restore defaults', async ({
		browser,
		baseURL,
	}) => {
		test.setTimeout(90_000);
		const { context, page } = await openShop(browser, baseURL, 'shop-journey');
		try {
			// Fresh wallet: both mirrors agree on 10,000 chips (desktop viewport).
			await expect(shopBalance(page)).toHaveText(FRESH_BALANCE);
			await expect(headerBalance(page)).toHaveText(FRESH_BALANCE);
			await expect(headerBalance(page)).toBeVisible();
			await expect(shopBalance(page)).toBeVisible();

			// Buy the sapphire card back through the tile UI: exactly 5,000 left.
			await buyFromShop(page, 'card-back-sapphire', AFTER_CARD_BACK_BALANCE);

			// Repeat and unaffordable purchases are rejected without debiting.
			const repeat = await context.request.post(`${baseURL}/api/shop/purchase`, {
				data: { itemId: 'card-back-sapphire' },
			});
			expect(repeat.status()).toBe(409);
			expect(await repeat.json()).toEqual({ error: 'ALREADY_OWNED', balance: 5000 });
			const jade = await context.request.post(`${baseURL}/api/shop/purchase`, {
				data: { itemId: 'card-back-jade' },
			});
			expect(jade.status()).toBe(400);
			expect(await jade.json()).toEqual({ error: 'INSUFFICIENT_CHIPS', balance: 5000 });
			await expect(shopBalance(page)).toHaveText(AFTER_CARD_BACK_BALANCE);
			await expect(page.getByTestId('shop-item-card-back-jade')).toHaveAttribute(
				'data-owned',
				'false',
			);

			// Buy the sapphire felt: both 5,000-chip sapphires exactly exhaust the wallet.
			await buyFromShop(page, 'felt-sapphire', AFTER_BOTH_BALANCE);

			// Equip both kinds through the { itemId } contract the tiles post.
			await equipFromShop(page, 'card-back-sapphire');
			await equipFromShop(page, 'felt-sapphire');

			// Selection and balance survive a full page refresh (SSR re-read).
			await page.reload({ waitUntil: 'domcontentloaded' });
			await expect(page.getByTestId('shop-item-card-back-sapphire')).toHaveAttribute(
				'data-equipped',
				'true',
			);
			await expect(page.getByTestId('shop-item-felt-sapphire')).toHaveAttribute(
				'data-equipped',
				'true',
			);
			await expect(shopBalance(page)).toHaveText(AFTER_BOTH_BALANCE);
			await expect(headerBalance(page)).toHaveText(AFTER_BOTH_BALANCE);

			// Cross-user isolation while the first user still owns and has both
			// Sapphires equipped: the second isolated user keeps the untouched
			// balance, owns no paid item, and runs on the default selections.
			const second = await openShop(browser, baseURL, 'shop-second-user');
			try {
				await expect(shopBalance(second.page)).toHaveText(FRESH_BALANCE);
				for (const itemId of PAID_ITEM_IDS) {
					await expect(second.page.getByTestId(`shop-item-${itemId}`)).toHaveAttribute(
						'data-owned',
						'false',
					);
					await expect(second.page.getByTestId(`shop-item-${itemId}`)).toHaveAttribute(
						'data-equipped',
						'false',
					);
				}
				await expect(second.page.getByTestId('shop-item-card-back-default')).toHaveAttribute(
					'data-equipped',
					'true',
				);
				await expect(second.page.getByTestId('shop-item-felt-default')).toHaveAttribute(
					'data-equipped',
					'true',
				);
			} finally {
				await second.context.close();
			}

			// Authenticated /shop and Poker responses stay uncacheable.
			for (const route of ['/shop', '/games/poker']) {
				const response = await context.request.get(`${baseURL}${route}`);
				expect(response.status()).toBe(200);
				expect(response.headers()['cache-control']).toBe('private, no-store');
			}

			// Cash Poker at 0 chips cannot deal, but the equipped cosmetics render:
			// felt on the room frame and card back on the SSR-present hidden deco.
			await page.goto('/games/poker', { waitUntil: 'domcontentloaded' });
			await expect(page.locator('#poker-root')).toHaveAttribute('data-poker-mode', 'cash');
			await expect(page.locator('#poker-root')).toHaveAttribute(
				'style',
				/--poker-felt-image:url\('\/images\/shop\/felt-sapphire\.webp'\);--poker-card-back-image:url\('\/images\/shop\/card-back-sapphire\.webp'\)/,
			);
			expect(await computedBackgroundImage(page, '.poker-frame')).toContain(
				'/images/shop/felt-sapphire.webp',
			);
			expect(await computedBackgroundImage(page, '.card-back-deco')).toContain(
				'/images/shop/card-back-sapphire.webp',
			);
			await page.locator('#btn-deal').click();
			// The status line carries a [Preflop] phase prefix.
			await expect(page.locator('#game-status')).toContainText('Game Over - You ran out of chips!');
			await expect(page.locator('#player-cards [data-slot-state="card"]')).toHaveCount(0);

			// The independent tournament stack still permits a hand, dealt onto
			// the equipped felt with visible equipped card backs on opponents.
			await page.goto('/games/poker?mode=sng', { waitUntil: 'domcontentloaded' });
			await expect(page.locator('#poker-root')).toHaveAttribute('data-poker-mode', 'sng');
			await page.locator('#btn-deal').click();
			await expect(page.locator('#tournament-hands')).toHaveText('1');
			await expect(page.locator('#player-cards [data-slot-state="card"]')).toHaveCount(2);
			const visibleBack = page.locator('.card-back-deco:visible').first();
			await expect(visibleBack).toBeVisible();
			expect(await visibleBack.evaluate((el) => getComputedStyle(el).backgroundImage)).toContain(
				'/images/shop/card-back-sapphire.webp',
			);
			expect(await computedBackgroundImage(page, '.poker-frame')).toContain(
				'/images/shop/felt-sapphire.webp',
			);

			// Restore both defaults through the shop UI; ownership survives.
			await page.goto('/shop', { waitUntil: 'domcontentloaded' });
			await equipFromShop(page, 'card-back-default');
			await equipFromShop(page, 'felt-default');
			await expect(page.getByTestId('shop-item-card-back-sapphire')).toHaveAttribute(
				'data-equipped',
				'false',
			);
			await expect(page.getByTestId('shop-item-felt-sapphire')).toHaveAttribute(
				'data-equipped',
				'false',
			);
			await expect(page.getByTestId('shop-item-card-back-sapphire')).toHaveAttribute(
				'data-owned',
				'true',
			);
			await expect(page.getByTestId('shop-item-felt-sapphire')).toHaveAttribute(
				'data-owned',
				'true',
			);

			// After reload the SSR omits the variables: computed styles fall back.
			await page.goto('/games/poker', { waitUntil: 'domcontentloaded' });
			await expect(page.locator('#poker-root')).not.toHaveAttribute(
				'style',
				/--poker-(felt|card-back)-image/,
			);
			expect(await computedBackgroundImage(page, '.poker-frame')).toContain(
				'/images/poker/felt.webp',
			);
			expect(await computedBackgroundImage(page, '.card-back-deco')).toContain(
				'/images/poker/card-back.webp',
			);
		} finally {
			await context.close();
		}
	});
});

test.describe('chip shop mobile balance', () => {
	test.use({ viewport: { width: 375, height: 667 } });

	test('the shop pill stays the visible mobile mirror after a purchase', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await openShop(browser, baseURL, 'shop-mobile');
		try {
			// On mobile the desktop header pill is hidden; the shop pill is the
			// visible balance and both still carry the same value.
			await expect(headerBalance(page)).toBeHidden();
			await expect(shopBalance(page)).toBeVisible();
			await expect(shopBalance(page)).toHaveText(FRESH_BALANCE);

			await buyFromShop(page, 'card-back-sapphire', AFTER_CARD_BACK_BALANCE);
			await expect(shopBalance(page)).toBeVisible();
		} finally {
			await context.close();
		}
	});
});

test.describe('poker phone header layout', () => {
	test.use({ viewport: { width: 375, height: 812 } });

	// Read-only layout regression (HPA-731 acceptance): both Poker modes must
	// fit the 375px phone viewport — no horizontal overflow and no header
	// action pushed outside it. The shared fixture user is enough; layout does
	// not depend on wallet or cosmetic state.
	for (const route of POKER_ROUTES) {
		test(`${route} fits 375px with every header action visible and focusable`, async ({ page }) => {
			await page.goto(route, { waitUntil: 'domcontentloaded' });

			const overflow = await page.evaluate(() => {
				const doc = document.documentElement;
				const vw = window.innerWidth;
				const outside = [
					...document.querySelectorAll('.poker-toolbar a, .poker-toolbar button'),
				].filter((el) => {
					const r = el.getBoundingClientRect();
					return r.width > 0 && (r.right > vw + 1 || r.left < -1);
				}).length;
				return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, outside };
			});
			expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
			expect(overflow.outside).toBe(0);

			const controls = page.locator('.poker-toolbar a, .poker-toolbar button');
			const count = await controls.count();
			expect(count).toBeGreaterThan(0);
			for (let i = 0; i < count; i++) {
				await expect(controls.nth(i)).toBeVisible();
			}
			await controls.first().focus();
			await expect(controls.first()).toBeFocused();
		});
	}
});

test.describe('shop API auth gate', () => {
	// Cleared storage state: the shared fixture user must not authenticate
	// these wallet-mutating requests.
	test.use({ storageState: { cookies: [], origins: [] } });

	test('unauthenticated purchase and equip attempts are rejected', async ({ request, baseURL }) => {
		const purchase = await request.post(`${baseURL}/api/shop/purchase`, {
			data: { itemId: 'card-back-sapphire' },
		});
		expect(purchase.status()).toBe(401);
		expect(await purchase.json()).toEqual({ error: 'UNAUTHORIZED' });

		const equip = await request.post(`${baseURL}/api/shop/equip`, {
			data: { itemId: 'card-back-sapphire' },
		});
		expect(equip.status()).toBe(401);
		expect(await equip.json()).toEqual({ error: 'UNAUTHORIZED' });
	});
});
