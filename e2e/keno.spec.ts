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
		const selected = [1, 2, 3];
		for (let i = 0; i < selected.length; i++) {
			const cell = page.locator(`button.keno-cell[data-number="${selected[i]}"]`);
			await cell.click();
			await expect(cell.locator('.pick-order')).toHaveText(String(i + 1));
		}
		await expect(page.getByTestId('spot-count')).toContainText('3/10');

		const bet = 5;
		await page.locator(`.bet-chip[data-bet="${bet}"]`).click();
		await expect(page.getByTestId('current-bet')).toHaveText(String(bet));
		await page.getByTestId('btn-draw').click();

		await expect(page.getByTestId('game-status')).toContainText('Round complete — win!');
		await expect(page.locator('button.keno-cell.drawn')).toHaveCount(20);
		const drawn = await drawnNumbers(page);
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
		await expect(page.getByTestId('last-result')).toContainText(/\d+ of 8 (won|lost|— pushed)/);
	});

	test('Repeat Ticket re-applies the prior ticket after a draw', async ({ page }) => {
		for (let n = 1; n <= 4; n++) await page.locator(`button.keno-cell[data-number="${n}"]`).click();
		await page.getByTestId('btn-draw').click();
		await expect(page.getByTestId('last-result')).toContainText(/\d+ of 4 (won|lost|— pushed)/);
		await page.getByTestId('btn-clear').click();
		await expect(page.getByTestId('spot-count')).toContainText('0/10');
		await page.getByTestId('btn-repeat').click();
		await expect(page.getByTestId('spot-count')).toContainText('4/10');
	});

	test('paytable renders the table for the selected spot count', async ({ page }) => {
		for (let n = 1; n <= 7; n++) await page.locator(`button.keno-cell[data-number="${n}"]`).click();
		// 7-spot paytable has tiers catch-3..7
		const body = page.getByTestId('paytable-body');
		await expect(body).toContainText('Catch 7');
		await expect(body).toContainText('×5000');
	});

	test('paytable modal opens and closes with the selected spot count', async ({ page }) => {
		for (let n = 1; n <= 7; n++) await page.locator(`button.keno-cell[data-number="${n}"]`).click();
		const modal = page.getByTestId('paytable-modal');
		await expect(modal).toHaveClass(/hidden/);
		await page.getByTestId('btn-paytable').click();
		await expect(modal).not.toHaveClass(/hidden/);
		const modalBody = page.getByTestId('paytable-modal-body');
		await expect(modalBody).toContainText('Catch 7');
		await expect(modalBody).toContainText('×5000');
		await page.getByTestId('btn-paytable-close').click();
		await expect(modal).toHaveClass(/hidden/);
	});

	test('controlled draw resolves a deterministic non-winning result', async ({ page }) => {
		await useCryptoBytes(
			page,
			Array.from({ length: 20 }, (_, i) => i + 20),
		);
		const selected = [1, 2, 3];
		for (let i = 0; i < selected.length; i++) {
			await page.locator(`button.keno-cell[data-number="${selected[i]}"]`).click();
		}
		const bet = 5;
		await page.locator(`.bet-chip[data-bet="${bet}"]`).click();
		await page.getByTestId('btn-draw').click();

		await expect(page.locator('button.keno-cell.drawn')).toHaveCount(20);
		const drawn = await drawnNumbers(page);
		expect(new Set(drawn).size).toBe(20);
		expect(drawn.every((number) => number >= 1 && number <= 80)).toBe(true);
		const hitCount = drawn.filter((number) => selected.includes(number)).length;
		expect(hitCount).toBe(0);
		await expect(page.getByTestId('last-result')).toHaveText(
			expectedResultText(selected.length, hitCount, bet),
		);
	});
});
