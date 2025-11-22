import type { Page } from '@playwright/test';
import { TEST_USER } from './auth.setup';

export const waitForHomeRedirect = async (page: Page, timeout = 10000): Promise<boolean> => {
	try {
		await Promise.all([
			page.waitForURL((url) => url.pathname === '/', { timeout }),
			page.waitForLoadState('networkidle', { timeout }),
		]);
		return true;
	} catch {
		return false;
	}
};

export const ensureLoggedIn = async (page: Page): Promise<void> => {
	await page.goto('/signin');
	await page.fill('input[name="email"]', TEST_USER.email);
	await page.fill('input[name="password"]', TEST_USER.password);
	await page.click('button[type="submit"]');

	const reachedHome = await waitForHomeRedirect(page);
	if (reachedHome || page.url().endsWith('/')) {
		return;
	}

	await page.goto('/signup');
	await page.fill('input[name="name"]', TEST_USER.name);
	await page.fill('input[name="email"]', TEST_USER.email);
	await page.fill('input[name="password"]', TEST_USER.password);
	await page.click('button[type="submit"]');
	await page.waitForURL('/', { timeout: 15000 });
	await page.waitForLoadState('networkidle', { timeout: 10000 });
};
