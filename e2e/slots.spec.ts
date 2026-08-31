import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

async function gotoSlots(page: Page) {
	await page.goto('/games/slots', { waitUntil: 'networkidle' });
	await page.waitForSelector('#slots-root');
}

const createIsolatedSlotsPage = (browser: Browser, baseURL?: string) =>
	createIsolatedPage(browser, baseURL, {
		emailPrefix: 'slots-sync',
		namePrefix: 'Slots Sync',
		navigate: gotoSlots,
	});

test.describe('Slots game', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/games/slots');
		await page.waitForSelector('#slots-root');
	});

	test('renders the slot machine UI', async ({ page }) => {
		await expect(page.locator('h1')).toHaveText('Slots');
		await expect(page.locator('#btn-spin')).toBeVisible();
		await expect(page.locator('#chip-balance')).toBeVisible();
		await expect(page.locator('.bet-chip')).toHaveCount(6);
	});

	test('spin deducts the bet and updates balance without reload', async ({ browser, baseURL }) => {
		const { context, page } = await createIsolatedSlotsPage(browser, baseURL);
		try {
			const balanceBefore = await page.locator('#chip-balance').textContent();
			await page.locator('.bet-chip[data-bet="1"]').click();
			await expect(page.locator('#current-bet')).toHaveText('1 chip');
			await page.locator('#btn-spin').click();
			// Balance should change (deduct or win) without a navigation.
			// Poll because the reveal (and the optimistic balance update) happens
			// after the spin animation (~1100ms at normal speed).
			await expect
				.poll(async () => page.locator('#chip-balance').textContent())
				.not.toEqual(balanceBefore);
			expect(page.url()).toContain('/games/slots');
		} finally {
			await context.close();
		}
	});

	test('selecting the max bet keeps the spin button enabled', async ({ page }) => {
		// Cannot force a tiny balance without auth manipulation; instead verify
		// the max-bet chip selects 100 and the spin button remains enabled.
		await page.locator('.bet-chip[data-bet="100"]').click();
		await expect(page.locator('#current-bet')).toHaveText('100 chips');
		await expect(page.locator('#btn-spin')).toBeEnabled();
	});

	test('paytable panel matches a known multiplier', async ({ page }) => {
		await page.locator('#btn-paytable').click();
		await expect(page.locator('#paytable-panel')).not.toHaveClass(/hidden/);
		await expect(page.locator('#paytable-panel')).toContainText('×1000'); // seven 5-of-a-kind
		await page.locator('.btn-paytable-close').click();
		await expect(page.locator('#paytable-panel')).toHaveClass(/hidden/);
	});

	test('is responsive on mobile viewport', async ({ page }) => {
		await page.setViewportSize({ width: 375, height: 667 });
		await expect(page.locator('#reel-window')).toBeVisible();
		await expect(page.locator('.symbol-cell').first()).toBeVisible();
	});

	test('wallet settlement gate blocks a second spin while the first settles', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedSlotsPage(browser, baseURL);
		try {
			const settlementRequests: Record<string, unknown>[] = [];
			let releaseFirstSettlement: () => void = () => {};
			let firstSettlementIntercepted = false;
			await page.route('**/api/wallet/settle', async (route) => {
				const body = route.request().postDataJSON() as Record<string, unknown>;
				settlementRequests.push(body);
				if (!firstSettlementIntercepted) {
					firstSettlementIntercepted = true;
					await new Promise<void>((resolve) => {
						releaseFirstSettlement = resolve;
					});
				}
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ balance: 1000, duplicate: false }),
				});
			});

			await page.locator('#btn-spin').click();
			await expect.poll(async () => settlementRequests.length, { timeout: 8000 }).toBe(1);
			const first = settlementRequests[0];
			expect(first).toMatchObject({ game: 'slots' });
			expect(first.settlementId).toMatch(/^slots-/);
			expect(first.stats).toMatchObject({ rounds: 1 });

			// The first request is still pending, so a second click cannot start
			// another authenticated spin or wallet command.
			await expect(page.locator('#btn-spin')).toBeDisabled();
			await page.locator('#btn-spin').click({ force: true });
			await expect.poll(async () => settlementRequests.length).toBe(1);

			releaseFirstSettlement();
			await expect.poll(async () => settlementRequests.length, { timeout: 8000 }).toBe(1);
			await expect(page.locator('#btn-spin')).toBeEnabled({ timeout: 8000 });
		} finally {
			await context.close();
		}
	});

	test('refresh during pending spin does not create a phantom deduction', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedSlotsPage(browser, baseURL);
		try {
			const balanceBefore = Number(
				(await page.locator('#chip-balance').textContent())?.replace(/[^0-9]/g, ''),
			);

			// Start a spin, then reload before the reveal fires. The client-side
			// optimistic deduction never reaches the server (no wallet settlement for an
			// incomplete spin), so the server balance must be unchanged on reload.
			await page.locator('#btn-spin').click();
			await page.reload();
			await page.waitForSelector('#slots-root');

			const balanceAfter = Number(
				(await page.locator('#chip-balance').textContent())?.replace(/[^0-9]/g, ''),
			);
			expect(balanceAfter).toBe(balanceBefore);
		} finally {
			await context.close();
		}
	});
});
