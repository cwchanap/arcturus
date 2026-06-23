import { expect, test } from '@playwright/test';

test.describe('Google-only auth UI', () => {
	test('signin page exposes Google sign-in and no password form', async ({ page }) => {
		await page.goto('/signin');

		await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
		await expect(page.locator('input[name="email"]')).toHaveCount(0);
		await expect
			.poll(() =>
				page
					.locator('input')
					.evaluateAll(
						(inputs) => inputs.filter((input) => input.getAttribute('name') === 'password').length,
					),
			)
			.toBe(0);
	});

	test('homepage unauthenticated CTA points at signin', async ({ browser, baseURL }) => {
		const context = await browser.newContext({ storageState: undefined });
		const page = await context.newPage();
		await page.goto(baseURL ?? 'http://localhost:2000');

		await expect(page.getByRole('link', { name: 'Join Free', exact: true })).toHaveAttribute(
			'href',
			'/signin',
		);

		await context.close();
	});
});
