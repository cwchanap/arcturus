import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';

async function gotoCraps(page: Page) {
	await page.goto('/games/craps', { waitUntil: 'networkidle' });
}

async function createIsolatedCrapsPage(browser: Browser, baseURL?: string) {
	const context = await browser.newContext({ baseURL: baseURL ?? 'http://localhost:2000' });
	const page = await context.newPage();
	const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

	await page.goto('/signup', { waitUntil: 'domcontentloaded' });
	await page.fill('input[name="name"]', `Craps Sync ${nonce}`);
	await page.fill('input[name="email"]', `craps-sync-${nonce}@arcturus.local`);
	await page.fill('input[name="password"]', 'PlaywrightTest123!');
	await Promise.all([
		page.waitForURL('/', { timeout: 15000 }),
		page.click('button[type="submit"]'),
	]);
	await page.waitForLoadState('domcontentloaded');
	await gotoCraps(page);

	return { context, page };
}

function parseBalance(text: string): number {
	const normalized = text.replace(/,/g, '');
	const match = normalized.match(/-?\d+(?:\.\d+)?/);
	return Number(match?.[0] ?? '0');
}

async function ensureMinimumBalance(page: Page, minimumBalance: number): Promise<void> {
	const maxAttempts = 5;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		await gotoCraps(page);
		const balanceText = await page
			.locator('#chip-balance')
			.innerText()
			.catch(() => '');
		const balance = parseBalance(balanceText);
		if (balance >= minimumBalance) return;

		const delta = minimumBalance - balance;
		const result = await page.evaluate(
			async ({ delta, previousBalance }) => {
				const response = await fetch('/api/chips/update', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						delta,
						gameType: 'craps',
						previousBalance,
					}),
				});

				return {
					ok: response.ok,
					status: response.status,
					retryAfter: response.headers.get('Retry-After'),
				};
			},
			{ delta, previousBalance: balance },
		);

		if (result.ok || result.status === 409) continue;
		if (result.status === 429) {
			const retryAfter = Number(result.retryAfter ?? '2');
			const sleepMs = (Number.isFinite(retryAfter) ? retryAfter : 2) * 1000 + 100;
			await page.waitForTimeout(sleepMs);
			continue;
		}

		throw new Error(`Failed to top up craps balance for test (status ${result.status})`);
	}

	throw new Error(`Failed to reach minimum craps balance ${minimumBalance} after retries`);
}

test.describe('Craps — Initial State', () => {
	test('loads page with correct initial state', async ({ page }) => {
		await gotoCraps(page);

		await expect(page.getByRole('heading', { name: 'Craps', exact: true })).toBeVisible();
		await expect(page.locator('#chip-balance')).toBeVisible();
		await expect(page.locator('#phase-badge')).toContainText('Come-Out');
		await expect(page.getByTestId('roll-button')).toBeDisabled();
		await expect(page.locator('[data-bet-type="passLine"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="dontPass"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="field"]')).toBeVisible();
	});

	test('odds row is hidden during come-out', async ({ page }) => {
		await gotoCraps(page);
		await expect(page.locator('#odds-row')).toBeHidden();
	});
});

test.describe('Craps — Bet Placement', () => {
	test('places a Pass Line bet and enables Roll button', async ({ page }) => {
		await gotoCraps(page);
		await ensureMinimumBalance(page, 25);

		// Select $25 chip
		await page.getByTestId('chip-25').click();
		await page.click('[data-bet-type="passLine"]');

		await expect(page.getByTestId('total-bet')).toContainText('$25');
		await expect(page.getByTestId('roll-button')).toBeEnabled();
	});

	test('places multiple bet types', async ({ page }) => {
		await gotoCraps(page);
		await ensureMinimumBalance(page, 10);

		await page.getByTestId('chip-5').click();
		await page.click('[data-bet-type="passLine"]');
		await page.click('[data-bet-type="field"]');

		await expect(page.getByTestId('total-bet')).toContainText('$10');
	});

	test('Clear Bets removes all bets and resets total', async ({ page }) => {
		await gotoCraps(page);
		await ensureMinimumBalance(page, 25);

		await page.getByTestId('chip-25').click();
		await page.click('[data-bet-type="passLine"]');
		await page.getByTestId('clear-bets-button').click();

		await expect(page.getByTestId('total-bet')).toContainText('$0');
		await expect(page.getByTestId('roll-button')).toBeDisabled();
	});
});

