import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

async function gotoRoulette(page: Page) {
	await page.goto('/games/roulette', { waitUntil: 'networkidle' });
}

async function gotoRouletteFresh(page: Page) {
	await page.goto('/games/roulette', { waitUntil: 'domcontentloaded' });
	await page.evaluate(() => {
		for (const key of Object.keys(localStorage)) {
			if (key.startsWith('roulette-session:')) {
				localStorage.removeItem(key);
			}
		}
	});
	await page.reload({ waitUntil: 'networkidle' });
}

const createIsolatedRoulettePage = (browser: Browser, baseURL?: string) =>
	createIsolatedPage(browser, baseURL, {
		emailPrefix: 'roulette-sync',
		namePrefix: 'Roulette Sync',
		navigate: gotoRoulette,
	});

function parseBalance(text: string): number {
	const normalized = text.replace(/,/g, '');
	const match = normalized.match(/-?\d+(?:\.\d+)?/);
	return Number(match?.[0] ?? '0');
}

async function ensureMinimumBalance(page: Page, minimumBalance: number): Promise<void> {
	const maxAttempts = 5;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		await gotoRoulette(page);
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
						gameType: 'roulette',
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

		throw new Error(`Failed to top up roulette balance for test (status ${result.status})`);
	}

	throw new Error(`Failed to reach minimum roulette balance ${minimumBalance} after retries`);
}

test.describe('Roulette — Initial State', () => {
	test.beforeEach(async ({ page }) => {
		await gotoRouletteFresh(page);
	});

	test('loads page with complete roulette UI', async ({ page }) => {
		await expect(page.getByRole('heading', { name: 'Roulette', exact: true })).toBeVisible();
		await expect(page.locator('#roulette-root')).toBeVisible();
		await expect(page.locator('#roulette-wheel')).toBeVisible();
		await expect(page.locator('#chip-balance')).toBeVisible();
		await expect(page.getByTestId('spin-button')).toBeVisible();
		await expect(page.getByTestId('spin-button')).toBeDisabled();
		await expect(page.getByTestId('total-bet')).toContainText('$0');
		await expect(page.locator('#game-phase')).toContainText('Place Your Bets');
		await expect(page.locator('#wheel-result')).toContainText('—');
	});

	test('displays betting table with all bet types', async ({ page }) => {
		await expect(page.locator('[data-bet-type="straight"][data-bet-target="0"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="straight"][data-bet-target="17"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="red"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="black"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="odd"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="even"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="low"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="high"]')).toBeVisible();
		await expect(page.locator('[data-bet-type="dozen"]')).toHaveCount(3);
		await expect(page.locator('[data-bet-type="column"]')).toHaveCount(3);
	});

	test('chip selector shows all denominations', async ({ page }) => {
		for (const amount of [1, 5, 10, 25, 50, 100]) {
			await expect(page.getByTestId(`chip-${amount}`)).toBeVisible();
		}
	});

	test('rules panel shows payout table', async ({ page }) => {
		await expect(page.locator('#rules-panel')).toBeVisible();
		await expect(page.locator('#rules-panel')).toContainText('35:1');
		await expect(page.locator('#rules-panel')).toContainText('2:1');
	});

	test('spin button disabled with no bets', async ({ page }) => {
		await expect(page.getByTestId('spin-button')).toBeDisabled();
	});
});

