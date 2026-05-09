import { test, expect } from '@playwright/test';

// These tests require a DO-capable server (wrangler dev, NOT astro dev).
// They are skipped unless the MP_E2E env var is set.
// Serial mode prevents ALREADY_IN_ROOM conflicts between tests sharing the same users.
const describe_ = process.env.MP_E2E ? test.describe.serial : test.describe.skip;

describe_('Multiplayer Poker', () => {
	test('two-player heads-up hand: create, join, fold, settle', async ({ browser }) => {
		const ctxA = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
		const ctxB = await browser.newContext({ storageState: 'e2e/.auth/user-2.json' });
		try {
			const pageA = await ctxA.newPage();
			const pageB = await ctxB.newPage();

			await pageA.goto('/games/poker-mp');
			await pageA.locator('select[name="maxSeats"]').selectOption('2');
			await pageA.locator('[data-testid="create-room"]').click();
			await pageA.waitForURL(/\/games\/poker-mp\/MP-/);
			const code = new URL(pageA.url()).pathname.split('/').pop()!;

			await pageA
				.locator('[data-testid="connection-status"]:has-text("Connected")')
				.waitFor({ timeout: 10000 });
			await pageA.locator('[data-testid="take-seat-0"]').click();
			await expect(pageA.locator('[data-testid="seat-0"]')).toContainText(/E2E Test User/);

			await pageB.goto(`/games/poker-mp/${code}`);
			await pageB
				.locator('[data-testid="connection-status"]:has-text("Connected")')
				.waitFor({ timeout: 10000 });
			await pageB.locator('[data-testid="take-seat-1"]').click();
			await expect(pageB.locator('[data-testid="seat-1"]')).toContainText(/E2E Test User 2/);

			await pageA.locator('[data-testid="start-hand"]').click();
			await expect(pageA.locator('[data-testid="hole-cards"] span').first()).toBeVisible({
				timeout: 5000,
			});
			await expect(pageB.locator('[data-testid="hole-cards"] span').first()).toBeVisible({
				timeout: 5000,
			});

			await pageA.locator('[data-action="fold"]').click();

			await expect(pageA.locator('[data-testid="log"]')).toContainText('Hand ended', {
				timeout: 5000,
			});
			await expect(pageB.locator('[data-testid="log"]')).toContainText('Hand ended', {
				timeout: 5000,
			});
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});

	test('disconnect mid-hand triggers 30s auto-fold', async ({ browser }) => {
		test.slow();
		const ctxA = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
		const ctxB = await browser.newContext({ storageState: 'e2e/.auth/user-2.json' });
		try {
			const pageA = await ctxA.newPage();
			const pageB = await ctxB.newPage();

			await pageA.goto('/games/poker-mp');
			await pageA.locator('select[name="maxSeats"]').selectOption('2');
			await pageA.locator('[data-testid="create-room"]').click();
			await pageA.waitForURL(/\/games\/poker-mp\/MP-/);
			const code = new URL(pageA.url()).pathname.split('/').pop()!;

			await pageA
				.locator('[data-testid="connection-status"]:has-text("Connected")')
				.waitFor({ timeout: 10000 });
			await pageA.locator('[data-testid="take-seat-0"]').click();
			await pageB.goto(`/games/poker-mp/${code}`);
			await pageB
				.locator('[data-testid="connection-status"]:has-text("Connected")')
				.waitFor({ timeout: 10000 });
			await pageB.locator('[data-testid="take-seat-1"]').click();
			await pageA.locator('[data-testid="start-hand"]').click();
			await expect(pageB.locator('[data-testid="hole-cards"] span').first()).toBeVisible({
				timeout: 5000,
			});

			// Close B abruptly. A should see seat 1 emptied after the 30s reconnect timeout.
			await ctxB.close();

			await expect(pageA.locator('[data-testid="seat-1"]')).toContainText(/\(empty\)/, {
				timeout: 35_000,
			});
		} finally {
			await ctxA.close();
		}
	});
});
