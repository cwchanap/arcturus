import { expect, test } from '@playwright/test';

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

	test('spin deducts the bet and updates balance without reload', async ({ page }) => {
		const balanceBefore = await page.locator('#chip-balance').textContent();
		await page.locator('.bet-chip[data-bet="1"]').click();
		await expect(page.locator('#current-bet')).toHaveText('1');
		await page.locator('#btn-spin').click();
		// Balance should change (deduct or win) without a navigation.
		// Poll because the reveal (and the optimistic balance update) happens
		// after the spin animation (~1100ms at normal speed).
		await expect
			.poll(async () => page.locator('#chip-balance').textContent())
			.not.toEqual(balanceBefore);
		expect(page.url()).toContain('/games/slots');
	});

	test('selecting the max bet keeps the spin button enabled', async ({ page }) => {
		// Cannot force a tiny balance without auth manipulation; instead verify
		// the max-bet chip selects 100 and the spin button remains enabled.
		await page.locator('.bet-chip[data-bet="100"]').click();
		await expect(page.locator('#current-bet')).toHaveText('100');
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

	test('rapid double-spin sends distinct client syncIds (no client-side reuse)', async ({
		page,
	}) => {
		const syncRequests: string[] = [];
		page.on('request', (req) => {
			if (req.url().endsWith('/api/chips/update') && req.method() === 'POST') {
				const body = req.postDataJSON();
				if (body?.gameType === 'slots') syncRequests.push(body.syncId);
			}
		});

		// Stall the first chip sync so the coordinator stays in-flight when
		// spin 2 fires. This deterministically exercises the coalescing path
		// (handleRoundComplete → isBusy → syncPending) rather than relying on
		// timing between the button re-enable and the sync fetch.
		//
		// NOTE: page.on('request') fires BEFORE the route handler (Playwright
		// emits the 'request' event when the page issues the request, then route
		// handlers intercept). So we can't gate the stall on syncRequests.length
		// — it would already be 1 inside the route handler. Instead, use a flag
		// set inside the route handler itself.
		let firstRequestIntercepted = false;
		let resolveFirstSync: () => void = () => {};
		await page.route('**/api/chips/update', async (route) => {
			if (!firstRequestIntercepted) {
				firstRequestIntercepted = true;
				await new Promise<void>((resolve) => {
					resolveFirstSync = resolve;
				});
			}
			await route.continue();
		});

		// Spin 1 — wait for reveal (button re-enables after the spin animation).
		await page.locator('#btn-spin').click();
		await expect(page.locator('#btn-spin')).toBeEnabled({ timeout: 5000 });
		// Spin 2 immediately after the first settles. Sync 1 is still in-flight
		// (stalled by the route handler), so the coordinator must coalesce.
		await page.locator('#btn-spin').click();
		await expect(page.locator('#btn-spin')).toBeEnabled({ timeout: 5000 });

		// Release the stalled sync so both rounds can settle.
		resolveFirstSync();

		// Coalescing should produce 2 syncs: sync 1 (stalled) then sync 2
		// (flushed from syncPending after sync 1 completes). Every syncId
		// must be unique.
		await expect.poll(async () => syncRequests.length, { timeout: 8000 }).toBeGreaterThanOrEqual(2);
		const unique = new Set(syncRequests);
		expect(unique.size).toBe(syncRequests.length);
	});

	test('refresh during pending spin does not create a phantom deduction', async ({ page }) => {
		const balanceBefore = Number(
			(await page.locator('#chip-balance').textContent())?.replace(/[^0-9]/g, ''),
		);

		// Start a spin, then reload before the reveal fires. The client-side
		// optimistic deduction never reaches the server (no chip sync for an
		// incomplete spin), so the server balance must be unchanged on reload.
		await page.locator('#btn-spin').click();
		await page.reload();
		await page.waitForSelector('#slots-root');

		const balanceAfter = Number(
			(await page.locator('#chip-balance').textContent())?.replace(/[^0-9]/g, ''),
		);
		expect(balanceAfter).toBe(balanceBefore);
	});
});
