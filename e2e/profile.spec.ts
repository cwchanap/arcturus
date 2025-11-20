import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { TEST_USER } from './auth.setup';

const waitForHomeRedirect = async (page: Page, timeout = 10000): Promise<boolean> => {
	try {
		await Promise.all([
			page.waitForURL((url) => url.pathname === '/', { timeout }),
			page.waitForLoadState('networkidle', { timeout }),
		]);
		return true;
	} catch {
		return false;
	}
};

async function ensureLoggedIn(page: Page) {
	await page.goto('/signin');
	await page.fill('input[name="email"]', TEST_USER.email);
	await page.fill('input[name="password"]', TEST_USER.password);
	await page.click('button[type="submit"]');

	const reachedHome = await waitForHomeRedirect(page);
	if (reachedHome || page.url().endsWith('/')) {
		return;
	}

	await page.goto('/signup');
	await page.fill('input[name="name"]', TEST_USER.name);
	await page.fill('input[name="email"]', TEST_USER.email);
	await page.fill('input[name="password"]', TEST_USER.password);
	await page.click('button[type="submit"]');
	await page.waitForURL('/', { timeout: 15000 });
	await page.waitForLoadState('networkidle', { timeout: 10000 });
}

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
		// Use a fresh context with no stored auth state
		const context = await browser.newContext({ storageState: undefined });
		const page = await context.newPage();

		await page.goto('/profile');

		await expect(page).toHaveURL(/\/signin/);
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

		// Check that main profile elements are still visible
		const profileHeading = page.locator('main h1').first();
		await expect(profileHeading).toBeVisible();
		await expect(page.getByRole('heading', { name: 'Account Details', level: 2 })).toBeVisible();
		await expect(page.getByRole('heading', { name: 'AI Rival Settings', level: 2 })).toBeVisible();
	});
});
