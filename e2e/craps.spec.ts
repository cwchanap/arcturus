import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createIsolatedPage } from './isolated-page';

async function gotoCraps(page: Page) {
	await page.goto('/games/craps', { waitUntil: 'networkidle' });
}

const createIsolatedCrapsPage = (browser: Browser, baseURL?: string) =>
	createIsolatedPage(browser, baseURL, {
		emailPrefix: 'craps-sync',
		namePrefix: 'Craps Sync',
		navigate: gotoCraps,
	});

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
			async ({ delta }) => {
				const response = await fetch('/api/wallet/settle', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({
						settlementId: `e2e-craps-topup-${crypto.randomUUID()}`,
						game: 'craps',
						delta,
						stats: { rounds: 1, wins: 1, losses: 0, biggestWin: delta },
					}),
				});

				return {
					ok: response.ok,
					status: response.status,
				};
			},
			{ delta },
		);

		if (result.ok || result.status === 409) continue;

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

	test('blocks the next authenticated roll until the exact settlement is retried', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedCrapsPage(browser, baseURL);
		try {
			await ensureMinimumBalance(page, 100);
			const walletBalance = parseBalance(await page.locator('#chip-balance').innerText());
			const persistedSessionKey = await page.locator('#craps-root').evaluate((root) => {
				const userId = (root as HTMLElement).dataset.userId ?? 'anonymous';
				return `craps-session:${userId}`;
			});
			const settlementCommands: Array<Record<string, unknown>> = [];
			let snapshotBeforeFailedRoll: string | null = null;
			await page.route('**/api/wallet/settle', async (route) => {
				const command = route.request().postDataJSON() as Record<string, unknown>;
				settlementCommands.push(command);
				if (settlementCommands.length === 1) {
					await route.fulfill({
						status: 503,
						contentType: 'application/json',
						body: JSON.stringify({ error: 'offline' }),
					});
					return;
				}
				const delta = typeof command.delta === 'number' ? command.delta : 0;
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						balance: walletBalance + delta,
						duplicate: false,
					}),
				});
			});

			await page.getByTestId('chip-5').click();
			await page.click('[data-bet-type="passLine"]');
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (await page.getByTestId('settlement-recovery').isVisible()) break;
				const rollButton = page.getByTestId('roll-button');
				if (await rollButton.isDisabled()) {
					await page.click('[data-bet-type="passLine"]');
				}
				snapshotBeforeFailedRoll = await page.evaluate(
					(sessionKey) => window.localStorage.getItem(sessionKey),
					persistedSessionKey,
				);
				await rollButton.click();
				await page.waitForTimeout(700);
			}

			await expect(page.getByTestId('settlement-recovery')).toBeVisible();
			await expect(page.getByTestId('roll-button')).toBeDisabled();
			expect(settlementCommands).toHaveLength(1);
			// A failed settlement keeps the exact command only in the in-memory gate;
			// the resolved roll must not overwrite the last durable game snapshot.
			expect(
				await page.evaluate(
					(sessionKey) => window.localStorage.getItem(sessionKey),
					persistedSessionKey,
				),
			).toBe(snapshotBeforeFailedRoll);

			await page.getByTestId('retry-settlement').click();
			await expect(page.getByTestId('settlement-recovery')).toBeHidden();
			expect(settlementCommands).toHaveLength(2);
			expect(settlementCommands[1]).toEqual(settlementCommands[0]);
			// Retry success adopts the authoritative wallet result before clearing the
			// resolved, now-empty session snapshot.
			await expect
				.poll(
					async () =>
						page.evaluate(
							(sessionKey) => window.localStorage.getItem(sessionKey),
							persistedSessionKey,
						),
					{ timeout: 5000 },
				)
				.toBeNull();
		} finally {
			await context.close();
		}
	});

	test('persists the settled session after an initial wallet success', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedCrapsPage(browser, baseURL);
		try {
			await ensureMinimumBalance(page, 100);
			const walletBalance = parseBalance(await page.locator('#chip-balance').innerText());
			const persistedSessionKey = await page.locator('#craps-root').evaluate((root) => {
				const userId = (root as HTMLElement).dataset.userId ?? 'anonymous';
				return `craps-session:${userId}`;
			});
			const settlementCommands: Array<Record<string, unknown>> = [];
			await page.route('**/api/wallet/settle', async (route) => {
				const command = route.request().postDataJSON() as Record<string, unknown>;
				settlementCommands.push(command);
				const delta = typeof command.delta === 'number' ? command.delta : 0;
				await route.fulfill({
					status: 200,
					contentType: 'application/json',
					body: JSON.stringify({
						balance: walletBalance + delta,
						duplicate: false,
					}),
				});
			});

			await page.getByTestId('chip-5').click();
			await page.click('[data-bet-type="passLine"]');
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (settlementCommands.length > 0) break;
				const rollButton = page.getByTestId('roll-button');
				if (await rollButton.isDisabled()) {
					await page.click('[data-bet-type="passLine"]');
				}
				await rollButton.click();
				await page.waitForTimeout(700);
			}

			expect(settlementCommands).toHaveLength(1);
			await expect(page.getByTestId('settlement-recovery')).toBeHidden();
			await expect
				.poll(
					async () =>
						page.evaluate(
							(sessionKey) => window.localStorage.getItem(sessionKey),
							persistedSessionKey,
						),
					{ timeout: 5000 },
				)
				.toBeNull();
		} finally {
			await context.close();
		}
	});

	test('does not resurrect a settled wager after a failed settlement and page reload', async ({
		browser,
		baseURL,
	}) => {
		const { context, page } = await createIsolatedCrapsPage(browser, baseURL);
		try {
			await ensureMinimumBalance(page, 100);
			const walletBalance = parseBalance(await page.locator('#chip-balance').innerText());
			const persistedSessionKey = await page.locator('#craps-root').evaluate((root) => {
				const userId = (root as HTMLElement).dataset.userId ?? 'anonymous';
				return `craps-session:${userId}`;
			});
			const settlementCommands: Array<Record<string, unknown>> = [];
			await page.route('**/api/wallet/settle', async (route) => {
				const command = route.request().postDataJSON() as Record<string, unknown>;
				settlementCommands.push(command);
				// Simulate a committed-but-response-lost settlement: the server
				// processes the request but the client never receives the result.
				await route.fulfill({
					status: 503,
					contentType: 'application/json',
					body: JSON.stringify({ error: 'offline' }),
				});
			});

			await page.getByTestId('chip-5').click();
			await page.click('[data-bet-type="passLine"]');
			for (let attempt = 0; attempt < 20; attempt += 1) {
				if (await page.getByTestId('settlement-recovery').isVisible()) break;
				const rollButton = page.getByTestId('roll-button');
				if (await rollButton.isDisabled()) {
					await page.click('[data-bet-type="passLine"]');
				}
				await rollButton.click();
				await page.waitForTimeout(700);
			}

			// A settlement must have been attempted and failed.
			expect(settlementCommands.length).toBeGreaterThanOrEqual(1);
			await expect(page.getByTestId('settlement-recovery')).toBeVisible();

			// The authenticated session must not persist table state to localStorage.
			// If it did, a reload would restore the pre-roll wager and allow it to be
			// settled a second time under a new settlement id.
			expect(
				await page.evaluate(
					(sessionKey) => window.localStorage.getItem(sessionKey),
					persistedSessionKey,
				),
			).toBeNull();

			// Reload: the page re-renders the authoritative server balance and must
			// start with a clean come-out table — no resurrected wagers.
			await page.reload({ waitUntil: 'networkidle' });

			await expect(page.getByTestId('settlement-recovery')).toBeHidden();
			await expect(page.getByTestId('roll-button')).toBeDisabled();
			await expect(page.getByTestId('total-bet')).toContainText('$0');
			await expect(page.getByTestId('active-bets')).toContainText('No bets placed');
			expect(
				await page.evaluate(
					(sessionKey) => window.localStorage.getItem(sessionKey),
					persistedSessionKey,
				),
			).toBeNull();

			// The server balance is unchanged because the mocked settlement returned
			// 503 (no server-side commit in the test harness). The reloaded balance
			// must equal the original wallet balance — no wager is deducted.
			const balanceAfterReload = parseBalance(await page.locator('#chip-balance').innerText());
			expect(balanceAfterReload).toBe(walletBalance);
		} finally {
			await context.close();
		}
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

test.describe('Craps — Local Bet Clearing', () => {
	test('clearing bets refunds locally without wallet settlement', async ({ browser, baseURL }) => {
		const { context, page } = await createIsolatedCrapsPage(browser, baseURL);
		try {
			await ensureMinimumBalance(page, 200);
			let walletSettlementRequests = 0;
			page.on('request', (request) => {
				if (
					request.method() === 'POST' &&
					new URL(request.url()).pathname === '/api/wallet/settle'
				) {
					walletSettlementRequests += 1;
				}
			});

			// Place some removable bets
			await page.getByTestId('chip-25').click();
			await page.click('[data-bet-type="passLine"]');
			await page.click('[data-bet-type="field"]');
			await page.click('[data-bet-type="field"]');

			const balanceBeforeClear = parseBalance(await page.locator('#chip-balance').innerText());

			// Clear bets — the refund is a local mutation and must not settle a round.
			await page.getByTestId('clear-bets-button').click();

			// Balance should be refunded locally
			const balanceAfterClear = parseBalance(await page.locator('#chip-balance').innerText());
			expect(balanceAfterClear).toBe(balanceBeforeClear + 75); // passLine $25 + field $50
			await page.waitForTimeout(250);
			expect(walletSettlementRequests).toBe(0);

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

			// Reload to verify the local session was cleared and the wallet remains unchanged.
			await page.reload({ waitUntil: 'networkidle' });
			const balanceAfterReload = parseBalance(await page.locator('#chip-balance').innerText());
			expect(balanceAfterReload).toBe(balanceAfterClear);
		} finally {
			await context.close();
		}
	});
});
