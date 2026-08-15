/**
 * Pure two-phase Sic Bo game state machine: betting -> complete.
 * No DOM, no wallet: balance, bet slip, dice, and the last result only.
 */

import { rollThreeDice } from './dice';
import { SIC_BO_CHIP_DENOMINATIONS, resolveBet } from './rules';
import type { SicBoBetKey, SicBoPhase, SicBoRoll, SicBoRoundResult, SicBoState } from './types';

export class SicBoGame {
	private phase: SicBoPhase = 'betting';
	private balance: number;
	private bets: Partial<Record<SicBoBetKey, number>> = {};
	private lastResult: SicBoRoundResult | null = null;
	private readonly random: () => number;

	constructor(initialBalance: number, random: () => number = Math.random) {
		this.balance = this.sanitizeBalance(initialBalance);
		this.random = random;
	}

	getState(): Readonly<SicBoState> {
		return {
			phase: this.phase,
			balance: this.balance,
			bets: { ...this.bets },
			result: this.lastResult === null ? null : this.copyResult(this.lastResult),
		};
	}

	getTotalStake(): number {
		return Object.values(this.bets).reduce((sum, amount) => sum + (amount ?? 0), 0);
	}

	getBetError(key: SicBoBetKey, amount: number): string | null {
		if (this.phase !== 'betting') return 'Bets can only change before rolling';
		if (!SIC_BO_CHIP_DENOMINATIONS.includes(amount as (typeof SIC_BO_CHIP_DENOMINATIONS)[number])) {
			return 'Choose a valid chip denomination';
		}
		const otherStake = this.getTotalStake() - (this.bets[key] ?? 0);
		if (otherStake + amount > this.balance) return 'Selected bets exceed available balance';
		return null;
	}

	getRollError(): string | null {
		if (this.phase !== 'betting') return 'Start a new round before rolling again';
		const stake = this.getTotalStake();
		if (stake === 0) return 'Place at least one bet';
		if (stake > this.balance) return 'Selected bets exceed available balance';
		return null;
	}

	setBet(key: SicBoBetKey, amount: number): void {
		const error = this.getBetError(key, amount);
		if (error !== null) throw new Error(error);
		this.bets[key] = amount;
	}

	clearBet(key: SicBoBetKey): void {
		if (this.phase !== 'betting') throw new Error('Bets can only change before rolling');
		delete this.bets[key];
	}

	clearBets(): void {
		if (this.phase !== 'betting') throw new Error('Bets can only change before rolling');
		this.bets = {};
	}

	roll(): SicBoRoundResult {
		if (this.phase !== 'betting') throw new Error('Start a new round before rolling again');
		const rollError = this.getRollError();
		if (rollError !== null) throw new Error(rollError);

		const roll: SicBoRoll = rollThreeDice(this.random);
		const totalStake = this.getTotalStake();
		const results = (Object.entries(this.bets) as Array<[string, number]>).map(([key, amount]) =>
			resolveBet({ key: key as SicBoBetKey, amount }, roll),
		);
		const grossReturn = results.reduce((sum, result) => sum + result.grossReturn, 0);
		const netDelta = grossReturn - totalStake;
		this.balance += netDelta;
		this.lastResult = { roll, totalStake, grossReturn, netDelta, results };
		this.phase = 'complete';
		return this.copyResult(this.lastResult);
	}

	/** Start a new round: back to betting, keeping the retained bet slip. */
	resetRound(): void {
		this.phase = 'betting';
		this.lastResult = null;
	}

	/** Adopt an authoritative balance: non-negative finite only, truncated to whole chips. */
	setBalance(balance: number): void {
		this.balance = this.sanitizeBalance(balance);
	}

	private sanitizeBalance(balance: number): number {
		if (!Number.isFinite(balance) || balance < 0) {
			throw new Error('Balance must be a non-negative finite number');
		}
		return Math.trunc(balance);
	}

	private copyResult(result: SicBoRoundResult): SicBoRoundResult {
		return {
			...result,
			roll: [...result.roll],
			results: result.results.map((r) => ({ ...r })),
		};
	}
}
