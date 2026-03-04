/**
 * CrapsGame — main game state manager
 *
 * Chip accounting:
 *   - chipBalance is the player's actual available balance (bets already deducted)
 *   - When a bet is placed: balance -= amount
 *   - On win:  balance += bet.amount + (bet.odds ?? 0) + payout  (return risk + profit)
 *   - On lose: no change  (risk already gone when placed)
 *   - On push: balance += bet.amount + (bet.odds ?? 0)  (return risk, no profit)
 */

import type {
	CrapsBet,
	CrapsGameState,
	CrapsSettings,
	GamePhase,
	PointNumber,
	RollResult,
	BetType,
} from './types';
import { rollDice } from './diceRoller';
import { evaluateBets, computeNetDelta, isPointNumber } from './betEvaluator';
import {
	DEFAULT_SETTINGS,
	MAX_ROLL_HISTORY,
	COME_OUT_ONLY_BETS,
	POINT_PHASE_ONLY_BETS,
} from './constants';

let _idCounter = 0;
function newId(): string {
	return `bet-${++_idCounter}-${Date.now()}`;
}

const PERSISTENT_WIN_BET_TYPES = new Set<BetType>([
	'place4',
	'place5',
	'place6',
	'place8',
	'place9',
	'place10',
	'buy4',
	'buy5',
	'buy6',
	'buy8',
	'buy9',
	'buy10',
	'lay4',
	'lay5',
	'lay6',
	'lay8',
	'lay9',
	'lay10',
	'hard4',
	'hard6',
	'hard8',
	'hard10',
	'big6',
	'big8',
]);

export interface CrapsGameConfig {
	initialBalance: number;
	settings?: Partial<CrapsSettings>;
}

export class CrapsGame {
	private state: CrapsGameState;

	constructor(config: CrapsGameConfig) {
		const settings: CrapsSettings = { ...DEFAULT_SETTINGS, ...config.settings };
		this.state = {
			phase: 'come-out',
			point: null,
			lastRoll: null,
			rollHistory: [],
			activeBets: [],
			chipBalance: config.initialBalance,
			rollCount: 0,
			settings,
		};
	}

	// ─── state ────────────────────────────────────────────────────────────────

	public getState(): Readonly<CrapsGameState> {
		return {
			...this.state,
			lastRoll: this.state.lastRoll ? { ...this.state.lastRoll } : null,
			rollHistory: this.state.rollHistory.map((roll) => ({ ...roll })),
			activeBets: this.state.activeBets.map((bet) => ({ ...bet })),
			settings: { ...this.state.settings },
		};
	}

	public getBalance(): number {
		return this.state.chipBalance;
	}

	/** Total chips currently at risk (sum of all active bet amounts + odds) */
	public getTotalAtRisk(): number {
		return this.state.activeBets.reduce((sum, b) => sum + b.amount + (b.odds ?? 0), 0);
	}

	// ─── betting ──────────────────────────────────────────────────────────────

	public canPlaceBet(type: BetType, amount: number): { ok: boolean; error?: string } {
		const { phase, settings, chipBalance, activeBets } = this.state;

		if (COME_OUT_ONLY_BETS.has(type) && phase !== 'come-out') {
			return { ok: false, error: `${type} can only be placed during come-out` };
		}
		if (POINT_PHASE_ONLY_BETS.has(type) && phase !== 'point') {
			return { ok: false, error: `${type} can only be placed during point phase` };
		}
		if (type === 'passLineOdds') {
			const hasPassLine = activeBets.some((b) => b.type === 'passLine');
			if (!hasPassLine) return { ok: false, error: 'No Pass Line bet to put odds on' };
		}
		if (type === 'dontPassOdds') {
			const hasDontPass = activeBets.some((b) => b.type === 'dontPass');
			if (!hasDontPass) return { ok: false, error: "No Don't Pass bet to put odds on" };
		}
		if (amount < settings.minBet) {
			return { ok: false, error: `Minimum bet is $${settings.minBet}` };
		}
		if (amount > settings.maxBet) {
			return { ok: false, error: `Maximum bet is $${settings.maxBet}` };
		}
		// Check odds limits
		if (type === 'passLineOdds' || type === 'dontPassOdds') {
			const lineBetType = type === 'passLineOdds' ? 'passLine' : 'dontPass';
			const lineBet = activeBets.find((b) => b.type === lineBetType);
			if (lineBet) {
				const maxOdds = lineBet.amount * settings.maxOddsMultiplier;
				const currentOdds = lineBet.odds ?? 0;
				if (currentOdds + amount > maxOdds) {
					return {
						ok: false,
						error: `Max odds is ${settings.maxOddsMultiplier}x your line bet ($${maxOdds - currentOdds} remaining)`,
					};
				}
			}
		}
		if (amount > chipBalance) {
			return { ok: false, error: 'Insufficient chips' };
		}
		return { ok: true };
	}

