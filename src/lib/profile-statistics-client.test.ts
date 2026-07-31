import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { GAME_TYPES } from './game-stats/constants';
import type { PlayerStatisticsDashboard } from './game-stats/player-statistics-types';
import { initPlayerStatisticsClient } from './profile-statistics-client';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalConsoleError = console.error;
const happyWindow = new Window();

beforeAll(() => {
	Object.defineProperty(globalThis, 'window', {
		configurable: true,
		writable: true,
		value: happyWindow,
	});
	Object.defineProperty(globalThis, 'document', {
		configurable: true,
		writable: true,
		value: happyWindow.document,
	});
});

afterAll(() => {
	happyWindow.close();
	console.error = originalConsoleError;
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

function createDashboard(): PlayerStatisticsDashboard {
	return {
		summary: {
			totalHands: 1,
			totalWins: 1,
			totalLosses: 0,
			overallWinRate: 100,
			totalNetProfit: 50,
			mostPlayedGame: 'blackjack',
		},
		games: GAME_TYPES.map((gameType, index) => ({
			gameType,
			totalWins: index === 0 ? 1 : 0,
			totalLosses: 0,
			handsPlayed: index === 0 ? 1 : 0,
			winRate: index === 0 ? 100 : 0,
			netProfit: index === 0 ? 50 : 0,
			biggestWin: index === 0 ? 50 : 0,
			winsRank: index === 0 ? 1 : null,
		})),
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	});
}

function makeRoot(): HTMLElement {
	const root = document.createElement('main');
	root.innerHTML = `
		<h1 data-statistics-heading tabindex="-1">Player Statistics</h1>
		<section data-statistics-loading>Loading</section>
		<section data-statistics-error role="alert" tabindex="-1" hidden>
			Could not load
			<button data-statistics-retry>Try again</button>
		</section>
		<section data-statistics-content hidden>
			<div data-statistics-summary></div>
			<div data-statistics-empty hidden>Start playing</div>
			<div data-statistics-games></div>
		</section>
	`;
	document.body.appendChild(root);
	return root;
}

async function settleAsyncWork(): Promise<void> {
	for (let index = 0; index < 8; index += 1) {
		await Promise.resolve();
	}
}

describe('player statistics client', () => {
	let root: HTMLElement;

	beforeEach(() => {
		console.error = () => undefined;
		root = makeRoot();
	});

	afterEach(() => {
		root.remove();
		console.error = originalConsoleError;
	});

	test('fetches private statistics and reveals rendered content on success', async () => {
		const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
		const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ input, init });
			return jsonResponse(createDashboard());
		}) as typeof fetch;

		await initPlayerStatisticsClient(root, { fetchImpl });

		expect(calls).toEqual([
			{
				input: '/api/profile/statistics',
				init: { credentials: 'same-origin', cache: 'no-store' },
			},
		]);
		expect(root.getAttribute('aria-busy')).toBe('false');
		expect(root.querySelector<HTMLElement>('[data-statistics-loading]')?.hidden).toBe(true);
		expect(root.querySelector<HTMLElement>('[data-statistics-error]')?.hidden).toBe(true);
		expect(root.querySelector<HTMLElement>('[data-statistics-content]')?.hidden).toBe(false);
		expect(root.querySelector('[data-testid="statistics-card-blackjack"]')).not.toBeNull();
	});

	test('redirects to sign-in when the authenticated API returns 401', async () => {
		const redirects: string[] = [];

		await initPlayerStatisticsClient(root, {
			fetchImpl: (async () => jsonResponse({ error: 'Unauthorized' }, 401)) as typeof fetch,
			redirect: (href) => redirects.push(href),
		});

		expect(redirects).toEqual(['/signin']);
		expect(root.querySelector<HTMLElement>('[data-statistics-content]')?.hidden).toBe(true);
	});

	test.each([
		['network failure', async () => Promise.reject(new Error('offline'))],
		['server failure', async () => jsonResponse({ error: 'failed' }, 500)],
		['malformed payload', async () => jsonResponse({ summary: {}, games: [] })],
	])('shows one retryable error state for %s', async (_label, responseFactory) => {
		await initPlayerStatisticsClient(root, {
			fetchImpl: (async () => responseFactory()) as typeof fetch,
		});

		expect(root.getAttribute('aria-busy')).toBe('false');
		expect(root.querySelector<HTMLElement>('[data-statistics-loading]')?.hidden).toBe(true);
		expect(root.querySelector<HTMLElement>('[data-statistics-error]')?.hidden).toBe(false);
		expect(root.querySelector<HTMLElement>('[data-statistics-content]')?.hidden).toBe(true);
	});

	test('retries after failure and focuses the dashboard heading after success', async () => {
		let attempt = 0;
		await initPlayerStatisticsClient(root, {
			fetchImpl: (async () => {
				attempt += 1;
				if (attempt === 1) throw new Error('offline');
				return jsonResponse(createDashboard());
			}) as typeof fetch,
		});

		root.querySelector<HTMLButtonElement>('[data-statistics-retry]')!.click();
		await settleAsyncWork();

		expect(attempt).toBe(2);
		expect(root.querySelector<HTMLElement>('[data-statistics-content]')?.hidden).toBe(false);
		expect(document.activeElement).toBe(
			root.querySelector<HTMLElement>('[data-statistics-heading]'),
		);
	});

	test('focuses the error message when retry also fails', async () => {
		await initPlayerStatisticsClient(root, {
			fetchImpl: (async () => {
				throw new Error('offline');
			}) as typeof fetch,
		});

		root.querySelector<HTMLButtonElement>('[data-statistics-retry]')!.click();
		await settleAsyncWork();

		expect(root.querySelector<HTMLElement>('[data-statistics-error]')?.hidden).toBe(false);
		expect(document.activeElement).toBe(root.querySelector<HTMLElement>('[data-statistics-error]'));
	});
});
