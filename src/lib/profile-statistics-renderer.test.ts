import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { GAME_TYPES, GAME_TYPE_LABELS } from './game-stats/constants';
import type { PlayerStatisticsDashboard } from './game-stats/player-statistics-types';
import { renderPlayerStatisticsDashboard } from './profile-statistics-renderer';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
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
	if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
	else Reflect.deleteProperty(globalThis, 'window');
	if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
	else Reflect.deleteProperty(globalThis, 'document');
});

function createDashboard(): PlayerStatisticsDashboard {
	return {
		summary: {
			totalHands: 3,
			totalWins: 0,
			totalLosses: 2,
			overallWinRate: 0,
			totalNetProfit: 1200,
			mostPlayedGame: 'blackjack',
		},
		games: GAME_TYPES.map((gameType, index) => ({
			gameType,
			totalWins: 0,
			totalLosses: index === 0 ? 2 : 0,
			handsPlayed: index === 0 ? 3 : 0,
			winRate: 0,
			netProfit: index === 0 ? -400 : 0,
			biggestWin: 0,
			winsRank: index === 0 ? 4 : null,
		})),
	};
}

function makeRoot(): HTMLElement {
	const root = document.createElement('main');
	const summary = document.createElement('section');
	summary.setAttribute('data-statistics-summary', '');
	const games = document.createElement('section');
	games.setAttribute('data-statistics-games', '');
	const empty = document.createElement('aside');
	empty.setAttribute('data-statistics-empty', '');
	empty.hidden = true;
	root.append(summary, games, empty);
	document.body.appendChild(root);
	return root;
}

describe('player statistics renderer', () => {
	let root: HTMLElement;

	beforeEach(() => {
		root = makeRoot();
	});

	afterEach(() => {
		root.remove();
	});

	test('renders canonical cards with active zero-win rank and zero-activity states', () => {
		renderPlayerStatisticsDashboard(root, createDashboard());

		const cards = Array.from(
			root.querySelectorAll<HTMLElement>('[data-testid^="statistics-card-"]'),
		);
		expect(cards.map((card) => card.dataset.testid)).toEqual(
			GAME_TYPES.map((gameType) => `statistics-card-${gameType}`),
		);
		expect(cards.map((card) => card.querySelector('h2')?.textContent)).toEqual(
			GAME_TYPES.map((gameType) => GAME_TYPE_LABELS[gameType]),
		);

		const blackjack = cards[0]!;
		expect(blackjack.querySelector('[data-statistics-status]')?.textContent).toBe('Played');
		expect(blackjack.querySelector('[data-statistics-wins-rank]')?.textContent).toBe('#4');
		expect(blackjack.textContent).toContain('−400 chips');

		const baccarat = cards[1]!;
		expect(baccarat.querySelector('[data-statistics-status]')?.textContent).toBe('Not played yet');
		expect(baccarat.querySelector('[data-statistics-wins-rank]')?.textContent).toBe('Unranked');
	});

	test('renders approved summary and game metrics with signed profit text', () => {
		renderPlayerStatisticsDashboard(root, createDashboard());

		const summary = root.querySelector('[data-statistics-summary]')!;
		expect(summary.textContent).toContain('Total Hands');
		expect(summary.textContent).toContain('3');
		expect(summary.textContent).toContain('Most Played');
		expect(summary.textContent).toContain('Blackjack');
		expect(summary.textContent).toContain('Overall Win Rate');
		expect(summary.textContent).toContain('0.0%');
		expect(summary.textContent).toContain('Net Profit');
		expect(summary.textContent).toContain('+1,200 chips');

		const blackjack = root.querySelector('[data-testid="statistics-card-blackjack"]')!;
		for (const label of [
			'Hands Played',
			'Win Rate',
			'Net Profit',
			'Wins',
			'Losses',
			'Biggest Win',
			'Wins Rank',
		]) {
			expect(blackjack.textContent).toContain(label);
		}
	});

	test('renders canonical leaderboard and play URLs', () => {
		renderPlayerStatisticsDashboard(root, createDashboard());

		for (const gameType of GAME_TYPES) {
			const card = root.querySelector(`[data-testid="statistics-card-${gameType}"]`)!;
			expect(
				card
					.querySelector<HTMLAnchorElement>('[data-statistics-leaderboard]')
					?.getAttribute('href'),
			).toBe(`/games/leaderboard?game=${gameType}&metric=wins`);
			const play = card.querySelector<HTMLAnchorElement>('[data-statistics-play]');
			expect(play?.getAttribute('href')).toBe(`/games/${gameType}`);
			expect(play?.textContent).toBe(`Play ${GAME_TYPE_LABELS[gameType]}`);
		}
	});

	test('renders through the document locale when it is not English', () => {
		document.documentElement.dataset.locale = 'ja';
		try {
			renderPlayerStatisticsDashboard(root, createDashboard());

			const blackjack = root.querySelector('[data-testid="statistics-card-blackjack"]')!;
			expect(blackjack.querySelector('h2')?.textContent).toBe('ブラックジャック');
			expect(blackjack.querySelector('[data-statistics-status]')?.textContent).toBe('プレイ済み');
			expect(blackjack.textContent).toContain('−400 チップ');
			const summary = root.querySelector('[data-statistics-summary]')!;
			expect(summary.textContent).toContain('総ハンド数');
			expect(summary.textContent).toContain('+1,200 チップ');
		} finally {
			delete document.documentElement.dataset.locale;
		}
	});

	test('keeps all cards visible and reveals the invitation when every game is untouched', () => {
		const dashboard = createDashboard();
		dashboard.summary = {
			totalHands: 0,
			totalWins: 0,
			totalLosses: 0,
			overallWinRate: 0,
			totalNetProfit: 0,
			mostPlayedGame: null,
		};
		dashboard.games = dashboard.games.map((game) => ({
			...game,
			totalLosses: 0,
			handsPlayed: 0,
			netProfit: 0,
			winsRank: null,
		}));

		renderPlayerStatisticsDashboard(root, dashboard);

		expect(root.querySelectorAll('[data-testid^="statistics-card-"]')).toHaveLength(
			GAME_TYPES.length,
		);
		expect(root.querySelector<HTMLElement>('[data-statistics-empty]')?.hidden).toBe(false);
	});
});