	/**
	 * Place a bet. Returns the new bet on success or an error message on failure.
	 * For passLineOdds/dontPassOdds, the amount is added to the line bet's odds field.
	 */
	public placeBet(
		type: BetType,
		amount: number,
	): { success: boolean; error?: string; bet?: CrapsBet } {
		const check = this.canPlaceBet(type, amount);
		if (!check.ok) return { success: false, error: check.error };

		// Odds bets attach to existing line bet rather than creating a new bet record
		if (type === 'passLineOdds' || type === 'dontPassOdds') {
			const lineBetType = type === 'passLineOdds' ? 'passLine' : 'dontPass';
			const idx = this.state.activeBets.findIndex((b) => b.type === lineBetType);
			if (idx !== -1) {
				this.state.activeBets[idx] = {
					...this.state.activeBets[idx],
					odds: (this.state.activeBets[idx].odds ?? 0) + amount,
				};
				this.state.chipBalance -= amount;
				return { success: true, bet: this.state.activeBets[idx] };
			}
		}

		const bet: CrapsBet = { id: newId(), type, amount };
		this.state.activeBets.push(bet);
		this.state.chipBalance -= amount;
		return { success: true, bet };
	}

	/** Add come-bet odds to an established Come/DontCome bet by id */
	public addComeBetOdds(betId: string, amount: number): { success: boolean; error?: string } {
		const idx = this.state.activeBets.findIndex((b) => b.id === betId);
		if (idx === -1) return { success: false, error: 'Bet not found' };

		const bet = this.state.activeBets[idx];
		if (bet.type !== 'come' && bet.type !== 'dontCome') {
			return { success: false, error: 'Odds can only be added to Come/DontCome bets' };
		}
		if (!bet.point) {
			return { success: false, error: "Can't add odds before come point is established" };
		}
		if (amount < 1) return { success: false, error: 'Odds amount must be positive' };
		if (amount > this.state.chipBalance) return { success: false, error: 'Insufficient chips' };

		const maxOdds = bet.amount * this.state.settings.maxOddsMultiplier;
		const currentOdds = bet.odds ?? 0;
		if (currentOdds + amount > maxOdds) {
			return {
				success: false,
				error: `Max odds is ${this.state.settings.maxOddsMultiplier}x ($${maxOdds - currentOdds} remaining)`,
			};
		}

		this.state.activeBets[idx] = { ...bet, odds: currentOdds + amount };
		this.state.chipBalance -= amount;
		return { success: true };
	}

	/**
	 * Remove a bet and return its amount to the balance.
	 * Pass Line / Don't Pass cannot be removed after the point is established.
	 * Come / Don't Come cannot be removed after their point is established.
	 */
	public removeBet(betId: string): { success: boolean; error?: string } {
		const idx = this.state.activeBets.findIndex((b) => b.id === betId);
		if (idx === -1) return { success: false, error: 'Bet not found' };

		const bet = this.state.activeBets[idx];

		// Line bets locked after point established
		if ((bet.type === 'passLine' || bet.type === 'dontPass') && this.state.phase === 'point') {
			return { success: false, error: 'Cannot remove line bet after point is established' };
		}
		// Come bets locked once their come point is set
		if ((bet.type === 'come' || bet.type === 'dontCome') && bet.point) {
			return { success: false, error: 'Cannot remove Come bet after come point is established' };
		}

		// Return the full at-risk amount (bet + odds if any)
		this.state.chipBalance += bet.amount + (bet.odds ?? 0);
		this.state.activeBets.splice(idx, 1);
		return { success: true };
	}

	public clearBets(): void {
		// Only clears bets that are removable
		const removable = this.state.activeBets.filter((b) => {
			if ((b.type === 'passLine' || b.type === 'dontPass') && this.state.phase === 'point') {
				return false;
			}
			if ((b.type === 'come' || b.type === 'dontCome') && b.point) {
				return false;
			}
			return true;
		});
		for (const bet of removable) {
			this.state.chipBalance += bet.amount + (bet.odds ?? 0);
		}
		const removableIds = new Set(removable.map((b) => b.id));
		this.state.activeBets = this.state.activeBets.filter((b) => !removableIds.has(b.id));
	}

