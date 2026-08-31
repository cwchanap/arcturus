import { expect, test } from '@playwright/test';

test.describe('Pai Gow Poker guest', () => {
	test.use({ storageState: { cookies: [], origins: [] } });

	test('plays a deterministic Push locally without wallet settlement', async ({ page }) => {
		const walletRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
		});
		await page.addInitScript(() => {
			localStorage.removeItem('pai-gow-poker-bankroll:anonymous');
			Math.random = () => 0;
		});
		await page.goto('/games/pai-gow-poker', { waitUntil: 'domcontentloaded' });

		await expect(page.getByTestId('pai-gow-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000 chips');

		await page.locator('[data-wager="20"]').click();
		await page.getByTestId('deal-button').click();
		await expect(page.getByTestId('chip-balance')).toHaveText('980 chips');
		await expect(page.locator('[id^="pai-gow-player-slot-"][data-slot-state="card"]')).toHaveCount(
			7,
		);
		await expect(
			page.locator('[id^="pai-gow-dealer-high-slot-"][data-slot-state="facedown"]'),
		).toHaveCount(5);
		await expect(
			page.locator('[id^="pai-gow-dealer-low-slot-"][data-slot-state="facedown"]'),
		).toHaveCount(2);

		await page.getByTestId('auto-arrange-button').click();
		await expect(page.getByTestId('pai-gow-status')).toHaveText(
			'High: Straight Flush · Low: High Card',
		);
		await expect(page.locator('[data-testid="pai-gow-player-card-0"]')).toHaveAttribute(
			'aria-pressed',
			'true',
		);
		await expect(page.locator('[data-testid="pai-gow-player-card-1"]')).toHaveAttribute(
			'aria-pressed',
			'true',
		);

		await page.getByTestId('confirm-button').click();
		await expect(page.getByTestId('pai-gow-status')).toContainText('Push');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000 chips');
		await expect(
			page.locator('[id^="pai-gow-dealer-high-slot-"][data-slot-state="card"]'),
		).toHaveCount(5);
		await expect(
			page.locator('[id^="pai-gow-dealer-low-slot-"][data-slot-state="card"]'),
		).toHaveCount(2);

		for (const [index, rank] of ['10', 'J', 'Q', 'K', 'A'].entries()) {
			await expect(
				page.locator(`#pai-gow-dealer-high-slot-${index} [data-rank]`).first(),
			).toHaveText(rank);
		}
		for (const [index, rank] of ['2', '3'].entries()) {
			await expect(
				page.locator(`#pai-gow-dealer-low-slot-${index} [data-rank]`).first(),
			).toHaveText(rank);
		}

		await page.getByTestId('new-round-button').click();
		await expect(page.getByTestId('new-round-button')).toBeHidden();
		await expect(page.getByTestId('pai-gow-status')).toHaveText('Choose a wager, then deal.');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000 chips');
		await page.waitForLoadState('networkidle');
		expect(walletRequests).toEqual([]);
	});

	test('plays a deterministic guest Win with payout and persisted balance', async ({ page }) => {
		const walletRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
		});
		await page.addInitScript(() => {
			localStorage.removeItem('pai-gow-poker-bankroll:anonymous');
			Math.random = () => 0.16;
		});
		await page.goto('/games/pai-gow-poker', { waitUntil: 'domcontentloaded' });

		await expect(page.getByTestId('pai-gow-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000 chips');

		await page.locator('[data-wager="20"]').click();
		await page.getByTestId('deal-button').click();
		await expect(page.getByTestId('chip-balance')).toHaveText('980 chips');

		await page.getByTestId('auto-arrange-button').click();
		await page.getByTestId('confirm-button').click();

		await expect(page.getByTestId('pai-gow-status')).toContainText('Player wins');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,019 chips');

		await page.getByTestId('new-round-button').click();
		await expect(page.getByTestId('new-round-button')).toBeHidden();
		await expect(page.getByTestId('chip-balance')).toHaveText('1,019 chips');
		await page.waitForLoadState('networkidle');
		expect(walletRequests).toEqual([]);
	});

	test('plays a deterministic guest Loss with wager deducted', async ({ page }) => {
		const walletRequests: string[] = [];
		page.on('request', (request) => {
			if (request.url().includes('/api/wallet/settle')) walletRequests.push(request.url());
		});
		await page.addInitScript(() => {
			localStorage.removeItem('pai-gow-poker-bankroll:anonymous');
			Math.random = () => 0.07;
		});
		await page.goto('/games/pai-gow-poker', { waitUntil: 'domcontentloaded' });

		await expect(page.getByTestId('pai-gow-root')).toHaveAttribute('data-guest-mode', 'true');
		await expect(page.getByTestId('chip-balance')).toHaveText('1,000 chips');

		await page.locator('[data-wager="20"]').click();
		await page.getByTestId('deal-button').click();
		await expect(page.getByTestId('chip-balance')).toHaveText('980 chips');

		await page.getByTestId('auto-arrange-button').click();
		await page.getByTestId('confirm-button').click();

		await expect(page.getByTestId('pai-gow-status')).toContainText('Loss');
		await expect(page.getByTestId('chip-balance')).toHaveText('980 chips');

		await page.getByTestId('new-round-button').click();
		await expect(page.getByTestId('new-round-button')).toBeHidden();
		await expect(page.getByTestId('chip-balance')).toHaveText('980 chips');
		await page.waitForLoadState('networkidle');
		expect(walletRequests).toEqual([]);
	});
});

