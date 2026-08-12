import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

async function gotoBlackjack(page: Page) {
	await page.goto('/games/blackjack', { waitUntil: 'networkidle' });
}

async function dealHand(page: Page, bet: number = 50) {
	for (let attempt = 0; attempt < 5; attempt++) {
		await page.fill('#bet-amount', String(bet));
		await page.getByRole('button', { name: 'Deal' }).click();
		await page.locator('#game-controls').waitFor({ state: 'visible' });

		const newRoundButton = page.getByRole('button', { name: 'New Round' });
		const finished = await newRoundButton.isVisible().catch(() => false);
		if (!finished) return;

		await page.reload({ waitUntil: 'networkidle' });
	}

	throw new Error('Unable to reach player turn for testing');
}

test.describe('Blackjack AI Rival - local-first advice', () => {
	test('no provider configuration still gives local advice', async ({ page }) => {
		await page.addInitScript(() => localStorage.removeItem('arcturus-ai-settings'));
		const providerRequests: string[] = [];
		page.on('request', (request) => {
			if (
				request.url().includes('api.openai.com') ||
				request.url().includes('generativelanguage.googleapis.com')
			) {
				providerRequests.push(request.url());
			}
		});

		await gotoBlackjack(page);
		await dealHand(page, 50);
		const aiButton = page.getByRole('button', { name: 'Ask AI Rival' });
		await expect(aiButton).toBeEnabled();
		await aiButton.click();
		await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
		await expect(page.locator('#ai-advice-reasoning')).not.toBeEmpty();
		expect(providerRequests).toEqual([]);
	});

	test('configured provider only explains an explicit local move', async ({ page }) => {
		await page.addInitScript(() =>
			localStorage.setItem(
				'arcturus-ai-settings',
				JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-fake' }),
			),
		);
		let calls = 0;
		await page.route('https://api.openai.com/**', async (route) => {
			calls += 1;
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					choices: [{ message: { content: '{"reasoning":"Local strategy explained."}' } }],
				}),
			});
		});

		await gotoBlackjack(page);
		await dealHand(page, 50);
		expect(calls).toBe(0);
		await page.getByRole('button', { name: 'Ask AI Rival' }).click();
		await expect.poll(() => calls).toBe(1);
		await expect(page.locator('#ai-advice-reasoning')).toContainText('Local strategy explained.');

		await page.getByRole('button', { name: 'Stand' }).click();
		await expect(page.getByRole('button', { name: 'New Round' })).toBeVisible({ timeout: 15000 });
		expect(calls).toBe(1);
	});

	test('provider failure keeps the deterministic recommendation visible', async ({ page }) => {
		await page.addInitScript(() =>
			localStorage.setItem(
				'arcturus-ai-settings',
				JSON.stringify({ provider: 'openai', model: 'gpt-4o', apiKey: 'sk-fake' }),
			),
		);
		await page.route('https://api.openai.com/**', async (route) => {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: { message: 'down' } }),
			});
		});

		await gotoBlackjack(page);
		await dealHand(page, 50);
		await page.getByRole('button', { name: 'Ask AI Rival' }).click();
		await expect(page.locator('#ai-advice-action')).toContainText('Recommended:');
		await expect(page.locator('#ai-advice-reasoning')).toContainText('basic strategy');
	});
});
