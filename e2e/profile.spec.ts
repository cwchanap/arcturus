import { test, expect } from '@playwright/test';
import { TEST_USER } from './auth.setup';

test.describe('Profile Page', () => {
	test.beforeEach(async ({ page }) => {
		// Navigate to profile page (already authenticated via global setup)
		await page.goto('/profile');
	});

	test('displays user information correctly', async ({ page }) => {
		// Check page title
		await expect(page.locator('h1')).toContainText('E2E Test User');

		// Check email is displayed
		await expect(page.locator('text=' + TEST_USER.email)).toBeVisible();

		// Check profile sections are present
		await expect(page.locator('text=Account Details')).toBeVisible();
		await expect(page.locator('text=Casino Tips')).toBeVisible();
	});

	test('displays account details section', async ({ page }) => {
		// Check Account Details section container tied to the "Account Details" heading
		const accountDetails = page
			.getByRole('heading', { name: 'Account Details', level: 2 })
			.locator('xpath=..');

		await expect(accountDetails.getByText('Player Name')).toBeVisible();
		await expect(accountDetails.getByText('Email Address')).toBeVisible();
		await expect(accountDetails.getByText('Email Status')).toBeVisible();
	});

	test('displays casino tips section', async ({ page }) => {
		// Check Casino Tips are visible
		await expect(page.locator('text=Claim your daily chip bonus')).toBeVisible();
		await expect(page.locator('text=Visit the tournaments page')).toBeVisible();
		await expect(page.locator('text=Invite friends for exclusive')).toBeVisible();
	});

	test('displays AI rival settings section', async ({ page }) => {
		// Check AI Rival Settings section
		await expect(page.locator('text=AI Rival Settings')).toBeVisible();

		// Check provider selector
		const providerSelect = page.locator('#ai-provider');
		await expect(providerSelect).toBeVisible();

		// Check model selector
		const modelSelect = page.locator('#ai-model');
		await expect(modelSelect).toBeVisible();

		// Check API key input
		const apiKeyInput = page.locator('#api-key');
		await expect(apiKeyInput).toBeVisible();

		// Check save button
		await expect(page.locator('button:has-text("Save Rival Preferences")')).toBeVisible();
	});

	test('can change AI provider', async ({ page }) => {
		const providerSelect = page.locator('#ai-provider');
		const modelSelect = page.locator('#ai-model');

		// Get initial provider
		const initialProvider = await providerSelect.inputValue();

		// Change to different provider
		const targetProvider = initialProvider === 'openai' ? 'gemini' : 'openai';
		await providerSelect.selectOption(targetProvider);

		// Verify provider changed
		await expect(providerSelect).toHaveValue(targetProvider);

		// Verify model options updated
		const modelValue = await modelSelect.inputValue();
		if (targetProvider === 'openai') {
			expect(modelValue).toContain('gpt');
		} else {
			expect(modelValue).toContain('gemini');
		}
	});

	test('can change AI model', async ({ page }) => {
		const modelSelect = page.locator('#ai-model');

		// Get initial model
		const initialModel = await modelSelect.inputValue();

		// Get all options
		const options = await modelSelect.locator('option').all();

		// If there are multiple options, select a different one
		if (options.length > 1) {
			const secondOption = await options[1].getAttribute('value');
			if (secondOption && secondOption !== initialModel) {
				await modelSelect.selectOption(secondOption);
				await expect(modelSelect).toHaveValue(secondOption);
			}
		}
	});

	test('API key input has correct placeholder', async ({ page }) => {
		const providerSelect = page.locator('#ai-provider');
		const apiKeyInput = page.locator('#api-key');

		// Check OpenAI placeholder
		await providerSelect.selectOption('openai');
		await expect(apiKeyInput).toHaveAttribute('placeholder', 'sk-...');

		// Check Gemini placeholder
		await providerSelect.selectOption('gemini');
		await expect(apiKeyInput).toHaveAttribute('placeholder', 'AIza...');
	});

	test('can save AI settings without API key', async ({ page }) => {
		const providerSelect = page.locator('#ai-provider');
		const modelSelect = page.locator('#ai-model');
		const saveButton = page.locator('button:has-text("Save Rival Preferences")');

		// Select settings
		await providerSelect.selectOption('openai');
		await modelSelect.selectOption('gpt-4o');

		// Click save
		await saveButton.click();

		// Wait for the save operation to complete before asserting
		await page.waitForResponse(
			(response) =>
				response.url().includes('/api/profile/llm-settings') && response.status() === 200,
		);

		// Verify no error occurred and page is still on profile
		await expect(page).toHaveURL('/profile');
	});

	test('sign out button works', async ({ page }) => {
		const signoutBtn = page.locator('#signout-btn');

		// Click sign out
		await signoutBtn.click();

		// Wait for redirect to signin page
		await page.waitForURL('/signin', { timeout: 10000 });

		// Verify we're on signin page
		await expect(page).toHaveURL('/signin');
		await expect(page.locator('text=Sign in to continue')).toBeVisible();
	});

	test('profile page is protected (requires auth)', async ({ browser }) => {
		// Create a new context without auth state
		const context = await browser.newContext();
		const page = await context.newPage();

		// Try to access profile without auth
		await page.goto('/profile');

		// Should redirect to signin
		await page.waitForURL('/signin', { timeout: 10000 });
		await expect(page).toHaveURL('/signin');

		await context.close();
	});

	test('displays user avatar or initial', async ({ page }) => {
		// Locate avatar using semantic test id instead of Tailwind classes
		const avatarContainer = page.getByTestId('user-avatar');
		await expect(avatarContainer).toBeVisible();

		// Should contain either an image or text initial
		const hasImage = await avatarContainer.locator('img').count();
		const hasText = await avatarContainer.locator('span').count();

		expect(hasImage + hasText).toBeGreaterThan(0);
	});

	test('responsive layout works on mobile', async ({ page }) => {
		// Set mobile viewport
		await page.setViewportSize({ width: 375, height: 667 });

		// Reload page with new viewport
		await page.reload();

		// Check that main elements are still visible
		await expect(page.locator('h1')).toBeVisible();
		await expect(page.locator('text=Account Details')).toBeVisible();
		await expect(page.locator('text=AI Rival Settings')).toBeVisible();
	});
});
