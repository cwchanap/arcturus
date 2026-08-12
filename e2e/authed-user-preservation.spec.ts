import { expect, test } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

/**
 * Guards the authed-preservation contract: signed-in users must receive a
 * per-user opaque surrogate in data-user-id (never 'anonymous', never the raw
 * account id, never omitted). This is the test that would have caught the
 * regression where clientUserId=undefined for authed users caused all clients
 * to resolve to 'anonymous', collapsing per-user settings isolation and
 * wiping the poker pending-sync journal on every page load.
 */
test.describe('authed user preservation', () => {
	// Uses the default storageState (authenticated) from global setup.

	const authedGames = [
		{ path: '/games/poker', rootSelector: '#poker-root', userIdSelector: '#player-balance' },
		{
			path: '/games/blackjack',
			rootSelector: '#blackjack-root',
			userIdSelector: '#blackjack-root',
		},
		{ path: '/games/baccarat', rootSelector: '#baccarat-root', userIdSelector: '#baccarat-root' },
		{ path: '/games/craps', rootSelector: '#craps-root', userIdSelector: '#craps-root' },
	] as const;

	for (const game of authedGames) {
		test(`${game.path} emits a per-user surrogate for authenticated users`, async ({ page }) => {
			await page.goto(game.path, { waitUntil: 'domcontentloaded' });

			await expect(page).toHaveURL(new RegExp(`${game.path}$`));
			await expect(page.locator(game.rootSelector)).toHaveAttribute('data-guest-mode', 'false');

			const userIdEl = page.locator(game.userIdSelector);
			const userId = await userIdEl.getAttribute('data-user-id');

			// The attribute must be present — omission was the root cause of the
			// original regression (clients fell back to 'anonymous').
			expect(userId).not.toBeNull();
			// Must not be the guest sentinel.
			expect(userId).not.toBe('anonymous');
			// Must be an opaque surrogate, not the raw account id.
			expect(userId?.startsWith('u_')).toBe(true);
		});
	}

	test('authenticated users do not share the anonymous settings namespace', async ({ page }) => {
		// Visit blackjack as an authed user and confirm the client resolves a
		// non-anonymous userId — the isAnonymousUser flag must be false.
		await page.goto('/games/blackjack', { waitUntil: 'networkidle' });

		const userId = await page.locator('#blackjack-root').getAttribute('data-user-id');
		expect(userId).not.toBeNull();
		expect(userId).not.toBe('anonymous');
		expect(userId?.startsWith('u_')).toBe(true);
	});

	test('authenticated Casual Blackjack settles normally without ranked requests', async ({
		browser,
		baseURL,
	}) => {
		const isolated = await createIsolatedPage(browser, baseURL, {
			emailPrefix: 'casual-blackjack',
			namePrefix: 'Casual Blackjack E2E',
		});

		try {
			const rankedRequests: string[] = [];
			isolated.page.on('request', (request) => {
				if (request.url().includes('/api/ranked/')) {
					rankedRequests.push(request.url());
				}
			});
			await isolated.page.addInitScript(() => {
				Math.random = () => 0;
			});
			await isolated.page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });

			await expect(isolated.page.locator('#blackjack-root')).toHaveAttribute(
				'data-guest-mode',
				'false',
			);
			await expect(isolated.page.getByText('Casual', { exact: true })).toBeVisible();
			await expect(isolated.page.getByTestId('ranked-blackjack-link')).toBeVisible();
			await expect(isolated.page.getByTestId('ranked-blackjack-link')).toHaveAttribute(
				'href',
				'/games/blackjack/ranked',
			);

			await isolated.page.locator('#bet-amount').fill('50');
			const settlementPromise = isolated.page.waitForResponse(
				(response) =>
					new URL(response.url()).pathname === '/api/wallet/settle' &&
					response.request().method() === 'POST',
			);
			await isolated.page.getByRole('button', { name: 'Deal' }).click();
			const settlement = await settlementPromise;
			expect(settlement.ok()).toBe(true);
			const settledBalance = ((await settlement.json()) as { balance: number }).balance;

			await expect(isolated.page.locator('#btn-new-round')).toBeVisible();
			await expect(isolated.page.locator('#game-status')).toContainText('BLACKJACK');
			await expect(isolated.page.locator('#player-balance')).toHaveText(
				`$${settledBalance.toLocaleString('en-US')}`,
			);
			await isolated.page.waitForLoadState('networkidle');
			expect(rankedRequests).toEqual([]);
		} finally {
			await isolated.context.close();
		}
	});
});