test.describe('Pai Gow Poker wallet', () => {
	test.use({ storageState: 'e2e/.auth/user.json' });

	test('authenticated deterministic Push settles exactly once', async ({ page }) => {
		const commands: Array<Record<string, unknown>> = [];
		await page.addInitScript(() => {
			Math.random = () => 0;
		});
		await page.goto('/games/pai-gow-poker', { waitUntil: 'domcontentloaded' });
		await expect(page.getByTestId('pai-gow-root')).toHaveAttribute('data-guest-mode', 'false');

		await page.route('**/api/wallet/settle', async (route) => {
			const command = route.request().postDataJSON() as Record<string, unknown>;
			commands.push(command);
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ balance: 1000, duplicate: false }),
			});
		});

		await page.locator('[data-wager="20"]').click();
		await page.getByTestId('deal-button').click();
		await page.getByTestId('auto-arrange-button').click();
		await page.getByTestId('confirm-button').click();

		await expect(page.getByTestId('pai-gow-status')).toContainText('Push');
		await expect.poll(() => commands.length).toBe(1);
		expect(commands[0]).toMatchObject({
			game: 'pai-gow-poker',
			delta: 0,
			stats: { rounds: 1, wins: 0, losses: 0, biggestWin: 0 },
		});
	});

	test('authenticated deterministic Win settles exactly once with positive delta', async ({
		page,
	}) => {
		const commands: Array<Record<string, unknown>> = [];
		await page.addInitScript(() => {
			Math.random = () => 0.16;
		});
		await page.goto('/games/pai-gow-poker', { waitUntil: 'domcontentloaded' });
		await expect(page.getByTestId('pai-gow-root')).toHaveAttribute('data-guest-mode', 'false');

		await page.route('**/api/wallet/settle', async (route) => {
			const command = route.request().postDataJSON() as Record<string, unknown>;
			commands.push(command);
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ balance: 1019, duplicate: false }),
			});
		});

		await page.locator('[data-wager="20"]').click();
		await page.getByTestId('deal-button').click();
		await page.getByTestId('auto-arrange-button').click();
		await page.getByTestId('confirm-button').click();

		await expect(page.getByTestId('pai-gow-status')).toContainText('Player wins');
		await expect.poll(() => commands.length).toBe(1);
		expect(commands[0]).toMatchObject({
			game: 'pai-gow-poker',
			delta: 19,
			stats: { rounds: 1, wins: 1, losses: 0, biggestWin: 19 },
		});
	});

	test('authenticated deterministic Loss settles exactly once with negative delta', async ({
		page,
	}) => {
		const commands: Array<Record<string, unknown>> = [];
		await page.addInitScript(() => {
			Math.random = () => 0.07;
		});
		await page.goto('/games/pai-gow-poker', { waitUntil: 'domcontentloaded' });
		await expect(page.getByTestId('pai-gow-root')).toHaveAttribute('data-guest-mode', 'false');

		await page.route('**/api/wallet/settle', async (route) => {
			const command = route.request().postDataJSON() as Record<string, unknown>;
			commands.push(command);
			await route.fulfill({
				status: 200,
				contentType: 'application/json',
				body: JSON.stringify({ balance: 980, duplicate: false }),
			});
		});

		await page.locator('[data-wager="20"]').click();
		await page.getByTestId('deal-button').click();
		await page.getByTestId('auto-arrange-button').click();
		await page.getByTestId('confirm-button').click();

		await expect(page.getByTestId('pai-gow-status')).toContainText('Loss');
		await expect.poll(() => commands.length).toBe(1);
		expect(commands[0]).toMatchObject({
			game: 'pai-gow-poker',
			delta: -20,
			stats: { rounds: 1, wins: 0, losses: 1, biggestWin: 0 },
		});
	});
});
