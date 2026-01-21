import { test, expect } from '@playwright/test';
import { ensureLoggedIn } from './auth-helpers';
import { TEST_USER } from './auth.setup';

test.describe('Profile Page', () => {
	test.beforeEach(async ({ page }) => {
		// Ensure user is logged in before each test
		await ensureLoggedIn(page);
		await page.goto('/profile');
	});

	test('displays user information correctly', async ({ page }) => {
		// Check page title within the main content (avoid header h1 in layout)
		const profileHeading = page.locator('main h1').first();
		await expect(profileHeading).toContainText(TEST_USER.name);

		// Check email is displayed within the Account Details section
		const accountDetails = page
			.getByRole('heading', { name: 'Account Details', level: 2 })
			.locator('xpath=..');
		await expect(accountDetails.locator('dd').filter({ hasText: TEST_USER.email })).toBeVisible();

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
		// Use a fresh context with no stored auth state
		const context = await browser.newContext({ storageState: undefined });
		const page = await context.newPage();

		await page.goto('/profile');

		await expect(page).toHaveURL(/\/signin/);
		await context.close();
	});

	test('responsive layout works on mobile', async ({ page }) => {
		// Set mobile viewport
		await page.setViewportSize({ width: 375, height: 667 });

		// Reload page with new viewport
		await page.reload();

		// Check that main profile elements are still visible
		const profileHeading = page.locator('main h1').first();
		await expect(profileHeading).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Account Details', level: 2 })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'AI Rival Settings', level: 2 })).toBeVisible();
	});
});
