import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

/**
 * Task 4 (HPA-731): executed SSR coverage for the two Poker routes sharing the
 * template — cache header, CSS fallback for defaults/guests, and emission of
 * equipped cosmetics as complete url() values. The full purchase/equip UI
 * journey (balances, computed styles, restore, inventory isolation) extends
 * this file in the planned regression task.
 */

const POKER_ROUTES = ['/games/poker', '/games/poker?mode=sng'] as const;

/** The shared styled root's opening tag, sliced out of the SSR HTML. */
function pokerRootTag(html: string): string {
	const rootIndex = html.indexOf('id="poker-root"');
	const tagStart = html.lastIndexOf('<div', rootIndex);
	const tagEnd = html.indexOf('>', rootIndex);
	return html.slice(tagStart, tagEnd + 1);
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