test.describe('Craps — Game Flow', () => {
	test('rolling dice shows total and updates message', async ({ page }) => {
		await gotoCraps(page);
		await ensureMinimumBalance(page, 25);

		await page.getByTestId('chip-25').click();
		await page.click('[data-bet-type="passLine"]');
		await page.getByTestId('roll-button').click();

		// Wait for roll to complete (animation ~420ms + processing)
		await page.waitForTimeout(800);

		// Roll total should be a number 2–12
		const totalText = await page.locator('#roll-total').textContent();
		const total = parseInt(totalText ?? '0');
		expect(total).toBeGreaterThanOrEqual(2);
		expect(total).toBeLessThanOrEqual(12);

		// Message should be non-empty
		const msg = await page.locator('#game-message').textContent();
		expect(msg).toBeTruthy();
		expect(msg!.length).toBeGreaterThan(0);
	});

	test('rolling a point establishes point phase', async ({ page }) => {
		await gotoCraps(page);
		await ensureMinimumBalance(page, 100);

		// Keep rolling until a point is established
		await page.getByTestId('chip-5').click();
		await page.click('[data-bet-type="passLine"]');

		let pointEstablished = false;
		for (let attempt = 0; attempt < 15; attempt++) {
			await page.getByTestId('roll-button').click();
			await page.waitForTimeout(700);

			const phase = await page.locator('#phase-badge').textContent();
			if (phase?.includes('Point')) {
				pointEstablished = true;
				break;
			}
			// If natural or craps, place a new pass line bet and try again
			const rollBtn = page.getByTestId('roll-button');
			const disabled = await rollBtn.isDisabled();
			if (disabled) {
				await page.click('[data-bet-type="passLine"]');
			}
		}

		expect(pointEstablished).toBe(true);
		await expect(page.locator('#point-badge')).toBeVisible();
		await expect(page.locator('#odds-row')).toBeVisible();
	});

	test('roll history is populated after rolls', async ({ page }) => {
		await gotoCraps(page);
		await ensureMinimumBalance(page, 10);

		await page.getByTestId('chip-5').click();
		await page.click('[data-bet-type="passLine"]');
		await page.click('[data-bet-type="field"]');
		await expect(page.getByTestId('total-bet')).toContainText('$10');
		await page.getByTestId('roll-button').click();
		await page.waitForTimeout(700);

		const badges = page.getByTestId('roll-history').locator('.roll-badge');
		await expect(badges).toHaveCount(1);
	});
});

test.describe('Craps — Active Bets Panel', () => {
	test('active bets shows placed bet', async ({ page }) => {
		await gotoCraps(page);

		await ensureMinimumBalance(page, 50);

		await page.getByTestId('chip-50').click();
		await page.click('[data-bet-type="passLine"]');

		await expect(page.getByTestId('total-bet')).toContainText('$50');
		await expect(page.getByTestId('active-bets')).toContainText('Pass Line');
		await expect(page.getByTestId('active-bets')).toContainText('$50');
	});

	test('balance decreases when bet is placed', async ({ page }) => {
		await ensureMinimumBalance(page, 100);

		const balanceBefore = parseBalance(await page.locator('#chip-balance').innerText());

		await page.getByTestId('chip-100').click();
		await page.click('[data-bet-type="passLine"]');
		await expect(page.getByTestId('total-bet')).toContainText('$100');

		const balanceAfter = parseBalance(await page.locator('#chip-balance').innerText());

		expect(balanceAfter).toBe(balanceBefore - 100);
	});
});

test.describe('Craps — Clear Bets Sync', () => {
	test('clearing bets syncs refunded chips to server', async ({ browser, baseURL }) => {
		const { context, page } = await createIsolatedCrapsPage(browser, baseURL);
		try {
			await ensureMinimumBalance(page, 200);

			// Place some removable bets
			await page.getByTestId('chip-25').click();
			await page.click('[data-bet-type="passLine"]');
			await page.click('[data-bet-type="field"]');
			await page.click('[data-bet-type="field"]');

			const balanceBeforeClear = parseBalance(await page.locator('#chip-balance').innerText());

			// Clear bets
			await page.getByTestId('clear-bets-button').click();

			// Balance should be refunded locally
			const balanceAfterClear = parseBalance(await page.locator('#chip-balance').innerText());
			expect(balanceAfterClear).toBe(balanceBeforeClear + 75); // passLine $25 + field $50

			const persistedSessionKey = await page.locator('#craps-root').evaluate((root) => {
				const userId = (root as HTMLElement).dataset.userId ?? 'anonymous';
				return `craps-session:${userId}`;
			});

			await expect
				.poll(
					async () =>
						page.evaluate(
							(sessionKey) => window.localStorage.getItem(sessionKey),
							persistedSessionKey,
						),
					{ timeout: 15000 },
				)
				.toBeNull();
			await page.evaluate(
				(sessionKey) => window.localStorage.removeItem(sessionKey),
				persistedSessionKey,
			);

			// Reload to verify the refunded balance persisted on the server.
			await page.reload({ waitUntil: 'networkidle' });
			const balanceAfterReload = parseBalance(await page.locator('#chip-balance').innerText());
			expect(balanceAfterReload).toBe(balanceAfterClear);
		} finally {
			await context.close();
		}
	});
});