test.describe('Roulette — Bet Placement', () => {
	test.beforeEach(async ({ page }) => {
		await gotoRouletteFresh(page);
		await ensureMinimumBalance(page, 25);
	});

	test('places an outside red bet and updates total', async ({ page }) => {
		await page.getByTestId('chip-25').click();
		await page.locator('[data-bet-type="red"]').click();

		await expect(page.getByTestId('total-bet')).toContainText('$25');
		await expect(page.getByTestId('spin-button')).toBeEnabled();
		await expect(page.getByTestId('active-bets')).toContainText('Red');
		await expect(page.getByTestId('active-bets')).toContainText('$25');
	});

	test('places a straight-up bet on a number', async ({ page }) => {
		await page.getByTestId('chip-25').click();
		await page.locator('[data-bet-type="straight"][data-bet-target="17"]').click();

		await expect(page.getByTestId('total-bet')).toContainText('$25');
		await expect(page.getByTestId('active-bets')).toContainText('Straight 17');
	});

	test('places multiple bets and accumulates total', async ({ page }) => {
		await page.getByTestId('chip-25').click();
		await page.locator('[data-bet-type="red"]').click();
		await page.locator('[data-bet-type="black"]').click();

		await expect(page.getByTestId('total-bet')).toContainText('$50');
	});

	test('balance decreases when bet is placed', async ({ page }) => {
		await ensureMinimumBalance(page, 100);
		const balanceBefore = parseBalance(await page.locator('#chip-balance').innerText());

		await page.getByTestId('chip-100').click();
		await page.locator('[data-bet-type="red"]').click();
		await expect(page.getByTestId('total-bet')).toContainText('$100');

		const balanceAfter = parseBalance(await page.locator('#chip-balance').innerText());
		expect(balanceAfter).toBe(balanceBefore - 100);
	});

	test('Clear Bets removes all bets and refunds balance', async ({ page }) => {
		await ensureMinimumBalance(page, 50);
		const balanceBefore = parseBalance(await page.locator('#chip-balance').innerText());

		await page.getByTestId('chip-25').click();
		await page.locator('[data-bet-type="red"]').click();
		await page.locator('[data-bet-type="black"]').click();
		await expect(page.getByTestId('total-bet')).toContainText('$50');

		await page.getByTestId('clear-bets-button').click();

		await expect(page.getByTestId('total-bet')).toContainText('$0');
		await expect(page.getByTestId('spin-button')).toBeDisabled();

		const balanceAfterClear = parseBalance(await page.locator('#chip-balance').innerText());
		expect(balanceAfterClear).toBe(balanceBefore);
	});
});

test.describe.configure({ mode: 'serial' });

test.describe('Roulette — Game Flow', () => {
	test.beforeEach(async ({ page }) => {
		await gotoRouletteFresh(page);
		await ensureMinimumBalance(page, 25);
	});

	test('spin resolves with winning number and new round button', async ({ page }) => {
		await page.getByTestId('chip-25').click();
		await page.locator('[data-bet-type="red"]').click();
		await page.getByTestId('spin-button').click();

		await expect(page.getByTestId('new-round-button')).toBeVisible({ timeout: 15000 });
		await expect(page.locator('#wheel-result')).not.toContainText('—');
		await expect(page.locator('#game-phase')).toContainText('Round Complete');
	});

	test('new round resets to betting phase', async ({ page }) => {
		await page.getByTestId('chip-25').click();
		await page.locator('[data-bet-type="red"]').click();
		await page.getByTestId('spin-button').click();

		await expect(page.getByTestId('new-round-button')).toBeVisible({ timeout: 15000 });
		await page.getByTestId('new-round-button').click();

		await expect(page.locator('#game-phase')).toContainText('Place Your Bets');
		await expect(page.getByTestId('total-bet')).toContainText('$0');
		await expect(page.getByTestId('spin-button')).toBeDisabled();
		await expect(page.getByTestId('new-round-button')).toBeHidden();
	});

	test('bet results are shown after spin', async ({ page }) => {
		await page.getByTestId('chip-25').click();
		await page.locator('[data-bet-type="red"]').click();
		await page.getByTestId('spin-button').click();

		await expect(page.getByTestId('bet-results')).not.toBeEmpty({ timeout: 15000 });
	});
});

test.describe('Roulette — Clear Bets Sync', () => {
	test('clearing bets restores balance and persists after reload', async ({ browser, baseURL }) => {
		const { context, page } = await createIsolatedRoulettePage(browser, baseURL);
		try {
			await ensureMinimumBalance(page, 200);

			const balanceBefore = parseBalance(await page.locator('#chip-balance').innerText());

			await page.getByTestId('chip-25').click();
			await page.locator('[data-bet-type="red"]').click();
			await page.locator('[data-bet-type="black"]').click();
			await expect(page.getByTestId('total-bet')).toContainText('$50');

			await page.getByTestId('clear-bets-button').click();

			const balanceAfterClear = parseBalance(await page.locator('#chip-balance').innerText());
			expect(balanceAfterClear).toBe(balanceBefore);

			await page.reload({ waitUntil: 'networkidle' });
			const balanceAfterReload = parseBalance(await page.locator('#chip-balance').innerText());
			expect(balanceAfterReload).toBe(balanceAfterClear);
		} finally {
			await context.close();
		}
	});
});
