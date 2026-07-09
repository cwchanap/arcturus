import type { Browser, BrowserContext, Page } from '@playwright/test';
import { bootstrapTestUser } from './bootstrap-auth';

const DEFAULT_BASE_URL = 'http://localhost:2000';

export type IsolatedPageOptions = {
	emailPrefix: string;
	namePrefix: string;
	/**
	 * Optional navigation run after bootstrap (e.g. goto the game page).
	 * Omit for specs that set up `page.route` mocks before navigating.
	 */
	navigate?: (page: Page) => Promise<void>;
};

/**
 * Creates a freshly-bootstrapped per-test user with its own browser context.
 *
 * Stateful chip-sync tests mutate per-user server state (chip balance + the 2s
 * `/api/chips/update` rate limit). Sharing the single authenticated E2E user
 * across `fullyParallel` workers would race. Each call gets an isolated user
 * so it owns its rate-limit budget and balance. Read-only UI tests keep using
 * the shared fixture page.
 */
export async function createIsolatedPage(
	browser: Browser,
	baseURL: string | undefined,
	opts: IsolatedPageOptions,
): Promise<{ context: BrowserContext; page: Page }> {
	const resolvedBaseURL = baseURL ?? DEFAULT_BASE_URL;
	const context = await browser.newContext({ baseURL: resolvedBaseURL });
	const page = await context.newPage();
	const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	await bootstrapTestUser(context, resolvedBaseURL, {
		email: `${opts.emailPrefix}-${nonce}@arcturus.local`,
		name: `${opts.namePrefix} ${nonce}`,
	});
	await page.goto(resolvedBaseURL, { waitUntil: 'domcontentloaded' });
	if (opts.navigate) {
		await opts.navigate(page);
	}
	return { context, page };
}
