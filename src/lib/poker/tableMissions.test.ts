import { afterEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { BoardState, MissionView } from '../missions/types';
import { POKER_HAND_SETTLED_EVENT } from './constants';
import { findNewlyCompleted, initPokerTableMissions, selectPokerMissions } from './tableMissions';

function mission(overrides: Partial<MissionView> & Pick<MissionView, 'missionDefId'>): MissionView {
	return {
		icon: '★',
		period: 'daily',
		progress: 0,
		target: 3,
		completed: false,
		claimed: false,
		claimable: false,
		rewardChips: 500,
		isOverride: false,
		...overrides,
	};
}

function board(daily: MissionView[], weekly: MissionView[] = []): BoardState {
	return {
		streak: {
			current: 0,
			longest: 0,
			claimableToday: false,
			dayOfCycle: 1,
			rewardPreview: 0,
			lastClaimPeriodKey: '',
		},
		daily,
		weekly,
		rerollAvailable: false,
		nextDailyReset: '',
		nextWeeklyReset: '',
		chipBalance: 1000,
	};
}

const wins = (progress: number, extra: Partial<MissionView> = {}) =>
	mission({ missionDefId: 'daily-win-3', icon: '🏆', progress, rewardChips: 750, ...extra });
const tried = (progress: number) =>
	mission({ missionDefId: 'weekly-games-3', icon: '📅', period: 'weekly', progress });

describe('selectPokerMissions', () => {
	test('keeps the missions a poker hand can move, daily first', () => {
		const selected = selectPokerMissions(
			board(
				[
					mission({ missionDefId: 'daily-blackjack-5' }),
					wins(1),
					mission({ missionDefId: 'daily-slots-20' }),
				],
				[tried(2)],
			),
		);
		expect(selected.map((m) => m.missionDefId)).toEqual(['daily-win-3', 'weekly-games-3']);
	});

	test('drops rerolled missions for other games', () => {
		const selected = selectPokerMissions(
			board([
				mission({ missionDefId: 'daily-keno-5', isOverride: true }),
				mission({ missionDefId: 'daily-craps-3' }),
			]),
		);
		expect(selected).toEqual([]);
	});
});

describe('findNewlyCompleted', () => {
	test('reports only missions that crossed into complete', () => {
		const before = [wins(2), { ...tried(3), completed: true }];
		const after = [wins(3, { completed: true, claimable: true }), { ...tried(3), completed: true }];
		expect(findNewlyCompleted(before, after).map((m) => m.missionDefId)).toEqual(['daily-win-3']);
	});

	test('reports nothing on the first load', () => {
		expect(findNewlyCompleted([], [wins(3, { completed: true, claimable: true })])).toEqual([]);
	});
});

describe('initPokerTableMissions', () => {
	const windows: Window[] = [];
	afterEach(() => {
		for (const w of windows.splice(0)) w.close();
	});

	function setup(responses: Record<string, unknown[]>, tableTakesBalance = () => true) {
		const happyWindow = new Window();
		windows.push(happyWindow);
		const document = happyWindow.document as unknown as Document;
		const root = document.createElement('div');
		root.hidden = true;
		root.innerHTML =
			'<div data-mission-tokens></div><span aria-live="polite" data-mission-announcer></span>';
		document.body.appendChild(root);
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetchImpl = (async (url: string, init?: RequestInit) => {
			calls.push({ url, init });
			const queue = responses[url] ?? [];
			const next = queue.length > 1 ? queue.shift() : queue[0];
			// A function entry is a held response the test releases itself.
			const body = typeof next === 'function' ? await next() : next;
			if (body === undefined) return { ok: false, json: async () => ({}) };
			return { ok: true, json: async () => body };
		}) as unknown as typeof fetch;
		const events = new EventTarget();
		const balances: number[] = [];
		const missions = initPokerTableMissions({
			root,
			locale: 'en',
			events,
			fetchImpl,
			onBalance: (balance) => {
				balances.push(balance);
				return tableTakesBalance();
			},
		});
		const tokens = () => [...root.querySelectorAll<HTMLElement>('.poker-mission')];
		return { root, calls, events, balances, missions, tokens };
	}

	const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

	test('shows a ring per poker mission with its progress', async () => {
		const { root, tokens } = setup({ '/api/missions/board': [board([wins(1)], [tried(2)])] });
		await flush();
		expect(root.hidden).toBe(false);
		const [win, games] = tokens();
		expect(win.dataset.state).toBe('progress');
		expect(win.textContent).toBe('🏆1/3');
		expect(win.style.getPropertyValue('--mission-progress')).toBe(String(1 / 3));
		expect(win.getAttribute('aria-label')).toBe('Three Wins: Win 3 rounds in any game. 1 of 3');
		expect(win.getAttribute('aria-disabled')).toBe('true');
		expect(games.dataset.missionId).toBe('weekly-games-3');
	});

	test('stays hidden when the board cannot load', async () => {
		const { root, tokens } = setup({});
		await flush();
		expect(root.hidden).toBe(true);
		expect(tokens()).toEqual([]);
	});

	test('a settled hand refreshes the rings and pops a completed mission', async () => {
		const { root, calls, events, tokens } = setup({
			'/api/missions/board': [
				board([wins(2)]),
				board([wins(3, { completed: true, claimable: true })]),
			],
		});
		await flush();
		events.dispatchEvent(new Event(POKER_HAND_SETTLED_EVENT));
		await flush();
		expect(calls.filter((c) => c.url === '/api/missions/board')).toHaveLength(2);
		const [win] = tokens();
		expect(win.dataset.state).toBe('ready');
		expect(win.dataset.pop).toBe('true');
		expect(win.textContent).toBe('🏆+750');
		expect(win.hasAttribute('aria-disabled')).toBe(false);
		expect(root.querySelector('[data-mission-announcer]')?.textContent).toBe(
			'Three Wins complete. Claim 750 chips',
		);
	});

	test('skips the refresh once every mission is complete', async () => {
		const { calls, events } = setup({
			'/api/missions/board': [board([wins(3, { completed: true, claimed: true })])],
		});
		await flush();
		events.dispatchEvent(new Event(POKER_HAND_SETTLED_EVENT));
		await flush();
		expect(calls.filter((c) => c.url === '/api/missions/board')).toHaveLength(1);
	});

	test('refreshes a complete board again once its reset has passed', async () => {
		const completeBoard = {
			...board([wins(3, { completed: true, claimed: true })]),
			nextDailyReset: '2000-01-01T00:00:00.000Z',
			nextWeeklyReset: '2000-01-03T00:00:00.000Z',
		};
		const { calls, events, tokens } = setup({
			'/api/missions/board': [completeBoard, board([wins(1)])],
		});
		await flush();
		events.dispatchEvent(new Event(POKER_HAND_SETTLED_EVENT));
		await flush();
		expect(calls.filter((c) => c.url === '/api/missions/board')).toHaveLength(2);
		expect(tokens()[0].textContent).toBe('🏆1/3');
	});

	test('a board read that lands after a claim does not undo the claim', async () => {
		let releaseBoard: (value: BoardState) => void = () => {};
		// The weekly ring is still open, so a settled hand reads the board.
		const ready = board([wins(3, { completed: true, claimable: true })], [tried(1)]);
		const { calls, tokens, events } = setup({
			'/api/missions/board': [
				ready,
				() => new Promise<BoardState>((resolve) => (releaseBoard = resolve)),
			],
			'/api/missions/claim': [
				{ status: 'completed', missionDefId: 'daily-win-3', rewardChips: 750, chipBalance: 1750 },
			],
		});
		await flush();
		// A hand settles while the ring is still claimable, so a board read
		// starts; the player claims before that read comes back.
		events.dispatchEvent(new Event(POKER_HAND_SETTLED_EVENT));
		tokens()[0].click();
		await flush();
		expect(calls.filter((c) => c.url === '/api/missions/board')).toHaveLength(2);
		expect(tokens()[0].dataset.state).toBe('claimed');
		releaseBoard(ready);
		await flush();
		expect(tokens()[0].dataset.state).toBe('claimed');
	});

	test('clicking a ready ring claims it and passes on the new balance', async () => {
		const { calls, balances, tokens } = setup({
			'/api/missions/board': [board([wins(3, { completed: true, claimable: true })])],
			'/api/missions/claim': [
				{ status: 'completed', missionDefId: 'daily-win-3', rewardChips: 750, chipBalance: 1750 },
			],
		});
		await flush();
		tokens()[0].click();
		await flush();
		const claim = calls.find((c) => c.url === '/api/missions/claim');
		expect(claim?.init?.method).toBe('POST');
		expect(JSON.parse(String(claim?.init?.body))).toEqual({ missionDefId: 'daily-win-3' });
		expect(balances).toEqual([1750]);
		expect(tokens()[0].dataset.state).toBe('claimed');
		expect(tokens()[0].textContent).toBe('🏆✓');
	});

	test('a claim made mid-hand reaches the table once the hand settles', async () => {
		let handRunning = true;
		const claimed = wins(3, { completed: true, claimed: true });
		const { calls, events, balances, tokens } = setup(
			{
				'/api/missions/board': [
					board([wins(3, { completed: true, claimable: true })]),
					{ ...board([claimed]), chipBalance: 1690 },
				],
				'/api/missions/claim': [
					{ status: 'completed', missionDefId: 'daily-win-3', rewardChips: 750, chipBalance: 1750 },
				],
			},
			() => !handRunning,
		);
		await flush();
		tokens()[0].click();
		await flush();
		expect(balances).toEqual([1750]);

		// The hand ends 60 down; every ring is complete, but the claim is owed.
		handRunning = false;
		events.dispatchEvent(new Event(POKER_HAND_SETTLED_EVENT));
		await flush();
		expect(calls.filter((c) => c.url === '/api/missions/board')).toHaveLength(2);
		expect(balances).toEqual([1750, 1690]);

		// Once the table has it, a settled hand stops reading a complete board.
		events.dispatchEvent(new Event(POKER_HAND_SETTLED_EVENT));
		await flush();
		expect(calls.filter((c) => c.url === '/api/missions/board')).toHaveLength(2);
	});

	test('a ring still in progress does not claim', async () => {
		const { calls, tokens } = setup({ '/api/missions/board': [board([wins(1)])] });
		await flush();
		tokens()[0].click();
		await flush();
		expect(calls.some((c) => c.url === '/api/missions/claim')).toBe(false);
	});

	test('a failed claim leaves the ring claimable', async () => {
		const { balances, tokens } = setup({
			'/api/missions/board': [board([wins(3, { completed: true, claimable: true })])],
		});
		await flush();
		tokens()[0].click();
		await flush();
		expect(balances).toEqual([]);
		expect(tokens()[0].dataset.state).toBe('ready');
	});
});
