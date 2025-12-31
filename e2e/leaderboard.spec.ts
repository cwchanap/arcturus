import { test, expect } from '@playwright/test';

test.describe('Leaderboard Page', () => {
	test('displays leaderboard with rankings', async ({ page }) => {
		await page.goto('/games/leaderboard');

		// Check page title (use getByRole for specificity)
		await expect(page.getByRole('heading', { name: /Leaderboard/ })).toBeVisible();

		// Check table headers are present
		await expect(page.locator('th').filter({ hasText: 'Rank' })).toBeVisible();
		await expect(page.locator('th').filter({ hasText: 'Player' })).toBeVisible();
		await expect(page.locator('th').filter({ hasText: 'Chip Balance' })).toBeVisible();
	});

	test('shows leaderboard table with player entries', async ({ page }) => {
		await page.goto('/games/leaderboard');

		// Verify the leaderboard table exists
		const table = page.getByTestId('leaderboard-table');
		await expect(table).toBeVisible();

		// Should have at least one row (the current user)
		const rows = table.locator('tbody tr');
		const rowCount = await rows.count();
		expect(rowCount).toBeGreaterThan(0);
	});

	test('highlights current user in the leaderboard', async ({ page }) => {
		await page.goto('/games/leaderboard');

		// Current user row should be highlighted with a special class/styling
		const currentUserRow = page.getByTestId('current-user-row');

		// Either the user is in the top 50 (row visible) or not
		const isInTop50 = (await currentUserRow.count()) > 0;

		if (isInTop50) {
			// User is in top 50 - verify highlighting
			await expect(currentUserRow).toBeVisible();
			await expect(currentUserRow.locator('text=YOU')).toBeVisible();
		} else {
			// User is not in top 50 - should see their rank below the table
			const rankInfo = page.locator("text=/You're ranked #\\d+/");
			await expect(rankInfo).toBeVisible();
		}
	});

	test('displays user rank card in header', async ({ page }) => {
		await page.goto('/games/leaderboard');

		// Should show user's rank in the header area
		await expect(page.locator('text=Your Rank')).toBeVisible();
	});

	test('shows medal emojis for top 3 players', async ({ page }) => {
		await page.goto('/games/leaderboard');

		const table = page.getByTestId('leaderboard-table');
		const rows = table.locator('tbody tr');
		const rowCount = await rows.count();

		// If there are at least 3 players, check for medals
		if (rowCount >= 1) {
			// First row should have gold medal
			const firstRow = rows.first();
			await expect(firstRow.locator('text=🥇')).toBeVisible();
		}

		if (rowCount >= 2) {
			// Second row should have silver medal
			const secondRow = rows.nth(1);
			await expect(secondRow.locator('text=🥈')).toBeVisible();
		}

		if (rowCount >= 3) {
			// Third row should have bronze medal
			const thirdRow = rows.nth(2);
			await expect(thirdRow.locator('text=🥉')).toBeVisible();
		}
	});

	test('has back to lobby link', async ({ page }) => {
		await page.goto('/games/leaderboard');

		const backLink = page.locator('a').filter({ hasText: 'Back to Lobby' });
		await expect(backLink).toBeVisible();

		// Click and verify navigation
		await backLink.click();
		await expect(page).toHaveURL('/');
	});

	test('displays how rankings work info section', async ({ page }) => {
		await page.goto('/games/leaderboard');

		// Check info section is present
		await expect(page.locator('text=How Rankings Work')).toBeVisible();
		await expect(page.locator('text=ranked by total chip balance')).toBeVisible();
	});

	test('leaderboard page is protected (requires auth)', async ({ browser }) => {
		// Use a fresh context with no stored auth state
		const context = await browser.newContext({ storageState: undefined });
		const page = await context.newPage();

		await page.goto('/games/leaderboard');

		// Should redirect to signin
		await expect(page).toHaveURL(/\/signin/);
		await context.close();
	});

	test('can navigate to leaderboard from header nav', async ({ page }) => {
		await page.goto('/');

		// Click the leaderboard link in the navigation
		const navLink = page.locator('nav a').filter({ hasText: 'Leaderboard' });
		await expect(navLink).toBeVisible();

		await navLink.click();
		await expect(page).toHaveURL('/games/leaderboard');
	});

	test('chip balances are formatted with commas', async ({ page }) => {
		await page.goto('/games/leaderboard');

		// Verify chip balance values are rendered using en-US number formatting.
		// Note: values under 1,000 will not contain a comma, but are still correctly formatted.
		const chipCells = page.getByTestId('leaderboard-table').locator('tbody tr td:nth-child(3)');
		await expect(chipCells.first()).toBeVisible();

		const cellCount = await chipCells.count();
		let matched = false;
		for (let i = 0; i < cellCount; i++) {
			const text = (await chipCells.nth(i).textContent()) ?? '';
			const numericText = text.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/)?.[0];
			if (!numericText) continue;
			const value = Number(numericText);
			if (!Number.isFinite(value)) continue;
			const formatted = new Intl.NumberFormat('en-US').format(value);
			await expect(chipCells.nth(i)).toContainText(formatted);
			matched = true;
			break;
		}

		expect(matched).toBe(true);
	});

	test('responsive layout works on mobile', async ({ page }) => {
		// Set mobile viewport
		await page.setViewportSize({ width: 375, height: 667 });

		await page.goto('/games/leaderboard');

		// Check that main elements are still visible
		await expect(page.getByRole('heading', { name: /Leaderboard/ })).toBeVisible();
		await expect(page.getByTestId('leaderboard-table')).toBeVisible();
	});
});
