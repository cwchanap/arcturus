import { expect, test } from '@playwright/test';

/**
 * Four-locale activation: browser-language detection on the first response
 * (no locale cookie), picker-driven cookie persistence, and `<html lang>` /
 * `data-locale` plus representative shell, game, and progression labels.
 *
 * The shared auth state is reused (it contains no `arcturus_locale` cookie),
 * so the browser context locale override is the only resolution input on the
 * first navigation.
 */
test.describe('four-locale activation', () => {
	test.use({ locale: 'ja-JP' });

	test('resolves the browser language, persists picker choices, and keeps them across pages', async ({
		page,
		context,
	}) => {
		// First response resolves ja from Accept-Language (no locale cookie yet).
		await page.goto('/');
		const html = page.locator('html');
		await expect(html).toHaveAttribute('lang', 'ja');
		await expect(html).toHaveAttribute('data-locale', 'ja');
		// Shell label in Japanese.
		await expect(page.locator('nav a[href="/missions"]')).toHaveText('ミッション');

		// The picker marks the current locale selected and localizes its label.
		const picker = page.locator('[data-locale-picker]');
		await expect(picker).toHaveAttribute('aria-label', '言語');
		await expect(picker.locator('option[selected]')).toHaveAttribute('value', 'ja');

		// Change language through the picker: cookie + reload.
		await picker.selectOption('zh-Hant');
		await expect(html).toHaveAttribute('lang', 'zh-Hant', { timeout: 15_000 });
		await expect(html).toHaveAttribute('data-locale', 'zh-Hant');
		const localeCookie = (await context.cookies()).find(
			(cookie) => cookie.name === 'arcturus_locale',
		);
		expect(localeCookie?.value).toBe('zh-Hant');
		// The picker now marks zh-Hant selected with a localized aria-label.
		await expect(page.locator('[data-locale-picker]')).toHaveAttribute('aria-label', '語言');
		await expect(page.locator('[data-locale-picker] option[selected]')).toHaveAttribute(
			'value',
			'zh-Hant',
		);
		await expect(page.locator('nav a[href="/missions"]')).toHaveText('任務');

		// The cookie persists across navigation to a progression page.
		await page.goto('/missions');
		await expect(html).toHaveAttribute('lang', 'zh-Hant');
		await expect(page.getByRole('heading', { name: '每日任務' })).toBeVisible();

		// And across a game page.
		await page.goto('/games/blackjack');
		await expect(html).toHaveAttribute('data-locale', 'zh-Hant');
		await expect(page.getByRole('heading', { name: '二十一點' })).toBeVisible();

		// Switching back to English through the picker also persists.
		await page.locator('[data-locale-picker]').selectOption('en');
		await expect(html).toHaveAttribute('lang', 'en', { timeout: 15_000 });
		await expect(page.locator('nav a[href="/missions"]')).toHaveText('Missions');
	});
});
