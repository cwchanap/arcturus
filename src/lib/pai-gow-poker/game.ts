import { validateBetCode } from '../bet-validation';
import { arrangeHouseWay } from './house-way';
import { createShuffledPaiGowDeck } from './cards';
import {
	getArrangement,
	getArrangementError as getPaiGowArrangementError,
	resolvePaiGowRound,
} from './rules';
import type {
	PaiGowArrangement,
	PaiGowArrangementErrorCode,
	PaiGowCard,
	PaiGowHandRanking,
	PaiGowPokerState,
	PaiGowRoundResult,
	PaiGowWagerErrorCode,
} from './types';

export const MIN_WAGER = 5;
export const MAX_WAGER = 100;
export const WAGER_OPTIONS = [5, 10, 20, 50, 100] as const;

function normalizeBalance(balance: number): number {
	if (!Number.isFinite(balance)) return 0;
	return Math.max(0, Math.trunc(balance));
}

function cloneCard(card: PaiGowCard): PaiGowCard {
	return { ...card };
}

function cloneRanking(ranking: PaiGowHandRanking): PaiGowHandRanking {
	return { category: ranking.category, tieBreakers: [...ranking.tieBreakers] };
}

function cloneArrangement(arrangement: PaiGowArrangement): PaiGowArrangement {
	return {
		lowIndexes: [...arrangement.lowIndexes] as [number, number],
		high: arrangement.high.map(cloneCard),
		low: arrangement.low.map(cloneCard),
		highRanking: cloneRanking(arrangement.highRanking),
		lowRanking: cloneRanking(arrangement.lowRanking),
	};
}

function cloneResult(result: PaiGowRoundResult): PaiGowRoundResult {
	return {
		...result,
		player: cloneArrangement(result.player),
		dealer: cloneArrangement(result.dealer),
	};
}

export class PaiGowPokerGame {
	private readonly random: () => number;
	private state: PaiGowPokerState;

	constructor(initialBalance: number, random: () => number = Math.random) {
		this.random = random;
		this.state = {
			phase: 'betting',
			balance: normalizeBalance(initialBalance),
			wager: MIN_WAGER,
			playerCards: [],
			dealerCards: [],
			lowIndexes: [],
			result: null,
		};
	}

	getState(): Readonly<PaiGowPokerState> {
		return {
			...this.state,
			playerCards: this.state.playerCards.map(cloneCard),
			dealerCards: this.state.dealerCards.map(cloneCard),
			lowIndexes: [...this.state.lowIndexes],
			result: this.state.result ? cloneResult(this.state.result) : null,
		};
	}

	/** Language-neutral validation result; the client translates the code. */
	getWagerError(wager: number): PaiGowWagerErrorCode | null {
		if (!Number.isInteger(wager)) return 'whole-number-required';
		const rangeError = validateBetCode(wager, MIN_WAGER, MAX_WAGER);
		if (rangeError) return rangeError;
		if (wager > this.state.balance) return 'insufficient-balance';
		return null;
	}

	setWager(wager: number): void {
		if (this.state.phase !== 'betting') throw new Error('Wager can only change before dealing');
		const error = this.getWagerError(wager);
		if (error) throw new Error(error);
		this.state = { ...this.state, wager };
	}

	deal(): void {
		if (this.state.phase !== 'betting') throw new Error('Deal is only allowed while betting');
		const error = this.getWagerError(this.state.wager);
		if (error) throw new Error(error);
		const deck = createShuffledPaiGowDeck(this.random);
		this.state = {
			...this.state,
			phase: 'arranging',
			balance: this.state.balance - this.state.wager,
			playerCards: deck.slice(0, 7).map(cloneCard),
			dealerCards: deck.slice(7, 14).map(cloneCard),
			lowIndexes: [],
			result: null,
		};
	}

	toggleLowCard(index: number): void {
		if (this.state.phase !== 'arranging') {
			throw new Error('Low cards can only be selected while arranging');
		}
		if (!Number.isInteger(index) || index < 0 || index >= 7) {
			throw new RangeError('Low card index must be an integer from 0 through 6');
		}

		const selected = new Set(this.state.lowIndexes);
		if (selected.has(index)) selected.delete(index);
		else if (selected.size < 2) selected.add(index);
		this.state = {
			...this.state,
			lowIndexes: [...selected].sort((left, right) => left - right),
		};
	}

	autoArrange(): void {
		if (this.state.phase !== 'arranging') {
			throw new Error('Auto arrange is only allowed while arranging');
		}
		const arrangement = arrangeHouseWay(this.state.playerCards);
		this.state = { ...this.state, lowIndexes: [...arrangement.lowIndexes] };
	}

	resetArrangement(): void {
		if (this.state.phase !== 'arranging') {
			throw new Error('Reset arrangement is only allowed while arranging');
		}
		this.state = { ...this.state, lowIndexes: [] };
	}

	/** Language-neutral validation result; the client translates the code. */
	getArrangementError(): PaiGowArrangementErrorCode | null {
		return getPaiGowArrangementError(this.state.playerCards, this.state.lowIndexes);
	}

	confirm(): PaiGowRoundResult {
		if (this.state.phase !== 'arranging') {
			throw new Error('Confirm is only allowed while arranging');
		}

		const error = this.getArrangementError();
		if (error) throw new Error(error);

		const player = getArrangement(this.state.playerCards, this.state.lowIndexes);
		if (!player) throw new Error('Player arrangement must be valid');

		const dealer = arrangeHouseWay(this.state.dealerCards);
		const resolved = resolvePaiGowRound(player, dealer, this.state.wager);
		const stored = cloneResult(resolved);

		this.state = {
			...this.state,
			phase: 'complete',
			balance: this.state.balance + stored.grossPayout,
			result: stored,
		};

		return cloneResult(stored);
	}

	resetRound(): void {
		if (this.state.phase !== 'complete') throw new Error('Only a completed round can be reset');
		this.state = {
			...this.state,
			phase: 'betting',
			playerCards: [],
			dealerCards: [],
			lowIndexes: [],
			result: null,
		};
	}

	/**
	 * Adopt an authoritative balance supplied by the server (after wallet
	 * settlement) or restore a persisted guest bankroll. Only callable during
	 * the `betting` and `complete` phases — the phases where the settlement
	 * controller may adopt a server result or reset a round. The provided value
	 * is treated as authoritative and is NOT re-normalized; the server is the
	 * source of truth for authenticated balances.
	 */
	setBalance(balance: number): void {
		if (this.state.phase !== 'betting' && this.state.phase !== 'complete') {
			throw new Error('setBalance is only allowed during betting or complete phases');
		}
		this.state = { ...this.state, balance };
	}
}
