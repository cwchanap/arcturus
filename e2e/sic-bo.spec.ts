import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

async function gotoSicBo(page: Page): Promise<void> {
	await page.goto('/games/sic-bo', { waitUntil: 'domcontentloaded' });
}

const createIsolatedSicBoPage = (browser: Browser, baseURL?: string) =>
	createIsolatedPage(browser, baseURL, {
		emailPrefix: 'sic-bo-wallet',
		namePrefix: 'Sic Bo Wallet',
		navigate: gotoSicBo,
	});

async function placeBigBet(page: Page): Promise<void> {
	await page.locator('[data-denomination="5"]').click();
	await expect(page.locator('[data-denomination="5"]')).toHaveAttribute('aria-pressed', 'true');
	await page.locator('[data-bet-key="big"]').click();
	await expect(page.locator('[data-bet-key="big"] [data-bet-amount]')).toHaveText('5');
}

test.describe('Sic Bo guest', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('deterministic win round shows the roll, pays out, and retains the slip', async ({
		page,
	}) => {
		const walletRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
		});
		await page.addInitScript(() => {
			const sequence = [0, 0.5, 0.9]; // dice [1,4,6], total 11 => Big + Odd
			let index = 0;
			Math.random = () => sequence[index++ % sequence.length]!;
		});
		await gotoSicBo(page);

		// 1. Loads in guest mode with the default bankroll.
		await expect(page.getByTestId('sic-bo-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000');

		// 2. Choose denomination 5 and Big.
		await placeBigBet(page);
		await expect(page.getByTestId('sic-bo-total-stake')).toHaveText('Total stake: 5');

		// 3. Roll shows dice 1, 4, 6.
		await page.getByTestId('sic-bo-action').click();
		for (const [index, value] of ['1', '4', '6'].entries()) {
			await expect(page.getByTestId(`sic-bo-die-${index}`)).toHaveAttribute('data-value', value);
			await expect(page.getByTestId(`sic-bo-die-${index}`)).toHaveText(value);
		}

		// 4. Big wins: balance increases by 5.
		await expect(page.getByTestId('sic-bo-result')).toHaveText('Won +5');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,005');

		// 5. Action becomes enabled New Round.
		await expect(page.getByTestId('sic-bo-action')).toHaveText('New Round');
		await expect(page.getByTestId('sic-bo-action')).toBeEnabled();

		// 6. New Round returns to betting with the retained Big wager.
		await page.getByTestId('sic-bo-action').click();
		await expect(page.getByTestId('sic-bo-action')).toHaveText('Roll');
		await expect(page.locator('[data-bet-key="big"] [data-bet-amount]')).toHaveText('5');
		await expect(page.getByTestId('sic-bo-total-stake')).toHaveText('Total stake: 5');
		await expect(page.getByTestId('sic-bo-action')).toBeEnabled();

		// 7. No wallet request was made.
		expect(walletRequests).toEqual([]);
	});
});

test.describe('Sic Bo wallet', () => {
	test('authenticated roll settles once and adopts the returned balance', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedSicBoPage(browser, baseURL);
		try {
			const commands: Array<Record<string, unknown>> = [];
			await page.route('**/api/wallet/settle', async (route) => {
				const command = route.request().postDataJSON() as Record<string, unknown>;
				commands.push(command);
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ balance: 4242, duplicate: false }),
				});
			});

			await expect(page.getByTestId('sic-bo-root')).toHaveAttribute('data-guest-mode', 'false');
			await placeBigBet(page);
			await page.getByTestId('sic-bo-action').click();

			// Exactly one settlement command for this Sic Bo round.
			await expect.poll(async () => commands.length).toBe(1);
			expect(commands[0]).toMatchObject({ game: 'sic-bo', stats: { rounds: 1 } });
			expect(commands[0].settlementId).toMatch(/^sic-bo-/);

			// The known balance is adopted before New Round is enabled.
			await expect(page.getByTestId('chip-balance')).toHaveText('4,242');
			await expect(page.getByTestId('sic-bo-action')).toHaveText('New Round');
			await expect(page.getByTestId('sic-bo-action')).toBeEnabled();
		} finally {
			await context.close();
		}
	});

	test('failed settlement shows recovery and Retry reuses the exact command', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedSicBoPage(browser, baseURL);
		try {
			const commands: Array<Record<string, unknown>> = [];
			await page.route('**/api/wallet/settle', async (route) => {
				const command = route.request().postDataJSON() as Record<string, unknown>;
				commands.push(command);
				if (commands.length === 1) {
					await route.fulfill({
						status: 503,
						contentType: 'application/json',
						body: JSON.stringify({ error: 'offline' }),
					});
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({ balance: 4242, duplicate: false }),
				});
			});

			await placeBigBet(page);
			await page.getByTestId('sic-bo-action').click();

			// First settlement fails: recovery controls appear and New Round stays disabled.
			await expect(page.locator('#sic-bo-settlement-recovery')).toBeVisible();
			await expect(page.locator('#sic-bo-retry-settlement')).toBeVisible();
			await expect(page.locator('#sic-bo-reset-settlement')).toBeVisible();
			await expect(page.getByTestId('sic-bo-action')).toHaveText('New Round');
			await expect(page.getByTestId('sic-bo-action')).toBeDisabled();
			expect(commands).toHaveLength(1);

			// Retry succeeds with the exact same command (including settlement ID).
			await page.locator('#sic-bo-retry-settlement').click();
			await expect(page.locator('#sic-bo-settlement-recovery')).toBeHidden();
			expect(commands).toHaveLength(2);
			expect(commands[1]).toEqual(commands[0]);

			// The authoritative balance is adopted and New Round becomes enabled.
			await expect(page.getByTestId('chip-balance')).toHaveText('4,242');
			await expect(page.getByTestId('sic-bo-action')).toBeEnabled();
		} finally {
			await context.close();
		}
	});
});
