import { test, expect, type Page } from '@playwright/test';
import { AUTH_FILE, AUTH_FILE_2 } from './auth.setup';

// These tests require a DO-capable server (wrangler dev, NOT astro dev).
// They are skipped unless the MP_E2E env var is set.
const describe_ = process.env.MP_E2E ? test.describe : test.describe.skip;

function seat(page: Page, seatIndex: number) {
	return page.locator(`[data-testid="seat-${seatIndex}"]`);
}

async function readStack(page: Page, seatIndex: number): Promise<number | null> {
	const raw = await seat(page, seatIndex).getAttribute('data-chips');
	return raw === null ? null : Number(raw);
}

describe_('Multiplayer Poker', () => {
	test('two authenticated players can play a local-stack heads-up hand', async ({ browser }) => {
		const ctxA = await browser.newContext({ storageState: AUTH_FILE });
		const ctxB = await browser.newContext({ storageState: AUTH_FILE_2 });
		try {
			const pageA = await ctxA.newPage();
			const pageB = await ctxB.newPage();

			await pageA.goto('/games/poker-mp');
			await pageA.locator('select[name="maxSeats"]').selectOption('2');
			await pageA.locator('[data-testid="create-room"]').click();
			await pageA.waitForURL(/\/games\/poker-mp\/MP-/);
			const code = new URL(pageA.url()).pathname.split('/').pop()!;

			await expect(pageA.locator('[data-testid="connection-status"]')).toHaveText('Connected', {
				timeout: 10_000,
			});
			await pageA.locator('[data-testid="take-seat-0"]').click();
			await expect(seat(pageA, 0)).toContainText('E2E Test User');

			await pageB.goto(`/games/poker-mp/${code}`);
			await expect(pageB.locator('[data-testid="connection-status"]')).toHaveText('Connected', {
				timeout: 10_000,
			});
			await pageB.locator('[data-testid="take-seat-1"]').click();
			await expect(seat(pageB, 1)).toContainText('E2E Test User 2');

			await expect(seat(pageA, 0)).toContainText('1,000 chips');
			await expect(seat(pageB, 1)).toContainText('1,000 chips');
			await expect(pageA.locator('[data-room-code]')).toHaveAttribute('data-your-seat', '0');
			await expect(pageB.locator('[data-room-code]')).toHaveAttribute('data-your-seat', '1');

			const beforeA = await readStack(pageA, 0);
			const beforeB = await readStack(pageA, 1);
			if (beforeA === null || beforeB === null) throw new Error('Could not read pre-hand stacks');

			await pageA.locator('[data-testid="start-hand"]').click();
			await expect(pageA.locator('[data-room-code]')).toHaveAttribute(
				'data-current-seat',
				/^[01]$/,
				{
					timeout: 5_000,
				},
			);
			const currentSeat = await pageA.locator('[data-room-code]').getAttribute('data-current-seat');
			if (currentSeat !== '0' && currentSeat !== '1')
				throw new Error('No active seat was published');
			await expect(pageB.locator('[data-room-code]')).toHaveAttribute(
				'data-current-seat',
				currentSeat,
			);
			await expect(seat(pageA, Number(currentSeat))).toHaveAttribute('data-active-seat', 'true');
			await expect(seat(pageB, Number(currentSeat))).toHaveAttribute('data-active-seat', 'true');

			await (currentSeat === '0' ? pageA : pageB).locator('[data-action="fold"]').click();

			await expect(pageA.locator('[data-testid="log"]')).toContainText('Hand ended', {
				timeout: 5_000,
			});
			await expect(pageB.locator('[data-testid="log"]')).toContainText('Hand ended', {
				timeout: 5_000,
			});
			await expect(pageA.locator('[data-testid="pot"]')).toHaveText('Pot: 0', { timeout: 5_000 });
			await expect(pageB.locator('[data-testid="pot"]')).toHaveText('Pot: 0', { timeout: 5_000 });

			const loserSeat = Number(currentSeat);
			const winnerSeat = loserSeat === 0 ? 1 : 0;
			const winnerStack = await readStack(pageA, winnerSeat);
			const loserStack = await readStack(pageA, loserSeat);
			if (winnerStack === null || loserStack === null)
				throw new Error('Could not read post-hand stacks');
			expect(winnerStack).toBeGreaterThan(winnerSeat === 0 ? beforeA : beforeB);
			expect(loserStack).toBeLessThan(loserSeat === 0 ? beforeA : beforeB);
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});
});
