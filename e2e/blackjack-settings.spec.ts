import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureLoggedIn } from './auth-helpers';

async function gotoBlackjack(page: Page) {
	await ensureLoggedIn(page);
	await page.goto('/games/blackjack', { waitUntil: 'networkidle' });
}

async function openSettingsPanel(page: Page) {
	const toggle = page.locator('#btn-toggle-settings');
	await toggle.click();
	await expect(page.locator('#settings-panel')).toBeVisible();
}

function getSettingsControls(page: Page) {
	return {
		startingChips: page.locator('#setting-starting-chips'),
		minBet: page.locator('#setting-min-bet'),
		maxBet: page.locator('#setting-max-bet'),
		dealerSpeed: page.locator('#setting-dealer-speed'),
		useLlm: page.locator('#setting-use-llm'),
		saveButton: page.locator('#btn-save-settings'),
		resetButton: page.locator('#btn-reset-settings'),
	};
}

async function dealHand(page: Page, bet: number = 50) {
	await page.fill('#bet-amount', String(bet));
	await page.getByRole('button', { name: 'Deal' }).click();
	await page.locator('#game-controls').waitFor({ state: 'visible' });
}

// Phase 6: Blackjack Game Settings (US4)
// Covers persistence, reset behaviour, bet limits, and LLM toggle wiring.
test.describe('Blackjack Game Settings', () => {
	test('persists settings across reloads', async ({ page }) => {
		await gotoBlackjack(page);
		await openSettingsPanel(page);

		const controls = getSettingsControls(page);

		await controls.startingChips.fill('1500');
		await controls.minBet.fill('20');
		await controls.maxBet.fill('200');
		await controls.dealerSpeed.selectOption('fast');
		await controls.useLlm.check();

		await controls.saveButton.click();

		await page.reload({ waitUntil: 'networkidle' });
		await openSettingsPanel(page);

		await expect(controls.startingChips).toHaveValue('1500');
		await expect(controls.minBet).toHaveValue('20');
		await expect(controls.maxBet).toHaveValue('200');
		await expect(controls.dealerSpeed).toHaveValue('fast');
		await expect(controls.useLlm).toBeChecked();
	});

	test('reset settings restores Blackjack defaults', async ({ page }) => {
		await gotoBlackjack(page);
		await openSettingsPanel(page);

		const controls = getSettingsControls(page);

		await controls.startingChips.fill('2000');
		await controls.minBet.fill('25');
		await controls.maxBet.fill('250');
		await controls.dealerSpeed.selectOption('fast');
		await controls.useLlm.check();
		await controls.saveButton.click();

		await controls.resetButton.click();

		await expect(controls.startingChips).toHaveValue('1000');
		await expect(controls.minBet).toHaveValue('10');
		await expect(controls.maxBet).toHaveValue('1000');
		await expect(controls.dealerSpeed).toHaveValue('normal');
		await expect(controls.useLlm).not.toBeChecked();
	});

	test('bet limits from settings are enforced', async ({ page }) => {
		await gotoBlackjack(page);
		await openSettingsPanel(page);

		const controls = getSettingsControls(page);

		await controls.minBet.fill('50');
		await controls.maxBet.fill('200');
		await controls.saveButton.click();

		// Invalid low bet should be rejected with clear status message
		await page.fill('#bet-amount', '10');
		await page.getByRole('button', { name: 'Deal' }).click();
		await expect(page.locator('#game-status')).toContainText('Bet must be between $50 and $200');

		// Valid bet within limits should start the round
		await page.fill('#bet-amount', '100');
		await page.getByRole('button', { name: 'Deal' }).click();
		await expect(page.locator('#game-controls')).toBeVisible();
	});

	test('LLM toggle can disable AI Rival without overlay', async ({ page }) => {
		await gotoBlackjack(page);
		await dealHand(page, 50);

		const aiButton = page.getByRole('button', { name: 'Ask AI Rival' });
		await expect(aiButton).toBeEnabled();
		await aiButton.click();

		// With default settings.useLLM = false, AI Rival should be gated by settings
		await expect(page.locator('#game-status')).toContainText(
			'AI Rival is disabled in game settings.',
		);
		await expect(page.locator('#llm-config-overlay')).toBeHidden();
	});
});
