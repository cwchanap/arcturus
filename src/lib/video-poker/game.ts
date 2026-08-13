import { validateBet } from '../bet-validation';
import { createShuffledDeck } from './cards';
import { evaluateHand } from './evaluator';
import { calculatePayout, MAX_WAGER, MIN_WAGER } from './paytable';
import type { Card, VideoPokerRoundResult, VideoPokerState } from './types';

function normalizeBalance(balance: number): number {
	if (!Number.isFinite(balance) || balance < 0) {
		throw new RangeError('Balance must be a non-negative finite number');
	}
	return Math.trunc(balance);
}

export class VideoPokerGame {
	private readonly random: () => number;
	private deck: Card[] = [];
	private state: VideoPokerState;

	constructor(initialBalance: number, random: () => number = Math.random) {
		this.random = random;
		this.state = {
			phase: 'ready',
			balance: normalizeBalance(initialBalance),
			wager: MIN_WAGER,
			hand: [],
			heldIndexes: [],
			result: null,
		};
	}

	getState(): Readonly<VideoPokerState> {
		return {
			...this.state,
			hand: this.state.hand.map((card) => ({ ...card })),
			heldIndexes: [...this.state.heldIndexes],
			result: this.state.result
				? {
						...this.state.result,
						evaluation: { ...this.state.result.evaluation },
						finalHand: this.state.result.finalHand.map((card) => ({ ...card })),
					}
				: null,
		};
	}

	getWagerError(wager: number): string | null {
		if (!Number.isInteger(wager)) return 'Wager must be a whole number of chips';
		const rangeError = validateBet(wager, MIN_WAGER, MAX_WAGER);
		if (rangeError) return rangeError;
		if (wager > this.state.balance) return 'Wager exceeds available balance';
		return null;
	}

	setWager(wager: number): void {
		if (this.state.phase !== 'ready') throw new Error('Wager can only change before dealing');
		const error = this.getWagerError(wager);
		if (error) throw new Error(error); // invariant fallback; client checks the value first
		this.state.wager = wager;
	}

	deal(): void {
		if (this.state.phase !== 'ready') throw new Error('Finish the current hand first');
		const error = this.getWagerError(this.state.wager);
		if (error) throw new Error(error); // invariant fallback; Deal is disabled for this state

		this.deck = createShuffledDeck(this.random);
		this.state = {
			...this.state,
			phase: 'holding',
			balance: this.state.balance - this.state.wager,
			hand: this.deck.splice(0, 5),
			heldIndexes: [],
			result: null,
		};
	}

	toggleHold(index: number): void {
		if (this.state.phase !== 'holding') throw new Error('Cards can only be held before drawing');
		if (!Number.isInteger(index) || index < 0 || index >= 5) {
			throw new RangeError('Card index must be from 0 through 4');
		}
		const held = new Set(this.state.heldIndexes);
		if (held.has(index)) held.delete(index);
		else held.add(index);
		this.state.heldIndexes = [...held].sort((a, b) => a - b);
	}

	draw(): VideoPokerRoundResult {
		if (this.state.phase !== 'holding') throw new Error('Draw is only allowed once per hand');
		const held = new Set(this.state.heldIndexes);
		const finalHand = this.state.hand.map((card, index) => {
			if (held.has(index)) return card;
			const replacement = this.deck.shift();
			if (!replacement) throw new Error('Deck is empty');
			return replacement;
		});
		const evaluation = evaluateHand(finalHand);
		const payout = calculatePayout(evaluation.category, this.state.wager);
		const result: VideoPokerRoundResult = {
			evaluation,
			wager: this.state.wager,
			payout,
			netDelta: payout - this.state.wager,
			finalHand: [...finalHand],
		};
		this.state = {
			...this.state,
			phase: 'complete',
			balance: this.state.balance + payout,
			hand: [...finalHand],
			result,
		};
		// Return a deep clone so callers cannot mutate internal state through the
		// same aliasing path that getState() already guards against.
		return {
			...result,
			evaluation: { ...result.evaluation },
			finalHand: result.finalHand.map((card) => ({ ...card })),
		};
	}

	resetRound(): void {
		if (this.state.phase !== 'complete') throw new Error('Only a completed hand can be reset');
		this.deck = [];
		this.state = {
			...this.state,
			phase: 'ready',
			hand: [],
			heldIndexes: [],
			result: null,
		};
	}

	setBalance(balance: number): void {
		this.state.balance = normalizeBalance(balance);
	}
}
