import type { Page } from '@playwright/test';
import { TEST_USER } from './auth.setup';
import { bootstrapPage } from './bootstrap-auth';

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

const isAuthenticated = async (
	page: Page,
	options: { skipNavigation?: boolean } = {},
): Promise<boolean> => {
	try {
		if (!options.skipNavigation) {
			await page.goto('/', { waitUntil: 'domcontentloaded' });
		} else {
			await page.waitForLoadState('domcontentloaded');
		}
		return await page.locator('[data-chip-balance]').first().isVisible();
	} catch {
		return false;
	}
};

const getBootstrapBaseURL = (page: Page): string => {
	const currentURL = page.url();
	if (currentURL.startsWith('http://') || currentURL.startsWith('https://')) {
		return new URL(currentURL).origin;
	}
	return 'http://localhost:2000';
};

export const ensureLoggedIn = async (page: Page): Promise<void> => {
	if (await isAuthenticated(page)) return;

	const baseURL = getBootstrapBaseURL(page);
	await bootstrapPage(page, baseURL, TEST_USER);

	if (!(await isAuthenticated(page, { skipNavigation: true }))) {
		throw new Error('Failed to authenticate test user through bootstrap');
	}
};
