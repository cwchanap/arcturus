import { validateBetCode } from '../bet-validation';
import { createShuffledDeck } from '../cards';
import { dealerQualifies, evaluateThreeCardHand, resolvePlayedHand } from './rules';
import type {
	ThreeCardHandEvaluation,
	ThreeCardShowdownRoundResult,
	ThreeCardShowdownState,
	ThreeCardWagerErrorCode,
} from './types';

export const MIN_ANTE = 1;
export const MAX_ANTE = 100;
export const ANTE_OPTIONS = [1, 5, 10, 25, 50, 100] as const;

function normalizeBalance(balance: number): number {
	if (!Number.isFinite(balance) || balance < 0) {
		throw new RangeError('Balance must be a non-negative finite number');
	}
	return Math.trunc(balance);
}

function cloneEvaluation(evaluation: ThreeCardHandEvaluation): ThreeCardHandEvaluation {
	return { ...evaluation, tieBreakers: [...evaluation.tieBreakers] };
}

function cloneResult(result: ThreeCardShowdownRoundResult): ThreeCardShowdownRoundResult {
	return {
		...result,
		playerHand: result.playerHand.map((card) => ({ ...card })),
		dealerHand: result.dealerHand.map((card) => ({ ...card })),
		playerEvaluation: cloneEvaluation(result.playerEvaluation),
		dealerEvaluation: cloneEvaluation(result.dealerEvaluation),
	};
}

export class ThreeCardShowdownGame {
	private readonly random: () => number;
	private state: ThreeCardShowdownState;

	constructor(initialBalance: number, random: () => number = Math.random) {
		this.random = random;
		this.state = {
			phase: 'betting',
			balance: normalizeBalance(initialBalance),
			ante: ANTE_OPTIONS[0],
			playerHand: [],
			dealerHand: [],
			result: null,
		};
	}

	getState(): Readonly<ThreeCardShowdownState> {
		return {
			phase: this.state.phase,
			balance: this.state.balance,
			ante: this.state.ante,
			playerHand: this.state.playerHand.map((card) => ({ ...card })),
			dealerHand: this.state.dealerHand.map((card) => ({ ...card })),
			result: this.state.result ? cloneResult(this.state.result) : null,
		};
	}

	/** Language-neutral validation result; the client translates the code. */
	getAnteError(ante: number): ThreeCardWagerErrorCode | null {
		if (!Number.isInteger(ante)) return 'whole-number-required';
		const rangeError = validateBetCode(ante, MIN_ANTE, MAX_ANTE);
		if (rangeError) return rangeError;
		if (ante * 2 > this.state.balance) return 'insufficient-balance';
		return null;
	}

	setAnte(ante: number): void {
		if (this.state.phase !== 'betting') throw new Error('Ante can only change during betting');
		const error = this.getAnteError(ante);
		if (error) throw new Error(error);
		this.state.ante = ante;
	}

	deal(): void {
		if (this.state.phase !== 'betting') throw new Error('Deal is only allowed during betting');
		const error = this.getAnteError(this.state.ante);
		if (error) throw new Error(error);

		const deck = createShuffledDeck(this.random);
		this.state = {
			...this.state,
			phase: 'decision',
			balance: this.state.balance - this.state.ante,
			playerHand: deck.slice(0, 3),
			dealerHand: deck.slice(3, 6),
			result: null,
		};
	}

	fold(): ThreeCardShowdownRoundResult {
		if (this.state.phase !== 'decision') throw new Error('Fold is only allowed after dealing');
		const { ante, playerHand, dealerHand } = this.state;
		const dealerEvaluation = evaluateThreeCardHand(dealerHand);
		const result: ThreeCardShowdownRoundResult = {
			outcome: 'fold',
			ante,
			totalWager: ante,
			grossPayout: 0,
			netDelta: -ante,
			dealerQualified: dealerQualifies(dealerEvaluation),
			playerHand: [...playerHand],
			dealerHand: [...dealerHand],
			playerEvaluation: evaluateThreeCardHand(playerHand),
			dealerEvaluation,
		};
		this.state = { ...this.state, phase: 'complete', result };
		// Deep clone so callers cannot mutate internal state through the return value.
		return cloneResult(result);
	}

	play(): ThreeCardShowdownRoundResult {
		if (this.state.phase !== 'decision') throw new Error('Play is only allowed after dealing');
		const result = resolvePlayedHand(this.state.playerHand, this.state.dealerHand, this.state.ante);
		this.state = {
			...this.state,
			phase: 'complete',
			balance: this.state.balance - this.state.ante + result.grossPayout,
			result,
		};
		// Deep clone so callers cannot mutate internal state through the return value.
		return cloneResult(result);
	}

	resetRound(): void {
		if (this.state.phase !== 'complete') throw new Error('Only a completed hand can be reset');
		this.state = {
			...this.state,
			phase: 'betting',
			playerHand: [],
			dealerHand: [],
			result: null,
		};
	}

	setBalance(balance: number): void {
		this.state.balance = normalizeBalance(balance);
	}
}
