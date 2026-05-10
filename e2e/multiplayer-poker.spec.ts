import { test, expect } from '@playwright/test';

// These tests require a DO-capable server (wrangler dev, NOT astro dev).
// They are skipped unless the MP_E2E env var is set.
// Serial mode prevents ALREADY_IN_ROOM conflicts between tests sharing the same users.
const describe_ = process.env.MP_E2E ? test.describe.serial : test.describe.skip;

/**
 * Wait for the DO to finish settlement after a hand ends.
 * The DO broadcasts hand_ended before runSettlement(), so waiting for
 * 'Hand ended' alone is insufficient — settlement may still be in-flight
 * when the test proceeds to leave_seat. The post-settlement room_state
 * broadcast resets the pot to 0, which confirms settlement completed and
 * membership locks have been released for unseated players.
 */
async function waitForSettlement(page: import('@playwright/test').Page): Promise<void> {
	// Wait for hand_ended broadcast (fires before runSettlement)
	await expect(page.locator(`[data-testid="log"]`)).toContainText('Hand ended', {
		timeout: 5_000,
	});
	// Wait for the pot to clear, which only happens after runSettlement()
	// completes and broadcasts the updated room_state with hand=null.
	await expect(page.locator('[data-testid="pot"]')).toHaveText('Pot: 0', { timeout: 5_000 });
}

/**
 * Send a leave_seat message, wait for the seat to clear, then navigate
 * away from the poker-mp page to close the WebSocket connection.
 *
 * leave_seat only frees the seat — the DO intentionally keeps the
 * mp_membership D1 row until webSocketClose fires (to prevent the same
 * socket from re-seating after a leave). Navigating to a non-WS page
 * triggers the WebSocket close, which allows the DO to call
 * releaseMembership and delete the D1 row before the next serial test
 * reuses the same auth state.
 */
async function leaveSeat(page: import('@playwright/test').Page, seatIndex: number): Promise<void> {
	await page.locator('[data-testid="leave-seat"]').click();
	// Wait for the DO to process leave_seat and broadcast the room state
	// confirming the seat is empty.
	await expect(page.locator(`[data-testid="seat-${seatIndex}"]`)).toContainText(/\(empty\)/, {
		timeout: 5_000,
	});
	// Navigate away to close the WebSocket so the DO's webSocketClose handler
	// runs and releases the D1 membership lock. Without this, the next serial
	// test reuses the same auth state and can hit ALREADY_IN_ROOM because the
	// lock persists until the socket actually closes.
	await page.goto('/games');
	// Give the DO time to process webSocketClose and complete the D1 delete.
	await page.waitForTimeout(1500);
}

describe_('Multiplayer Poker', () => {
	test('two-player heads-up hand: create, join, fold, settle', async ({ browser }) => {
		const ctxA = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
		const ctxB = await browser.newContext({ storageState: 'e2e/.auth/user-2.json' });
		try {
			const pageA = await ctxA.newPage();
			const pageB = await ctxB.newPage();

			await pageA.goto('/games/poker-mp');
			await pageA.locator('select[name="maxSeats"]').selectOption('2');
			await pageA.locator('[data-testid="create-room"]').click();
			await pageA.waitForURL(/\/games\/poker-mp\/MP-/);
			const code = new URL(pageA.url()).pathname.split('/').pop()!;

			await pageA
				.locator('[data-testid="connection-status"]:has-text("Connected")')
				.waitFor({ timeout: 10000 });
			await pageA.locator('[data-testid="take-seat-0"]').click();
			await expect(pageA.locator('[data-testid="seat-0"]')).toContainText(/E2E Test User/);

			await pageB.goto(`/games/poker-mp/${code}`);
			await pageB
				.locator('[data-testid="connection-status"]:has-text("Connected")')
				.waitFor({ timeout: 10000 });
			await pageB.locator('[data-testid="take-seat-1"]').click();
			await expect(pageB.locator('[data-testid="seat-1"]')).toContainText(/E2E Test User 2/);

			await pageA.locator('[data-testid="start-hand"]').click();
			await expect(pageA.locator('[data-testid="hole-cards"] span').first()).toBeVisible({
				timeout: 5000,
			});
			await expect(pageB.locator('[data-testid="hole-cards"] span').first()).toBeVisible({
				timeout: 5000,
			});

			await pageA.locator('[data-action="fold"]').click();

			// Wait for settlement to complete before leaving seats.
			// hand_ended is broadcast before runSettlement(), so waiting only for
			// 'Hand ended' risks processing leave_seat while settlement is still
			// pending (the DO input gate releases during fetch() calls). The pot
			// resetting to 0 confirms runSettlement() finished and membership
			// locks are released for unseated/disconnected players.
			await waitForSettlement(pageA);
			await waitForSettlement(pageB);

			// Hole cards should be cleared after hand ends
			await expect(pageA.locator('[data-testid="hole-cards"] span')).toHaveCount(0);
			await expect(pageB.locator('[data-testid="hole-cards"] span')).toHaveCount(0);

			// Leave seats so the DO releases membership locks before the next test.
			// Without this, the next serial test reuses the same auth states and hits
			// ALREADY_IN_ROOM because the membership rows persist until the DO alarm
			// fires (up to 30s).
			await leaveSeat(pageA, 0);
			await leaveSeat(pageB, 1);
		} finally {
			await ctxA.close();
			await ctxB.close();
		}
	});

	test('disconnect mid-hand triggers 30s auto-fold', async ({ browser }) => {
		test.slow();
		const ctxA = await browser.newContext({ storageState: 'e2e/.auth/user.json' });
		const ctxB = await browser.newContext({ storageState: 'e2e/.auth/user-2.json' });
		try {
			const pageA = await ctxA.newPage();
			const pageB = await ctxB.newPage();

			await pageA.goto('/games/poker-mp');
			await pageA.locator('select[name="maxSeats"]').selectOption('2');
			await pageA.locator('[data-testid="create-room"]').click();
			await pageA.waitForURL(/\/games\/poker-mp\/MP-/);
			const code = new URL(pageA.url()).pathname.split('/').pop()!;

			await pageA
				.locator('[data-testid="connection-status"]:has-text("Connected")')
				.waitFor({ timeout: 10000 });
			await pageA.locator('[data-testid="take-seat-0"]').click();
			await pageB.goto(`/games/poker-mp/${code}`);
			await pageB
				.locator('[data-testid="connection-status"]:has-text("Connected")')
				.waitFor({ timeout: 10000 });
			await pageB.locator('[data-testid="take-seat-1"]').click();
			await pageA.locator('[data-testid="start-hand"]').click();
			await expect(pageB.locator('[data-testid="hole-cards"] span').first()).toBeVisible({
				timeout: 5000,
			});

			// Close B abruptly. A should see seat 1 emptied after the 30s reconnect timeout.
			await ctxB.close();

			await expect(pageA.locator('[data-testid="seat-1"]')).toContainText(/\(empty\)/, {
				timeout: 35_000,
			});

			// Leave A's seat so the DO releases the membership lock.
			await leaveSeat(pageA, 0);
		} finally {
			await ctxA.close();
		}
	});
});