	public canRoll(): boolean {
		return this.state.activeBets.length > 0;
	}

	// ─── rolling ──────────────────────────────────────────────────────────────

	public roll(): RollResult | null {
		if (!this.canRoll()) return null;

		const roll = rollDice();
		const { total } = roll;

		// Record history before state changes
		this.state.lastRoll = roll;
		this.state.rollHistory.unshift(roll);
		if (this.state.rollHistory.length > MAX_ROLL_HISTORY) {
			this.state.rollHistory.pop();
		}
		this.state.rollCount++;

		const currentPhase = this.state.phase;
		const currentPoint = this.state.point;

		// Evaluate all bets
		const evaluations = evaluateBets(this.state.activeBets, roll, currentPhase, currentPoint);

		// Apply bet resolutions to balance and active bets list
		const nextBets: CrapsBet[] = [];
		for (const ev of evaluations) {
			switch (ev.outcome) {
				case 'win':
					this.state.chipBalance += ev.bet.amount + (ev.bet.odds ?? 0) + ev.payout;
					if (ev.persistent || PERSISTENT_WIN_BET_TYPES.has(ev.bet.type)) {
						nextBets.push(ev.updatedBet ?? ev.bet);
					}
					break;
				case 'push':
					this.state.chipBalance += ev.bet.amount + (ev.bet.odds ?? 0);
					break;
				case 'continue':
					// If updatedBet is set the come/dontCome point was just established
					nextBets.push(ev.updatedBet ?? ev.bet);
					break;
				// lose: bet already removed from balance when placed, nothing to do
			}
		}
		this.state.activeBets = nextBets;

		// Compute net delta (profit/loss from this roll's resolved bets)
		const netDelta = computeNetDelta(evaluations);

		// Determine new phase and message
		const {
			phase: newPhase,
			point: newPoint,
			message,
		} = this.resolvePhase(total, currentPhase, currentPoint);
		this.state.phase = newPhase;
		this.state.point = newPoint;

		return { roll, phase: newPhase, point: newPoint, evaluations, netDelta, message };
	}

	private resolvePhase(
		total: number,
		phase: GamePhase,
		currentPoint: PointNumber | null,
	): { phase: GamePhase; point: PointNumber | null; message: string } {
		if (phase === 'come-out') {
			if (total === 7)
				return { phase: 'come-out', point: null, message: 'Natural 7! Pass Line wins!' };
			if (total === 11)
				return { phase: 'come-out', point: null, message: 'Yo-Eleven! Pass Line wins!' };
			if (total === 2) return { phase: 'come-out', point: null, message: 'Snake Eyes! Craps!' };
			if (total === 3) return { phase: 'come-out', point: null, message: 'Ace Deuce! Craps!' };
			if (total === 12)
				return { phase: 'come-out', point: null, message: 'Boxcars! Craps! Bar 12.' };
			if (isPointNumber(total)) {
				const names: Record<number, string> = {
					4: '4',
					5: '5',
					6: 'Six',
					8: 'Eight',
					9: '9',
					10: '10',
				};
				return {
					phase: 'point',
					point: total,
					message: `Point is ${names[total]}! Roll it again!`,
				};
			}
		}

		if (phase === 'point') {
			if (total === currentPoint) {
				const names: Record<number, string> = {
					4: '4',
					5: '5',
					6: 'Six',
					8: 'Eight',
					9: '9',
					10: '10',
				};
				return {
					phase: 'come-out',
					point: null,
					message: `${names[total ?? 0]}! Point made! Pass Line wins!`,
				};
			}
			if (total === 7) {
				return { phase: 'come-out', point: null, message: 'Seven out! Pass Line loses.' };
			}
			return {
				phase: 'point',
				point: currentPoint,
				message: `Rolled ${total}. Keep shooting!`,
			};
		}

		return { phase, point: currentPoint, message: `Rolled ${total}` };
	}

	// ─── balance ──────────────────────────────────────────────────────────────

	public setBalance(balance: number): boolean {
		if (balance < 0) return false;
		this.state.chipBalance = balance;
		return true;
	}

	public applyServerBalance(balance: number): void {
		if (balance >= 0) this.state.chipBalance = balance;
	}

	public hasInsufficientChips(): boolean {
		return this.state.chipBalance < this.state.settings.minBet;
	}

	// ─── settings ─────────────────────────────────────────────────────────────

	public updateSettings(updates: Partial<CrapsSettings>): void {
		this.state.settings = { ...this.state.settings, ...updates };
	}
}
