import type { Page } from '@playwright/test';
import { TEST_USER } from './auth.setup';

export const waitForHomeRedirect = async (page: Page, timeout = 10000): Promise<boolean> => {
	try {
		await Promise.all([
			page.waitForURL((url) => url.pathname === '/', { timeout }),
			page.waitForLoadState('domcontentloaded', { timeout }),
		]);
		return true;
	} catch {
		return false;
	}
};

const isAuthenticated = async (page: Page): Promise<boolean> => {
	try {
		await page.goto('/', { waitUntil: 'domcontentloaded' });
		return await page.locator('[data-chip-balance]').first().isVisible();
	} catch {
		return false;
	}
};

export const ensureLoggedIn = async (page: Page): Promise<void> => {
	if (await isAuthenticated(page)) {
		return;
	}

	await page.goto('/signin');
	await page.fill('input[name="email"]', TEST_USER.email);
	await page.fill('input[name="password"]', TEST_USER.password);
	await page.click('button[type="submit"]');

	const reachedHome = await waitForHomeRedirect(page);
	if ((reachedHome || page.url().endsWith('/')) && (await isAuthenticated(page))) {
		return;
	}

	await page.goto('/signup');
	await page.fill('input[name="name"]', TEST_USER.name);
	await page.fill('input[name="email"]', TEST_USER.email);
	await page.fill('input[name="password"]', TEST_USER.password);
	await page.click('button[type="submit"]');
	await page.waitForURL('/', { timeout: 15000 });
	await page.waitForLoadState('domcontentloaded', { timeout: 10000 });

	if (!(await isAuthenticated(page))) {
		throw new Error('Failed to authenticate test user');
	}
};
