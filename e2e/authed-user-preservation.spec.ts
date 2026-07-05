import { expect, test } from '@playwright/test';

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
});
