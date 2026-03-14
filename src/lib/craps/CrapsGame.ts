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
	DiceRoll,
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
	OFF_DURING_COME_OUT,
	BET_LABELS,
	ODDS_ELIGIBLE_BET_TYPES,
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

function isIntegerNumber(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value);
}

function isPositiveInteger(value: unknown): value is number {
	return isIntegerNumber(value) && value >= 1;
}

function isNonNegativeInteger(value: unknown): value is number {
	return isIntegerNumber(value) && value >= 0;
}

function sanitizeSettings(input?: Partial<CrapsSettings>): CrapsSettings {
	const merged = { ...DEFAULT_SETTINGS, ...input };

	let minBet = isPositiveInteger(merged.minBet) ? merged.minBet : DEFAULT_SETTINGS.minBet;
	let maxBet = isPositiveInteger(merged.maxBet) ? merged.maxBet : DEFAULT_SETTINGS.maxBet;
	let maxOddsMultiplier = isPositiveInteger(merged.maxOddsMultiplier)
		? merged.maxOddsMultiplier
		: DEFAULT_SETTINGS.maxOddsMultiplier;

	minBet = Math.max(1, minBet);
	maxBet = Math.max(1, maxBet);
	maxOddsMultiplier = Math.max(1, maxOddsMultiplier);

	if (minBet > maxBet) {
		minBet = maxBet;
	}

	return {
		minBet,
		maxBet,
		maxOddsMultiplier,
		animationSpeed:
			merged.animationSpeed === 'slow' ||
			merged.animationSpeed === 'normal' ||
			merged.animationSpeed === 'fast'
				? merged.animationSpeed
				: DEFAULT_SETTINGS.animationSpeed,
		llmEnabled:
			typeof merged.llmEnabled === 'boolean' ? merged.llmEnabled : DEFAULT_SETTINGS.llmEnabled,
		soundEnabled:
			typeof merged.soundEnabled === 'boolean'
				? merged.soundEnabled
				: DEFAULT_SETTINGS.soundEnabled,
	};
}

function sanitizeRoll(roll: unknown): DiceRoll | null {
	if (!roll || typeof roll !== 'object') return null;
	const candidate = roll as Partial<DiceRoll>;
	const die1 = candidate?.die1;
	const die2 = candidate?.die2;
	const total = candidate?.total;
	if (
		typeof die1 !== 'number' ||
		typeof die2 !== 'number' ||
		typeof total !== 'number' ||
		!Number.isInteger(die1) ||
		!Number.isInteger(die2) ||
		!Number.isInteger(total) ||
		die1 < 1 ||
		die1 > 6 ||
		die2 < 1 ||
		die2 > 6 ||
		total !== die1 + die2 ||
		total < 2 ||
		total > 12
	) {
		return null;
	}
	return {
		die1: die1 as DiceRoll['die1'],
		die2: die2 as DiceRoll['die2'],
		total: total as DiceRoll['total'],
	};
}

function sanitizeBet(bet: unknown): CrapsBet | null {
	if (!bet || typeof bet !== 'object') return null;
	const candidate = bet as Partial<CrapsBet>;
	if (typeof candidate.id !== 'string' || !candidate.id) return null;
	if (typeof candidate.type !== 'string' || !Object.hasOwn(BET_LABELS, candidate.type)) return null;
	const type = candidate.type as BetType;
	const amount = candidate.amount;
	if (!isPositiveInteger(amount)) {
		return null;
	}
	const point =
		candidate.point === undefined || candidate.point === null
			? undefined
			: isPointNumber(candidate.point)
				? candidate.point
				: null;
	if (point === null) return null;
	const odds =
		candidate.odds === undefined
			? undefined
			: ODDS_ELIGIBLE_BET_TYPES.has(type) && isNonNegativeInteger(candidate.odds)
				? candidate.odds
				: null;
	if (odds === null) return null;
	return {
		id: candidate.id,
		type,
		amount,
		...(point !== undefined ? { point } : {}),
		...(odds !== undefined ? { odds } : {}),
	};
}

export class CrapsGame {
	private state: CrapsGameState;

