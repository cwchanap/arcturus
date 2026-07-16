import {
	MAX_BET_PER_POSITION,
	MAX_BETS,
	MAX_ROUND_HISTORY,
	MAX_TOTAL_BET,
	MIN_BET,
} from './constants';
import { evaluateBets } from './betEvaluator';
import type {
	BetResult,
	BetType,
	RouletteBet,
	RouletteGameConfig,
	RouletteGameState,
	SpinResult,
} from './types';

function newBetId(): string {
	if (typeof globalThis.crypto?.randomUUID === 'function') {
		return globalThis.crypto.randomUUID();
	}
	return `bet-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function positionKey(type: BetType, target?: number): string {
	return `${type}:${target ?? 'none'}`;
}

const VALID_BET_TYPES = new Set<BetType>([
	'straight',
	'red',
	'black',
	'odd',
	'even',
	'low',
	'high',
	'dozen',
	'column',
]);
const OUTSIDE_BET_TYPES = new Set<BetType>(['red', 'black', 'odd', 'even', 'low', 'high']);

function isPositiveInteger(n: unknown): n is number {
	return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function sanitizeBet(bet: unknown): RouletteBet | null {
	if (!bet || typeof bet !== 'object') return null;
	const candidate = bet as Partial<RouletteBet>;
	if (typeof candidate.id !== 'string' || !candidate.id) return null;
	if (typeof candidate.type !== 'string' || !VALID_BET_TYPES.has(candidate.type as BetType)) {
		return null;
	}
	const type = candidate.type as BetType;
	if (!isPositiveInteger(candidate.amount)) return null;
	if (OUTSIDE_BET_TYPES.has(type) && candidate.target !== undefined) return null;
	if (type === 'straight') {
		if (
			typeof candidate.target !== 'number' ||
			!Number.isInteger(candidate.target) ||
			candidate.target < 0 ||
			candidate.target > 36
		) {
			return null;
		}
	}
	if (type === 'dozen' || type === 'column') {
		if (typeof candidate.target !== 'number' || ![0, 1, 2].includes(candidate.target)) {
			return null;
		}
	}
	return {
		id: candidate.id,
		type,
		amount: candidate.amount,
		...(candidate.target !== undefined ? { target: candidate.target } : {}),
	};
}

function sanitizeBetResult(b: unknown): BetResult | null {
	if (!b || typeof b !== 'object') return null;
	const c = b as Partial<BetResult>;
	const bet = sanitizeBet(c.bet);
	if (!bet) return null;
	if (typeof c.won !== 'boolean') return null;
	if (typeof c.payout !== 'number' || !Number.isInteger(c.payout) || c.payout < 0) return null;
	return { bet, won: c.won, payout: c.payout };
}

function sanitizeSpinResult(spin: unknown): SpinResult | null {
	if (!spin || typeof spin !== 'object') return null;
	const s = spin as Partial<SpinResult>;
	if (
		typeof s.winningNumber !== 'number' ||
		!Number.isInteger(s.winningNumber) ||
		s.winningNumber < 0 ||
		s.winningNumber > 36
	) {
		return null;
	}
	if (!Array.isArray(s.bets)) return null;
	const bets = s.bets.map(sanitizeBet).filter((b): b is RouletteBet => b !== null);
	if (bets.length !== s.bets.length) return null;
	if (typeof s.totalBet !== 'number' || !Number.isInteger(s.totalBet)) return null;
	if (typeof s.totalPayout !== 'number' || !Number.isInteger(s.totalPayout)) return null;
	if (typeof s.netDelta !== 'number' || !Number.isInteger(s.netDelta)) return null;
	if (!Array.isArray(s.results)) return null;
	const results = s.results.map(sanitizeBetResult).filter((r): r is BetResult => r !== null);
	if (results.length !== s.results.length) return null;
	if (typeof s.timestamp !== 'number' || !Number.isFinite(s.timestamp)) return null;
	if (typeof s.syncId !== 'string') return null;
	return {
		winningNumber: s.winningNumber,
		bets,
		totalBet: s.totalBet,
		totalPayout: s.totalPayout,
		netDelta: s.netDelta,
		results,
		timestamp: s.timestamp,
		syncId: s.syncId,
		...(typeof s.newBalance === 'number' && Number.isInteger(s.newBalance)
			? { newBalance: s.newBalance }
			: {}),
	};
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
			selectedChipAmount: 1,
			lastSpin: null,
			roundHistory: [],
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

	setSelectedChipAmount(amount: number): void {
		this.state.selectedChipAmount = amount;
	}

	getSelectedChipAmount(): number {
		return this.state.selectedChipAmount;
	}

	getPendingSyncId(): string | undefined {
		return this.state.pendingSyncId;
	}

	setPendingSyncId(syncId: string): void {
		this.state.pendingSyncId = syncId;
	}

	private clearPendingSyncId(): void {
		this.state.pendingSyncId = undefined;
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
		// Only enforce the bet-count cap when this creates a new position.
		// Merging into an existing position doesn't increase the array length.
		const isNewPosition = existingPosition === 0;
		if (isNewPosition && this.state.activeBets.length >= MAX_BETS) {
			return { ok: false, error: `Max ${MAX_BETS} bets per spin` };
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
		if (this.state.phase !== 'betting') {
			return { success: false, error: 'Cannot remove bets outside betting phase' };
		}
		const idx = this.state.activeBets.findIndex((b) => b.id === betId);
		if (idx === -1) return { success: false, error: 'Bet not found' };
		this.state.chipBalance += this.state.activeBets[idx].amount;
		this.state.activeBets.splice(idx, 1);
		return { success: true };
	}

	clearBets(): void {
		if (this.state.phase !== 'betting') return;
		for (const bet of this.state.activeBets) {
			this.state.chipBalance += bet.amount;
		}
		this.state.activeBets = [];
	}

	newRound(): void {
		for (const bet of this.state.activeBets) {
			this.state.chipBalance += bet.amount;
		}
		this.state.activeBets = [];
		this.state.phase = 'betting';
		this.clearPendingSyncId();
	}

	// Clear active bets WITHOUT refunding them into the balance.
	// Use this when the balance has been reset from an authoritative source
	// (e.g. server balance re-fetch after a failed spin). Refunding on top of
	// an authoritative balance would double-count chips that only ever left
	// the client, never the server — see C1 chip-inflation exploit.
	discardActiveBets(): void {
		this.state.activeBets = [];
		this.state.phase = 'betting';
		this.clearPendingSyncId();
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
		if (spinResult.newBalance === undefined) {
			throw new Error('applySettlement requires server-provided newBalance');
		}
		this.state.chipBalance = spinResult.newBalance;
		this.state.phase = 'settled';
		this.state.activeBets = [];
		this.clearPendingSyncId();
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
		this.clearPendingSyncId();

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

		const sanitizedBets = s.activeBets
			.map((b) => sanitizeBet(b))
			.filter((b): b is RouletteBet => b !== null);

		this.state = {
			phase: s.phase,
			activeBets: sanitizedBets,
			chipBalance: s.chipBalance,
			selectedChipAmount:
				typeof s.selectedChipAmount === 'number'
					? s.selectedChipAmount
					: this.state.selectedChipAmount,
			lastSpin: s.lastSpin ? sanitizeSpinResult(s.lastSpin) : null,
			roundHistory: Array.isArray(s.roundHistory)
				? s.roundHistory
						.map((r) => sanitizeSpinResult(r))
						.filter((r): r is SpinResult => r !== null)
				: [],
			// Only restore pendingSyncId during the spinning phase — other
			// phases have already cleared it via applySettlement/newRound/
			// discardActiveBets, and a stale value in the snapshot should
			// not survive into a non-spinning state.
			pendingSyncId:
				s.phase === 'spinning' && typeof s.pendingSyncId === 'string' && s.pendingSyncId.length > 0
					? s.pendingSyncId
					: undefined,
		};
		return true;
	}
}
