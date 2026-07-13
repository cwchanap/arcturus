import {
	DEFAULT_SETTINGS,
	MAX_BET_PER_POSITION,
	MAX_ROUND_HISTORY,
	MAX_TOTAL_BET,
	MIN_BET,
} from './constants';
import { evaluateBets } from './betEvaluator';
import type {
	BetType,
	RouletteBet,
	RouletteGameConfig,
	RouletteGameState,
	RouletteSettings,
	SpinResult,
} from './types';

function newBetId(): string {
	if (typeof globalThis.crypto?.randomUUID === 'function') {
		return globalThis.crypto.randomUUID();
	}
	return `bet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function sanitizeSettings(input?: Partial<RouletteSettings>): RouletteSettings {
	const merged = { ...DEFAULT_SETTINGS, ...input };
	return {
		animationSpeed:
			merged.animationSpeed === 'slow' || merged.animationSpeed === 'fast'
				? merged.animationSpeed
				: 'normal',
		soundEnabled: typeof merged.soundEnabled === 'boolean' ? merged.soundEnabled : true,
	};
}

function positionKey(type: BetType, target?: number): string {
	return `${type}:${target ?? 'none'}`;
}

export class RouletteGame {
	private state: RouletteGameState;

	constructor(config: RouletteGameConfig) {
		const balance =
			typeof config.initialBalance === 'number' && Number.isFinite(config.initialBalance)
				? Math.max(0, Math.trunc(config.initialBalance))
				: 0;
		this.state = {
			phase: 'betting',
			activeBets: [],
			chipBalance: balance,
			selectedChipAmount: 5,
			lastSpin: null,
			roundHistory: [],
			settings: sanitizeSettings(config.settings),
		};
	}

	getState(): Readonly<RouletteGameState> {
		return {
			...this.state,
			activeBets: this.state.activeBets.map((b) => ({ ...b })),
			roundHistory: this.state.roundHistory.map((s) => ({ ...s })),
		};
	}

	getBalance(): number {
		return this.state.chipBalance;
	}

	setBalance(n: number): void {
		this.state.chipBalance = Math.max(0, Math.trunc(n));
	}

	private getExistingPositionAmount(type: BetType, target?: number): number {
		const key = positionKey(type, target);
		return this.state.activeBets
			.filter((b) => positionKey(b.type, b.target) === key)
			.reduce((sum, b) => sum + b.amount, 0);
	}

	private getTotalBet(): number {
		return this.state.activeBets.reduce((sum, b) => sum + b.amount, 0);
	}

	canPlaceBet(type: BetType, amount: number, target?: number): { ok: boolean; error?: string } {
		if (!Number.isInteger(amount) || amount < MIN_BET) {
			return { ok: false, error: `Minimum bet is ${MIN_BET} chip` };
		}
		if (amount > this.state.chipBalance) {
			return { ok: false, error: 'Insufficient chips' };
		}
		const existingPosition = this.getExistingPositionAmount(type, target);
		if (existingPosition + amount > MAX_BET_PER_POSITION) {
			return {
				ok: false,
				error: `Max ${MAX_BET_PER_POSITION} per position (${MAX_BET_PER_POSITION - existingPosition} remaining)`,
			};
		}
		const totalAfter = this.getTotalBet() + amount;
		if (totalAfter > MAX_TOTAL_BET) {
			return { ok: false, error: `Max total bet is ${MAX_TOTAL_BET}` };
		}
		return { ok: true };
	}

	placeBet(
		type: BetType,
		amount: number,
		target?: number,
	): { success: boolean; error?: string; bet?: RouletteBet } {
		if (this.state.phase !== 'betting') {
			return { success: false, error: 'Cannot place bets during spin' };
		}
		const check = this.canPlaceBet(type, amount, target);
		if (!check.ok) return { success: false, error: check.error };

		const key = positionKey(type, target);
		const existingIdx = this.state.activeBets.findIndex(
			(b) => positionKey(b.type, b.target) === key,
		);

		if (existingIdx >= 0) {
			this.state.activeBets[existingIdx] = {
				...this.state.activeBets[existingIdx],
				amount: this.state.activeBets[existingIdx].amount + amount,
			};
			this.state.chipBalance -= amount;
			return { success: true, bet: { ...this.state.activeBets[existingIdx] } };
		}

		const bet: RouletteBet = {
			id: newBetId(),
			type,
			amount,
			...(target !== undefined ? { target } : {}),
		};
		this.state.activeBets.push(bet);
		this.state.chipBalance -= amount;
		return { success: true, bet };
	}

	removeBet(betId: string): { success: boolean; error?: string } {
		const idx = this.state.activeBets.findIndex((b) => b.id === betId);
		if (idx === -1) return { success: false, error: 'Bet not found' };
		this.state.chipBalance += this.state.activeBets[idx].amount;
		this.state.activeBets.splice(idx, 1);
		return { success: true };
	}

	clearBets(): void {
		for (const bet of this.state.activeBets) {
			this.state.chipBalance += bet.amount;
		}
		this.state.activeBets = [];
	}

	newRound(): void {
		this.state.phase = 'betting';
		this.state.activeBets = [];
	}

	beginSpin(): RouletteBet[] {
		if (this.state.phase !== 'betting') {
			throw new Error('Cannot spin outside betting phase');
		}
		if (this.state.activeBets.length === 0) {
			throw new Error('No bets placed');
		}
		const bets = this.state.activeBets.map((b) => ({ ...b }));
		this.state.phase = 'spinning';
		return bets;
	}

	applySettlement(spinResult: SpinResult): void {
		this.state.chipBalance = spinResult.results.reduce(
			(s, r) => s + (r.won ? r.payout : 0),
			Math.max(0, this.state.chipBalance),
		);
		if (spinResult.newBalance !== undefined) {
			this.state.chipBalance = spinResult.newBalance;
		}
		this.state.phase = 'settled';
		this.state.activeBets = [];
		this.state.lastSpin = spinResult;
		this.state.roundHistory.unshift(spinResult);
		if (this.state.roundHistory.length > MAX_ROUND_HISTORY) {
			this.state.roundHistory.length = MAX_ROUND_HISTORY;
		}
	}

	spinGuest(winningNumber: number): SpinResult {
		if (this.state.phase !== 'betting') {
			throw new Error('Cannot spin outside betting phase');
		}
		if (this.state.activeBets.length === 0) {
			throw new Error('No bets placed');
		}
		if (winningNumber < 0 || winningNumber > 36 || !Number.isInteger(winningNumber)) {
			throw new Error('Invalid winning number');
		}

		this.state.phase = 'spinning';

		const bets = this.state.activeBets.map((b) => ({ ...b }));
		const totalBet = bets.reduce((s, b) => s + b.amount, 0);
		const results = evaluateBets(bets, winningNumber);
		const totalPayout = results.reduce((s, r) => s + r.payout, 0);

		this.state.chipBalance += totalPayout;
		this.state.phase = 'settled';
		this.state.activeBets = [];

		const spinResult: SpinResult = {
			winningNumber,
			bets,
			totalBet,
			totalPayout,
			netDelta: totalPayout - totalBet,
			results,
			timestamp: Date.now(),
			syncId: '',
		};

		this.state.lastSpin = spinResult;
		this.state.roundHistory.unshift(spinResult);
		if (this.state.roundHistory.length > MAX_ROUND_HISTORY) {
			this.state.roundHistory.length = MAX_ROUND_HISTORY;
		}

		return spinResult;
	}

	restoreState(snapshot: unknown): boolean {
		if (!snapshot || typeof snapshot !== 'object') return false;
		const s = snapshot as Partial<RouletteGameState>;
		if (s.phase !== 'betting' && s.phase !== 'spinning' && s.phase !== 'settled') return false;
		if (
			typeof s.chipBalance !== 'number' ||
			!Number.isInteger(s.chipBalance) ||
			s.chipBalance < 0
		) {
			return false;
		}
		if (!Array.isArray(s.activeBets)) return false;

		this.state = {
			phase: s.phase,
			activeBets: s.activeBets.map((b) => ({ ...b })),
			chipBalance: s.chipBalance,
			selectedChipAmount:
				typeof s.selectedChipAmount === 'number'
					? s.selectedChipAmount
					: this.state.selectedChipAmount,
			lastSpin: s.lastSpin ? { ...s.lastSpin } : null,
			roundHistory: Array.isArray(s.roundHistory) ? s.roundHistory.map((r) => ({ ...r })) : [],
			settings: sanitizeSettings(s.settings),
		};
		return true;
	}
}