	constructor(config: CrapsGameConfig) {
		const settings = sanitizeSettings(config.settings);
		const initialBalance = isNonNegativeInteger(config.initialBalance) ? config.initialBalance : 0;
		this.state = {
			phase: 'come-out',
			point: null,
			lastRoll: null,
			rollHistory: [],
			activeBets: [],
			chipBalance: initialBalance,
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

	public restoreState(snapshot: Partial<CrapsGameState>): boolean {
		if (!snapshot || typeof snapshot !== 'object') return false;
		const phase =
			snapshot.phase === 'point' ? 'point' : snapshot.phase === 'come-out' ? 'come-out' : null;
		if (!phase) return false;
		const point =
			snapshot.point === null || snapshot.point === undefined
				? null
				: isPointNumber(snapshot.point)
					? snapshot.point
					: null;
		if (snapshot.point !== undefined && snapshot.point !== null && point === null) return false;
		if (phase === 'come-out' && point !== null) return false;
		if (phase === 'point' && point === null) return false;
		const chipBalance = snapshot.chipBalance;
		if (!isNonNegativeInteger(chipBalance)) {
			return false;
		}
		const rollCount =
			typeof snapshot.rollCount === 'number' &&
			Number.isInteger(snapshot.rollCount) &&
			snapshot.rollCount >= 0
				? snapshot.rollCount
				: 0;
		const rollHistory = Array.isArray(snapshot.rollHistory)
			? snapshot.rollHistory
					.map((roll) => sanitizeRoll(roll))
					.filter((roll): roll is NonNullable<typeof roll> => roll !== null)
					.slice(0, MAX_ROLL_HISTORY)
			: [];
		const activeBets = Array.isArray(snapshot.activeBets)
			? snapshot.activeBets
					.map((bet) => sanitizeBet(bet))
					.filter((bet): bet is CrapsBet => bet !== null)
			: [];
		const lastRoll = sanitizeRoll(snapshot.lastRoll);
		this.state = {
			phase,
			point,
			lastRoll,
			rollHistory,
			activeBets,
			chipBalance,
			rollCount,
			settings: sanitizeSettings(snapshot.settings ?? this.state.settings),
		};
		return true;
	}

	// ─── betting ──────────────────────────────────────────────────────────────

	/** Calculate cumulative amount already bet on a specific bet type */
	private getExistingBetAmount(type: BetType): number {
		return this.state.activeBets
			.filter((b) => b.type === type)
			.reduce((sum, b) => sum + b.amount, 0);
	}

	public canPlaceBet(type: BetType, amount: number): { ok: boolean; error?: string } {
		const { phase, settings, chipBalance, activeBets } = this.state;
		if (
			!isPositiveInteger(amount) ||
			!isPositiveInteger(settings.minBet) ||
			!isPositiveInteger(settings.maxBet) ||
			!isPositiveInteger(settings.maxOddsMultiplier) ||
			!isNonNegativeInteger(chipBalance)
		) {
			return { ok: false, error: 'Invalid bet amount' };
		}

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
		// Reject duplicate line bets - standard craps rules allow only one Pass/Don't Pass bet
		if (type === 'passLine' && activeBets.some((b) => b.type === 'passLine')) {
			return { ok: false, error: 'You can only have one Pass Line bet' };
		}
		if (type === 'dontPass' && activeBets.some((b) => b.type === 'dontPass')) {
			return { ok: false, error: "You can only have one Don't Pass bet" };
		}
		if (amount < settings.minBet) {
			return { ok: false, error: `Minimum bet is $${settings.minBet}` };
		}

		// Enforce cumulative max bet: check total existing + new amount against maxBet
		// Pass Line/Don't Pass already enforced as single bets above
		// Pass/Dont Pass odds are attached to line bet, handled separately below
		// For Come/Don'tCome, count ALL bets (both on-the-line and established) plus odds
		// to prevent unbounded exposure that could exceed sync caps on a single roll
		let existingAmount: number;
		if (type === 'come' || type === 'dontCome') {
			existingAmount = this.state.activeBets
				.filter((b) => b.type === type)
				.reduce((sum, b) => sum + b.amount + (b.odds ?? 0), 0);
		} else {
			existingAmount = this.getExistingBetAmount(type);
		}
		const totalAmount = existingAmount + amount;
		if (totalAmount > settings.maxBet) {
			const remaining = settings.maxBet - existingAmount;
			return {
				ok: false,
				error: `Maximum bet is $${settings.maxBet} ($${remaining} remaining on this bet type)`,
			};
		}
		// Check odds limits
		if (type === 'passLineOdds' || type === 'dontPassOdds') {
			const lineBetType = type === 'passLineOdds' ? 'passLine' : 'dontPass';
			const lineBet = activeBets.find((b) => b.type === lineBetType);
			if (lineBet) {
				const lineAmount = lineBet.amount;
				const currentOdds = lineBet.odds ?? 0;
				if (!isPositiveInteger(lineAmount) || !isNonNegativeInteger(currentOdds)) {
					return { ok: false, error: 'Invalid bet amount' };
				}
				const maxOdds = lineAmount * settings.maxOddsMultiplier;
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
		if (
			!isPositiveInteger(amount) ||
			!isNonNegativeInteger(this.state.chipBalance) ||
			!isPositiveInteger(this.state.settings.maxOddsMultiplier)
		) {
			return { success: false, error: 'Invalid bet amount' };
		}
		if (amount > this.state.chipBalance) return { success: false, error: 'Insufficient chips' };

		const currentOdds = bet.odds ?? 0;
		if (!isPositiveInteger(bet.amount) || !isNonNegativeInteger(currentOdds)) {
			return { success: false, error: 'Invalid bet amount' };
		}

		const maxOdds = bet.amount * this.state.settings.maxOddsMultiplier;
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
		// For locked bets (passLine/dontPass after point, come/dontCome with point):
		// - The flat bet stays on the table (required bet)
		// - Odds can be removed (free odds are optional)
		// For all other bets: fully refund and remove
		const stillActive: CrapsBet[] = [];

		for (const bet of this.state.activeBets) {
			const isLockedFlat =
				((bet.type === 'passLine' || bet.type === 'dontPass') && this.state.phase === 'point') ||
				((bet.type === 'come' || bet.type === 'dontCome') && bet.point);

			if (isLockedFlat) {
				// Locked flat bet: refund odds if present, keep flat bet
				if (bet.odds) {
					this.state.chipBalance += bet.odds;
					bet.odds = undefined;
				}
				stillActive.push(bet);
			} else {
				// Non-locked bet: refund full amount and remove
				this.state.chipBalance += bet.amount + (bet.odds ?? 0);
			}
		}

		this.state.activeBets = stillActive;
	}

	public canRoll(): boolean {
		if (this.state.activeBets.length === 0) return false;
		// During come-out, place/buy/lay/hardway bets are off — they stay on the table but
		// don't resolve.  Require at least one working bet so the player cannot free-roll
		// the come-out phase with only off bets on the table.
		if (this.state.phase === 'come-out') {
			return this.state.activeBets.some((bet) => !OFF_DURING_COME_OUT.has(bet.type));
		}
		return true;
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
				case 'win': {
					const isPersistent = ev.persistent || PERSISTENT_WIN_BET_TYPES.has(ev.bet.type);
					if (isPersistent) {
						// Only credit payout + odds; stake stays on table
						this.state.chipBalance += (ev.bet.odds ?? 0) + ev.payout;
						nextBets.push(ev.updatedBet ?? ev.bet);
					} else {
						// Non-persistent bets: return stake + payout + odds
						this.state.chipBalance += ev.bet.amount + (ev.bet.odds ?? 0) + ev.payout;
					}
					break;
				}
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
			if (total === 7) return { phase: 'come-out', point: null, message: 'Natural 7!' };
			if (total === 11) return { phase: 'come-out', point: null, message: 'Yo-Eleven!' };
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
					message: `${names[total ?? 0]}! Point made!`,
				};
			}
			if (total === 7) {
				return { phase: 'come-out', point: null, message: 'Seven out!' };
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
		if (!isNonNegativeInteger(balance)) return false;
		this.state.chipBalance = balance;
		return true;
	}

	public applyServerBalance(balance: number): boolean {
		if (isNonNegativeInteger(balance)) {
			this.state.chipBalance = balance;
			return true;
		}
		console.error(`[CrapsGame] applyServerBalance received invalid value: ${balance}`);
		return false;
	}

	public hasInsufficientChips(): boolean {
		return this.state.chipBalance < this.state.settings.minBet;
	}

	// ─── settings ─────────────────────────────────────────────────────────────

	public updateSettings(updates: Partial<CrapsSettings>): void {
		this.state.settings = sanitizeSettings({ ...this.state.settings, ...updates });
	}
}
