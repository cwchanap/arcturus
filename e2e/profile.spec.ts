import { test, expect } from '@playwright/test';
import { AUTH_FILE, TEST_USER } from './auth.setup';
import { bootstrapTestUser } from './bootstrap-auth';

test.describe('Profile Page', () => {
	test.beforeEach(async ({ page }) => {
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
		await expect(page.locator('text=Try a different single-player table')).toBeVisible();
		await expect(page.locator('text=Create a private poker room')).toBeVisible();
	});

	test('displays performance summary between casino tips and AI rival settings', async ({
		page,
	}) => {
		const summary = page.locator('section[aria-labelledby="player-performance-heading"]');

		await expect(summary).toBeVisible();
		await expect(summary.getByText('All-time casual play')).toBeVisible();
		await expect(summary.getByRole('link', { name: 'View detailed statistics' })).toHaveAttribute(
			'href',
			'/profile/statistics',
		);

		const sectionHeadings = await page.locator('main h2').allTextContents();
		const casinoTipsIndex = sectionHeadings.indexOf('Casino Tips');
		const playerPerformanceIndex = sectionHeadings.indexOf('Player Performance');
		const aiRivalSettingsIndex = sectionHeadings.indexOf('AI Rival Settings');

		expect(casinoTipsIndex).toBeGreaterThanOrEqual(0);
		expect(playerPerformanceIndex).toBeGreaterThan(casinoTipsIndex);
		expect(aiRivalSettingsIndex).toBeGreaterThan(playerPerformanceIndex);
	});

	test('marks authenticated profile HTML responses private and no-store', async ({ page }) => {
		const profileResponse = await page.goto('/profile');
		expect(profileResponse?.status()).toBe(200);
		expect(profileResponse?.headers()['cache-control']).toBe('private, no-store');

		const statisticsResponse = await page.goto('/profile/statistics');
		expect(statisticsResponse?.status()).toBe(200);
		expect(statisticsResponse?.headers()['cache-control']).toBe('private, no-store');
	});

	test('statistics no-JavaScript shell keeps one main landmark and fallback outside busy state', async ({
		browser,
		baseURL,
	}) => {
		const appUrl = baseURL ?? 'http://localhost:2000';
		const context = await browser.newContext({
			baseURL: appUrl,
			javaScriptEnabled: false,
			storageState: AUTH_FILE,
		});
		const page = await context.newPage();

		await page.goto('/profile/statistics');

		await expect(page).toHaveURL(/\/profile\/statistics$/);
		await expect(page.locator('main')).toHaveCount(1);
		await expect(page.locator('#player-statistics-root')).toHaveJSProperty('tagName', 'SECTION');
		await expect(page.locator('noscript')).toHaveCount(1);
		const fallback = page.locator('noscript p');
		await expect(fallback).toHaveText('JavaScript is required to load detailed player statistics.');
		await expect(fallback).toBeVisible();
		await expect(fallback.locator('xpath=ancestor::*[@aria-busy="true"]')).toHaveCount(0);

		await context.close();
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

	test('sign out button works', async ({ browser, baseURL }) => {
		// Use an isolated context so signing out does not invalidate the shared
		// storageState session used by other E2E tests.
		const appUrl = baseURL ?? 'http://localhost:2000';
		const context = await browser.newContext({ storageState: undefined });
		await bootstrapTestUser(context, appUrl, TEST_USER);
		const page = await context.newPage();

		await page.goto(`${appUrl}/profile`);
		await page.locator('#signout-btn').click();

		// Wait for redirect to signin page
		await page.waitForURL(`${appUrl}/signin`, { timeout: 10000 });

		// Verify we're on signin page
		await expect(page).toHaveURL(`${appUrl}/signin`);
		await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();

		await context.close();
	});

	test('profile page is protected (requires auth)', async ({ browser, baseURL }) => {
		// Use a fresh context with no stored auth state
		const appUrl = baseURL ?? 'http://localhost:2000';
		const context = await browser.newContext({ storageState: undefined });
		const page = await context.newPage();

		await page.goto(`${appUrl}/profile`);

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
