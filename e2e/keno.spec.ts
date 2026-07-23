// e2e/keno.spec.ts
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { PAYTABLE } from '../src/lib/keno/constants';

async function useCryptoBytes(page: Page, values: number[]): Promise<void> {
	await page.evaluate((sequence) => {
		let index = 0;
		Object.defineProperty(globalThis.crypto, 'getRandomValues', {
			configurable: true,
			value: (array: Uint8Array) => {
				if (!(array instanceof Uint8Array) || array.length !== 1) {
					throw new Error('Unexpected crypto buffer');
				}
				array[0] = sequence[index++] ?? 0;
				return array;
			},
		});
	}, values);
}

async function drawnNumbers(page: Page): Promise<number[]> {
	return page
		.locator('button.keno-cell.drawn')
		.evaluateAll((cells) =>
			cells.map((cell) => Number((cell as HTMLButtonElement).dataset.number)),
		);
}

function expectedResultText(spots: number, hitCount: number, bet: number): string {
	const multiplier = PAYTABLE[spots]?.[hitCount] ?? 0;
	const payout = multiplier * bet;
	const netDelta = payout - bet;
	const verb = netDelta > 0 ? 'won' : netDelta < 0 ? 'lost' : 'pushed';
	const amount = netDelta > 0 ? netDelta : netDelta < 0 ? bet : 0;
	return `${hitCount} of ${spots} ${verb} ${amount.toLocaleString()}`;
}

test.describe('Keno game', () => {
	test.beforeEach(async ({ page }) => {
		await page.goto('/games/keno');
	});

	test('manual selection + non-default bet resolves a deterministic win', async ({ page }) => {
		await useCryptoBytes(
			page,
			Array.from({ length: 20 }, (_, i) => i),
		);
		const cells = page.locator('button.keno-cell');
		const selected = [1, 2, 3];
		for (let i = 0; i < selected.length; i++) {
			await cells.nth(i).click();
			await expect(cells.nth(i).locator('.pick-order')).toHaveText(String(i + 1));
		}
		await expect(page.getByTestId('spot-count')).toContainText('3/10');

		const bet = 5;
		await page.locator(`.bet-chip[data-bet="${bet}"]`).click();
		await expect(page.getByTestId('current-bet')).toHaveText(String(bet));
		await page.getByTestId('btn-draw').click();

		await expect(page.getByTestId('game-status')).toContainText('Round complete — win!');
		const drawn = await drawnNumbers(page);
		expect(drawn).toHaveLength(20);
		expect(new Set(drawn).size).toBe(20);
		expect(drawn.every((number) => number >= 1 && number <= 80)).toBe(true);
		const hitCount = drawn.filter((number) => selected.includes(number)).length;
		expect(hitCount).toBe(3);
		await expect(page.getByTestId('last-result')).toHaveText(
			expectedResultText(selected.length, hitCount, bet),
		);
	});

	test('Quick Pick produces a valid ticket and draws', async ({ page }) => {
		await page.getByTestId('btn-quickpick').click();
		await expect(page.getByTestId('spot-count')).toContainText('8/10');
		await page.getByTestId('btn-draw').click();
		await expect(page.getByTestId('last-result')).toContainText(/of 8/);
	});

	test('Repeat Ticket re-applies the prior ticket after a draw', async ({ page }) => {
		for (let i = 0; i < 4; i++) await page.locator('button.keno-cell').nth(i).click();
		await page.getByTestId('btn-draw').click();
		await expect(page.getByTestId('last-result')).toContainText(/of 4/);
		await page.getByTestId('btn-clear').click();
		await expect(page.getByTestId('spot-count')).toContainText('0/10');
		await page.getByTestId('btn-repeat').click();
		await expect(page.getByTestId('spot-count')).toContainText('4/10');
	});

	test('paytable renders the table for the selected spot count', async ({ page }) => {
		for (let i = 0; i < 7; i++) await page.locator('button.keno-cell').nth(i).click();
		// 7-spot paytable has tiers catch-3..7
		const body = page.getByTestId('paytable-body');
		await expect(body).toContainText('Catch 7');
		await expect(body).toContainText('×5000');
	});

	test('controlled draw resolves a deterministic non-winning result', async ({ page }) => {
		await useCryptoBytes(
			page,
			Array.from({ length: 20 }, (_, i) => i + 20),
		);
		const selected = [1, 2, 3];
		for (let i = 0; i < selected.length; i++) {
			await page.locator('button.keno-cell').nth(i).click();
		}
		const bet = 5;
		await page.locator(`.bet-chip[data-bet="${bet}"]`).click();
		await page.getByTestId('btn-draw').click();

		const drawn = await drawnNumbers(page);
		expect(drawn).toHaveLength(20);
		expect(new Set(drawn).size).toBe(20);
		expect(drawn.every((number) => number >= 1 && number <= 80)).toBe(true);
		const hitCount = drawn.filter((number) => selected.includes(number)).length;
		expect(hitCount).toBe(0);
		await expect(page.getByTestId('last-result')).toHaveText(
			expectedResultText(selected.length, hitCount, bet),
		);
	});
});
