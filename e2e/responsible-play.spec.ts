import { expect, test } from '@playwright/test';

/**
 * Responsible-play footer navigation: both footer links point at the public
 * information page's anchors (never `#`), clicking them navigates from the
 * homepage to the matching section, and the page renders without a session.
 */
test.describe('Responsible play footer links', () => {
	test('footer links navigate to the responsible-play page sections', async ({ page }) => {
		await page.goto('/');
		const footer = page.locator('footer');

		const responsibleGaming = footer.getByRole('link', { name: 'Responsible Gaming' });
		await expect(responsibleGaming).toHaveAttribute('href', '/responsible-play#responsible-gaming');
		await responsibleGaming.click();
		await expect(page).toHaveURL('/responsible-play#responsible-gaming');
		await expect(page.getByRole('heading', { name: 'Play money only' })).toBeVisible();

		await page.goto('/');
		const adultsOnly = footer.getByRole('link', { name: '18+ Only' });
		await expect(adultsOnly).toHaveAttribute('href', '/responsible-play#age-guidance');
		await adultsOnly.click();
		await expect(page).toHaveURL('/responsible-play#age-guidance');
		await expect(page.getByRole('heading', { name: 'Adult audience' })).toBeVisible();
	});

	test('responsible-play page is public and needs no login', async ({ browser }) => {
		// Fresh context with no stored auth state.
		const context = await browser.newContext({ storageState: undefined });
		const page = await context.newPage();

		await page.goto('/responsible-play');

		await expect(page).toHaveURL(/\/responsible-play/);
		await expect(page.getByRole('heading', { name: 'Responsible Play' })).toBeVisible();
		await expect(page.locator('#responsible-gaming')).toBeVisible();
		await expect(page.locator('#age-guidance')).toBeVisible();
		await context.close();
	});
});
