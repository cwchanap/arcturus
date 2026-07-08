import { DEFAULT_SETTINGS, MAX_BET, MAX_HISTORY, MIN_BET, NUM_REELS, NUM_ROWS } from './constants';
import { ReelManager } from './ReelManager';
import { evaluateGrid } from './payoutCalculator';
import type { ReelGrid, SlotSettings, SlotsGameEvents, SlotsGameState, SpinResult } from './types';

export class SlotsGame {
	private state: SlotsGameState;
	private readonly events: Partial<SlotsGameEvents>;
	private readonly reels: ReelManager;

	constructor(
		initialBalance: number,
		settings: Partial<SlotSettings> = {},
		events: Partial<SlotsGameEvents> = {},
		reels: ReelManager = new ReelManager(),
	) {
		this.reels = reels;
		this.events = events;
		this.state = {
			balance: Math.max(0, Math.floor(initialBalance)),
			bet: MIN_BET,
			grid: this.emptyGrid(),
			lastEvaluation: null,
			history: [],
			settings: { ...DEFAULT_SETTINGS, ...settings },
		};
	}

	getState(): SlotsGameState {
		return {
			...this.state,
			grid: this.state.grid.map((col) => [...col]),
			history: this.state.history.map((h) => ({ ...h, grid: h.grid.map((c) => [...c]) })),
		};
	}

	getBalance(): number {
		return this.state.balance;
	}

	setBalance(balance: number): void {
		this.state.balance = Math.max(0, Math.floor(balance));
		this.emitBalance();
	}

	getBet(): number {
		return this.state.bet;
	}

	setBet(bet: number): void {
		if (!Number.isFinite(bet)) this.fail('INVALID_BET', 'Bet must be a finite number');
		if (bet < MIN_BET) this.fail('BET_BELOW_MIN', `Minimum bet is ${MIN_BET}`);
		if (bet > MAX_BET) this.fail('BET_ABOVE_MAX', `Maximum bet is ${MAX_BET}`);
		this.state.bet = Math.floor(bet);
	}

	canSpin(): boolean {
		return this.state.balance >= this.state.bet && this.state.bet >= MIN_BET;
	}

	getHistory(): SpinResult[] {
		return this.state.history.map((h) => ({ ...h, grid: h.grid.map((c) => [...c]) }));
	}

	updateSettings(updates: Partial<SlotSettings>): void {
		this.state.settings = { ...this.state.settings, ...updates };
	}

	getSettings(): SlotSettings {
		return { ...this.state.settings };
	}

	spin(syncId: string): SpinResult {
		if (!syncId || typeof syncId !== 'string') {
			this.fail('INVALID_BET', 'syncId is required');
		}

		const cached = this.state.history.find((h) => h.syncId === syncId);
		if (cached) {
			return { ...cached, grid: cached.grid.map((c) => [...c]) };
		}

		const bet = this.state.bet;
		if (bet < MIN_BET) this.fail('BET_BELOW_MIN', `Minimum bet is ${MIN_BET}`);
		if (bet > MAX_BET) this.fail('BET_ABOVE_MAX', `Maximum bet is ${MAX_BET}`);
		if (bet > this.state.balance) {
			this.fail('INSUFFICIENT_BALANCE', 'Not enough chips to spin');
		}

		this.state.balance -= bet;
		this.emitBalance();
		this.events.onSpinStart?.(bet);

		const grid = this.reels.spin();
		const evaluation = evaluateGrid(grid, bet);
		this.state.grid = grid;
		this.state.lastEvaluation = evaluation;
		this.state.balance += evaluation.totalPayout;

		const result: SpinResult = {
			bet,
			grid,
			payout: evaluation.totalPayout,
			netDelta: evaluation.totalPayout - bet,
			timestamp: Date.now(),
			syncId,
			lineWins: evaluation.lineWins,
		};

		this.state.history.unshift(result);
		if (this.state.history.length > MAX_HISTORY) {
			this.state.history.length = MAX_HISTORY;
		}
		this.events.onRoundComplete?.(result);
		this.emitBalance();
		return { ...result, grid: result.grid.map((c) => [...c]) };
	}

	private emitBalance(): void {
		this.events.onBalanceUpdate?.(this.state.balance);
	}

	private emptyGrid(): ReelGrid {
		return Array.from({ length: NUM_REELS }, () =>
			Array.from({ length: NUM_ROWS }, () => 'cherry' as const),
		);
	}

	private buildError(code: import('./types').SlotsErrorCode, message: string): Error {
		const e = new Error(`[${code}] ${message}`);
		(e as Error & { code: string }).code = code;
		return e;
	}

	// Notifies the UI (onError) then throws. Kept separate from buildError so
	// the side effect is explicit at the throw site rather than hidden inside
	// an Error-builder that callers might invoke without intending to notify.
	private fail(code: import('./types').SlotsErrorCode, message: string): never {
		this.events.onError?.({ code, message });
		throw this.buildError(code, message);
	}
}
