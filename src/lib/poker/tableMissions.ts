/**
 * Mission progress at the poker table: the missions a finished hand can move,
 * shown as icon tokens beside the player's seat, refreshed after each settled
 * hand, and claimable in place once complete. Signed-in players only; the
 * board and claim calls are the same ones the missions page uses.
 */

import { getMissionDef } from '../missions/registry';
import type { BoardState, MissionView } from '../missions/types';
import type { ClaimResult } from '../missions/claim';
import { formatChips } from '../i18n/messages/common';
import { getMissionDescription, getMissionTitle } from '../i18n/messages/missions';
import { pokerTranslator } from '../i18n/messages/poker';
import type { Locale } from '../i18n/locale';
import { POKER_HAND_SETTLED_EVENT } from './constants';

/** Active missions a single-player poker hand can advance, daily first. */
export function selectPokerMissions(board: Pick<BoardState, 'daily' | 'weekly'>): MissionView[] {
	return [...board.daily, ...board.weekly].filter((mission) => {
		const metric = getMissionDef(mission.missionDefId)?.metric;
		switch (metric?.kind) {
			case 'handsPlayed':
			case 'roundsWon':
				return !metric.gameType || metric.gameType === 'poker';
			case 'gamesTried':
				return true;
			default:
				return false;
		}
	});
}

/** Missions that were incomplete before and are complete now. */
export function findNewlyCompleted(before: MissionView[], after: MissionView[]): MissionView[] {
	const wasComplete = new Map(before.map((m) => [m.missionDefId, m.completed]));
	return after.filter((m) => m.completed && wasComplete.get(m.missionDefId) === false);
}

type TokenState = 'progress' | 'ready' | 'claimed';

function tokenState(mission: MissionView): TokenState {
	if (mission.claimed) return 'claimed';
	return mission.claimable ? 'ready' : 'progress';
}

export interface PokerTableMissionsOptions {
	/** The `#poker-missions` container; stays hidden until a board loads. */
	root: HTMLElement;
	locale: Locale;
	/** Where `POKER_HAND_SETTLED_EVENT` is dispatched (the window). */
	events: EventTarget;
	fetchImpl?: typeof fetch;
	/**
	 * Called with the account balance after a successful claim. Returning
	 * false means the table could not take it yet (a hand was running).
	 */
	onBalance: (balance: number) => boolean;
	/** Sound cue: a mission just became claimable, or a claim paid out. */
	onCue?: (cue: 'ready' | 'claimed') => void;
}

export interface PokerTableMissions {
	refresh(): Promise<void>;
}

