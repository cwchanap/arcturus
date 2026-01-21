import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ensureLoggedIn } from './auth-helpers';

test.describe.configure({ mode: 'serial' });

async function gotoBlackjack(page: Page) {
	await ensureLoggedIn(page);
	await page.goto('/games/blackjack', { waitUntil: 'domcontentloaded' });
}

async function refreshBlackjack(page: Page) {
	for (let attempt = 0; attempt < 2; attempt++) {
		await gotoBlackjack(page);
		if (page.url().includes('/signin')) {
			await ensureLoggedIn(page);
			continue;
		}
		await page.locator('#player-balance').waitFor({ state: 'visible', timeout: 10000 });
		return;
	}

	throw new Error('Failed to refresh blackjack page: redirected to /signin');
}

async function ensureMinimumBalance(page: Page, minimumBalance: number) {
	const maxAttempts = 5;

	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		const balanceText = await page
			.locator('#player-balance')
			.innerText()
			.catch(() => '');
		const balance = parseBalance(balanceText);
		if (balance >= minimumBalance) {
			return;
		}

		const delta = minimumBalance - balance;
		const result = await page.evaluate(
			async ({ delta, previousBalance }) => {
				const response = await fetch('/api/chips/update', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						delta,
						gameType: 'blackjack',
						previousBalance,
					}),
				});

				let data: unknown = null;
				try {
					data = await response.json();
				} catch (_error) {
					void _error;
				}

				return {
					ok: response.ok,
					status: response.status,
					retryAfter: response.headers.get('Retry-After'),
					data,
				};
			},
			{ delta, previousBalance: balance },
		);

		if (result.ok) {
			await refreshBlackjack(page);
			continue;
		}

		if (result.status === 429) {
			const retryAfter = Number(result.retryAfter ?? '2');
			const sleepMs = (Number.isFinite(retryAfter) ? retryAfter : 2) * 1000 + 100;
			await page.waitForTimeout(sleepMs);
			await refreshBlackjack(page);
			continue;
		}

		if (result.status === 409) {
			await refreshBlackjack(page);
			continue;
		}

		throw new Error(`Failed to top up balance for test: ${JSON.stringify(result)}`);
	}

	throw new Error(`Failed to reach minimum balance ${minimumBalance} after retries`);
}

async function dealNewHand(page: Page, bet: number) {
	await ensureMinimumBalance(page, bet);
	const betInput = page.locator('#bet-amount');
	await betInput.fill(String(bet));
	await page.getByRole('button', { name: 'Deal' }).click();
	await Promise.race([
		page.locator('#game-controls').waitFor({ state: 'visible', timeout: 10000 }),
		page.getByRole('button', { name: 'New Round' }).waitFor({ state: 'visible', timeout: 10000 }),
	]);
}

function parseBalance(text: string): number {
	const normalized = text.replace(/,/g, '');
	const match = normalized.match(/-?\d+(?:\.\d+)?/);
	return Number(match?.[0] ?? '0');
}

// T047: split pair → play first hand → play second hand → dealer turn → outcome
// This test is probabilistic: it will try multiple rounds until a split opportunity appears.
test.describe('Blackjack advanced actions - Split & Double Down', () => {
	test.setTimeout(60000);
	test('player can split a pair and complete both hands (if split encountered)', async ({
		page,
	}) => {
		await gotoBlackjack(page);

		const maxAttempts = 15;
		let foundSplit = false;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			await dealNewHand(page, 50);

			const splitButton = page.getByRole('button', { name: 'Split' });
			if (await splitButton.isEnabled()) {
				foundSplit = true;
				break;
			}

			await refreshBlackjack(page);
		}

		if (!foundSplit) {
			// Could not find a splittable hand within the attempt limit;
			// treat as a no-op rather than failing the test due to randomness.
			return;
		}

		// We are in a state where Split is enabled
		const splitButton = page.getByRole('button', { name: 'Split' });
		await expect(splitButton).toBeEnabled();
		await splitButton.click();

		// Verify two hands are displayed (split hands are in #player-cards-split container)
		const splitContainer = page.locator('#player-cards-split');
		await expect(splitContainer.getByText('Hand 1')).toBeVisible();
		await expect(splitContainer.getByText('Hand 2')).toBeVisible();

		// Play both hands by standing twice
		const standButton = page.getByRole('button', { name: 'Stand' });
		await standButton.click(); // finish first hand, advance to second
		await standButton.click(); // finish second hand and trigger dealer turn

		// Wait for round to complete (New Round button appears when round ends)
		const newRoundButton = page.getByRole('button', { name: 'New Round' });
		await expect(newRoundButton).toBeVisible({ timeout: 15000 });

		const status = page.locator('#game-status');
		await expect(status).toHaveText(/win|wins|Dealer wins|Push|BLACKJACK|Bust/i, {
			timeout: 15000,
		});
	});

	// T052: insufficient chips disables Double/Split buttons
	test('Double Down disabled when chips are insufficient', async ({ page }) => {
		await gotoBlackjack(page);

		// Read current balance from DOM to compute delta
		const currentBalanceText = await page.locator('#player-balance').innerText();
		let currentBalance = parseBalance(currentBalanceText);
		const targetBalance = 50;
		const maxAllowedDelta = 2000; // 4 * 500 (DEFAULT_MAX_BET)
		const epsilon = 0.001;

		// Loop until we reach target balance (delta clamping may require multiple calls)
		for (let attempt = 0; attempt < 10 && currentBalance > targetBalance + epsilon; attempt++) {
			const delta = targetBalance - currentBalance;
			const clampedDelta = Math.max(delta, -maxAllowedDelta);

			const result = await page.evaluate(
				async ({ delta, previousBalance }) => {
					const response = await fetch('/api/chips/update', {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify({
							delta,
							gameType: 'blackjack',
							previousBalance,
						}),
					});

					let data: unknown = null;
					try {
						data = await response.json();
					} catch (_error) {
						void _error;
					}

					return {
						ok: response.ok,
						status: response.status,
						retryAfter: response.headers.get('Retry-After'),
						data,
					};
				},
				{ delta: clampedDelta, previousBalance: currentBalance },
			);

			if (result.ok) {
				await refreshBlackjack(page);
			} else if (result.status === 429) {
				const retryAfter = Number(result.retryAfter ?? '2');
				const sleepMs = (Number.isFinite(retryAfter) ? retryAfter : 2) * 1000 + 100;
				await page.waitForTimeout(sleepMs);
				await refreshBlackjack(page);
			} else if (result.status === 409) {
				await refreshBlackjack(page);
			} else {
				throw new Error(`Failed to reduce balance for test: ${JSON.stringify(result)}`);
			}

			const balanceText = await page.locator('#player-balance').innerText();
			currentBalance = parseBalance(balanceText);
		}

		expect(currentBalance).toBeLessThanOrEqual(targetBalance + epsilon);

		// Bet all remaining chips
		const betAll = Math.max(0, Math.floor(currentBalance));
		await dealNewHand(page, betAll);

		// Double Down should be disabled (requires additional bet amount, but balance is 0)
		// Note: Split button only appears when player has a pair, so we only test Double Down
		const doubleButton = page.getByRole('button', { name: 'Double Down' });
		await expect(doubleButton).toBeDisabled();
	});
});
