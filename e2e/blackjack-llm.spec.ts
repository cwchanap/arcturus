import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { ensureLoggedIn } from './auth-helpers';

const OPENAI_ENDPOINT = 'https://api.openai.com/v1/chat/completions';

async function gotoBlackjack(page: Page) {
	await ensureLoggedIn(page);
	await page.goto('/games/blackjack', { waitUntil: 'networkidle' });

	// Ensure LLM-powered rival is enabled in game settings for these tests
	const toggleSettings = page.locator('#btn-toggle-settings');
	await toggleSettings.click();
	const useLlmCheckbox = page.locator('#setting-use-llm');
	await useLlmCheckbox.check();
	await page.locator('#btn-save-settings').click();
}

async function dealHand(page: Page, bet: number = 50) {
	for (let attempt = 0; attempt < 5; attempt++) {
		await page.fill('#bet-amount', String(bet));
		await page.getByRole('button', { name: 'Deal' }).click();
		await page.locator('#game-controls').waitFor({ state: 'visible' });

		const newRoundButton = page.getByRole('button', { name: 'New Round' });
		const finished = await newRoundButton.isVisible().catch(() => false);
		if (!finished) {
			return;
		}

		await page.reload({ waitUntil: 'networkidle' });
	}

	throw new Error('Unable to reach player turn for testing');
}

async function mockLlmSettings(page: Page, settings: Record<string, unknown> | null) {
	await page.route('**/api/profile/llm-settings', async (route) => {
		await route.fulfill({
			status: 200,
			contentType: 'application/json',
			body: JSON.stringify({ settings }),
		});
	});
}

async function mockOpenAi(
	page: Page,
	handler: (route: Route, body: unknown) => Promise<void> | void,
) {
	await page.unroute(OPENAI_ENDPOINT).catch(() => {});
	await page.route(OPENAI_ENDPOINT, async (route) => {
		const body = route.request().postDataJSON();
		await handler(route, body);
	});
}

test.describe('Blackjack AI Rival - LLM integration', () => {
	test('player with API key receives AI advice', async ({ page }) => {
		await mockLlmSettings(page, {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'test-key',
		});

		await mockOpenAi(page, async (route) => {
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					choices: [
						{
							message: {
								content: '{"action":"hit","reasoning":"Hit to escape the dealer pressure."}',
							},
						},
					],
				}),
			});
		});

		await gotoBlackjack(page);
		await dealHand(page, 50);

		const aiButton = page.getByRole('button', { name: 'Ask AI Rival' });
		await expect(aiButton).toBeEnabled();
		await aiButton.click();

		const adviceBox = page.locator('#ai-advice-box');
		await expect(adviceBox).toBeVisible();
		await expect(page.locator('#ai-advice-action')).toHaveText(/Recommended: HIT/);
		await expect(page.locator('#ai-advice-reasoning')).toContainText('dealer pressure');
	});

	test('player without API key sees configuration overlay', async ({ page }) => {
		await mockLlmSettings(page, {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: '',
		});

		await gotoBlackjack(page);
		await dealHand(page, 50);

		await page.getByRole('button', { name: 'Ask AI Rival' }).click();
		await expect(page.locator('#llm-config-overlay')).toBeVisible();
	});

	test('LLM API failure shows friendly error message', async ({ page }) => {
		await mockLlmSettings(page, {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'test-key',
		});

		await mockOpenAi(page, async (route) => {
			await route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ error: { message: 'down' } }),
			});
		});

		await gotoBlackjack(page);
		await dealHand(page, 50);

		await page.getByRole('button', { name: 'Ask AI Rival' }).click();
		await expect(page.locator('#ai-advice-box')).toBeVisible();
		await expect(page.locator('#ai-advice-action')).toHaveText('Unable to get advice');
		await expect(page.locator('#ai-advice-reasoning')).toContainText('LLM unavailable');
	});

	test('AI commentary appears after round when configured', async ({ page }) => {
		await mockLlmSettings(page, {
			provider: 'openai',
			model: 'gpt-4o',
			openaiApiKey: 'test-key',
		});

		await mockOpenAi(page, async (route, body) => {
			const content = (body as { messages?: { content: string }[] })?.messages?.[1]?.content ?? '';
			const responseText = content.includes('Result:')
				? 'Dealer cracked under the pressure.'
				: '{"action":"stand","reasoning":"Lock in the win."}';

			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({
					choices: [{ message: { content: responseText } }],
				}),
			});
		});

		await gotoBlackjack(page);
		await dealHand(page, 50);

		await page.getByRole('button', { name: 'Stand' }).click();
		await expect(page.getByRole('button', { name: 'New Round' })).toBeVisible({ timeout: 15000 });

		const commentaryBox = page.locator('#ai-commentary-box');
		await expect(commentaryBox).toBeVisible();
		await expect(page.locator('#ai-commentary-text')).toContainText('Dealer cracked');
	});
});