export function initPokerTableMissions(options: PokerTableMissionsOptions): PokerTableMissions {
	const { root, locale, events, onBalance, onCue } = options;
	const fetchImpl = options.fetchImpl ?? fetch;
	const t = pokerTranslator(locale);
	const doc = root.ownerDocument;
	const list = root.querySelector<HTMLElement>('[data-mission-tokens]') ?? root;
	const announcer = root.querySelector<HTMLElement>('[data-mission-announcer]');
	let missions: MissionView[] = [];
	// False until a board has loaded, so a failed first read is retried.
	let loaded = false;
	let claiming = false;
	// Bumped by each board request and each claim, so a board read that
	// started earlier cannot overwrite newer state when it lands late.
	let generation = 0;
	// Earliest daily/weekly reset of the last board; fresh missions start then.
	let nextReset = Number.POSITIVE_INFINITY;
	// A claim the table could not take mid-hand; the next board after the hand
	// settles carries the account balance, reward included.
	let balanceOwed = false;

	function title(mission: MissionView): string {
		return getMissionTitle(locale, mission.missionDefId);
	}

	function label(mission: MissionView): string {
		const state = tokenState(mission);
		if (state === 'ready') {
			return t('missionReady', {
				title: title(mission),
				chips: formatChips(mission.rewardChips, locale),
			});
		}
		if (state === 'claimed') return t('missionClaimed', { title: title(mission) });
		return t('missionProgress', {
			title: title(mission),
			description: getMissionDescription(locale, mission.missionDefId, mission.target),
			progress: String(mission.progress),
			target: String(mission.target),
		});
	}

	function renderToken(mission: MissionView, pop: boolean): HTMLButtonElement {
		const state = tokenState(mission);
		const token = doc.createElement('button');
		token.type = 'button';
		token.className = 'poker-mission';
		token.dataset.missionId = mission.missionDefId;
		token.dataset.state = state;
		if (pop) token.dataset.pop = 'true';
		token.style.setProperty('--mission-progress', String(mission.progress / mission.target));
		token.setAttribute('aria-label', label(mission));
		token.title = label(mission);
		if (state !== 'ready') token.setAttribute('aria-disabled', 'true');

		const icon = doc.createElement('span');
		icon.className = 'poker-mission-icon';
		icon.setAttribute('aria-hidden', 'true');
		icon.textContent = mission.icon;
		const count = doc.createElement('span');
		count.className = 'poker-mission-count';
		count.setAttribute('aria-hidden', 'true');
		count.textContent =
			state === 'ready'
				? `+${mission.rewardChips}`
				: state === 'claimed'
					? '✓'
					: `${mission.progress}/${mission.target}`;
		token.appendChild(icon);
		token.appendChild(count);
		return token;
	}

	function render(popIds: Set<string> = new Set()): void {
		const focusedId = (doc.activeElement as HTMLElement | null)?.closest<HTMLElement>(
			'.poker-mission',
		)?.dataset.missionId;
		list.replaceChildren(...missions.map((m) => renderToken(m, popIds.has(m.missionDefId))));
		root.hidden = missions.length === 0;
		if (focusedId) {
			list.querySelector<HTMLElement>(`[data-mission-id="${focusedId}"]`)?.focus();
		}
	}

	function announce(message: string): void {
		if (announcer) announcer.textContent = message;
	}

	async function refresh(): Promise<void> {
		const request = ++generation;
		let board: BoardState;
		try {
			const response = await fetchImpl('/api/missions/board');
			if (!response.ok) return;
			board = (await response.json()) as BoardState;
		} catch {
			return;
		}
		if (request !== generation) return;
		loaded = true;
		nextReset = Math.min(Date.parse(board.nextDailyReset), Date.parse(board.nextWeeklyReset));
		if (Number.isNaN(nextReset)) nextReset = Number.POSITIVE_INFINITY;
		if (balanceOwed && onBalance(board.chipBalance)) balanceOwed = false;
		const next = selectPokerMissions(board);
		const completed = findNewlyCompleted(missions, next);
		missions = next;
		render(new Set(completed.map((m) => m.missionDefId)));
		if (completed.length > 0) {
			announce(completed.map(label).join(' '));
			onCue?.('ready');
		}
	}

	async function claim(missionDefId: string): Promise<void> {
		if (claiming) return;
		claiming = true;
		try {
			const response = await fetchImpl('/api/missions/claim', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ missionDefId }),
			});
			if (!response.ok) return;
			const result = (await response.json()) as ClaimResult;
			if (result.status !== 'completed' && result.status !== 'already-claimed') return;
			generation++;
			missions = missions.map((m) =>
				m.missionDefId === missionDefId ? { ...m, claimed: true, claimable: false } : m,
			);
			render();
			const claimed = missions.find((m) => m.missionDefId === missionDefId);
			if (claimed) announce(label(claimed));
			if (result.status === 'completed') onCue?.('claimed');
			if (result.status === 'completed' && !onBalance(result.chipBalance)) balanceOwed = true;
		} catch {
			// Leave the token claimable; the missions page can still claim it.
		} finally {
			claiming = false;
		}
	}

	list.addEventListener('click', (event) => {
		const token = (event.target as Element | null)?.closest<HTMLElement>('.poker-mission');
		if (token?.dataset.state === 'ready' && token.dataset.missionId) {
			void claim(token.dataset.missionId);
		}
	});

	events.addEventListener(POKER_HAND_SETTLED_EVENT, () => {
		// Read the board until one has loaded, while a hand can still move a
		// ring, once a daily or weekly reset brings fresh missions, or while a
		// claim is owed.
		if (!loaded || balanceOwed || missions.some((m) => !m.completed) || Date.now() >= nextReset) {
			void refresh();
		}
	});

	void refresh();
	return { refresh };
}
