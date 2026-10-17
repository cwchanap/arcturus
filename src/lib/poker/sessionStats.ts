/**
 * Per-tab poker session tally shown in the table toolbar: hands played, net
 * chips, current win streak, biggest pot won, and best hand shown down.
 * Presentation only; wallet settlement and persistent statistics stay in
 * `src/lib/wallet` and `src/lib/game-stats`.
 */

import { HAND_RANKINGS, type PokerHandNameKey } from './constants';

export interface PokerSessionStats {
	hands: number;
	net: number;
	streak: number;
	biggestPot: number;
	bestHand: PokerHandNameKey | null;
}

export interface PokerHandOutcome {
	/** Human chip change for the hand (negative when chips were lost). */
	delta: number;
	/** Chips the human collected from the pot (0 when they won nothing). */
	potWon: number;
	/** The human's made hand when they reached showdown, else null. */
	handKey: PokerHandNameKey | null;
}

export const SESSION_STATS_KEY = 'poker_session_stats';

export const EMPTY_SESSION_STATS: PokerSessionStats = {
	hands: 0,
	net: 0,
	streak: 0,
	biggestPot: 0,
	bestHand: null,
};

export function recordHand(stats: PokerSessionStats, outcome: PokerHandOutcome): PokerSessionStats {
	const bestHand =
		outcome.handKey &&
		(!stats.bestHand || HAND_RANKINGS[outcome.handKey] > HAND_RANKINGS[stats.bestHand])
			? outcome.handKey
			: stats.bestHand;
	return {
		hands: stats.hands + 1,
		net: stats.net + outcome.delta,
		streak: outcome.delta > 0 ? stats.streak + 1 : 0,
		biggestPot: Math.max(stats.biggestPot, outcome.potWon),
		bestHand,
	};
}

function isHandKey(value: unknown): value is PokerHandNameKey {
	return typeof value === 'string' && value in HAND_RANKINGS;
}

export function loadSessionStats(): PokerSessionStats {
	try {
		const parsed = JSON.parse(sessionStorage.getItem(SESSION_STATS_KEY) ?? 'null');
		if (!parsed || typeof parsed !== 'object') return { ...EMPTY_SESSION_STATS };
		const num = (value: unknown) => (Number.isFinite(value) ? Number(value) : 0);
		return {
			hands: num(parsed.hands),
			net: num(parsed.net),
			streak: num(parsed.streak),
			biggestPot: num(parsed.biggestPot),
			bestHand: isHandKey(parsed.bestHand) ? parsed.bestHand : null,
		};
	} catch {
		return { ...EMPTY_SESSION_STATS };
	}
}

export function saveSessionStats(stats: PokerSessionStats): void {
	try {
		sessionStorage.setItem(SESSION_STATS_KEY, JSON.stringify(stats));
	} catch {
		// Storage can be unavailable (private mode, tests); the tally is a nicety.
	}
}
