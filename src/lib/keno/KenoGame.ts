// src/lib/keno/KenoGame.ts
import {
	DEFAULT_SETTINGS,
	MAX_BET,
	MAX_HISTORY,
	MAX_SPOTS,
	MIN_BET,
	PAYTABLE_VERSION,
} from './constants';
import { DrawManager } from './DrawManager';
import { evaluateDraw } from './payoutCalculator';
import { quickPick, validatePicks } from './selection';
import type {
	DrawResult,
	KenoErrorCode,
	KenoGameEvents,
	KenoGameState,
	KenoOutcome,
	KenoSettings,
} from './types';

const OUTCOME_WIN: KenoOutcome = 'win';
const OUTCOME_LOSS: KenoOutcome = 'loss';
const OUTCOME_PUSH: KenoOutcome = 'push';

export class KenoGame {
	private state: KenoGameState;
	private readonly events: Partial<KenoGameEvents>;
	private readonly drawManager: DrawManager;

	constructor(
		initialBalance: number,
		settings: Partial<KenoSettings> = {},
		events: Partial<KenoGameEvents> = {},
		drawManager: DrawManager = new DrawManager(),
	) {
		this.drawManager = drawManager;
		this.events = events;
		this.state = {
			balance: Math.max(0, Math.floor(initialBalance)),
			bet: MIN_BET,
			picks: [],
			lastDraw: null,
			history: [],
			settings: { ...DEFAULT_SETTINGS, ...settings },
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
	// Programmatic setter — throws buildError (NO toast). Caller must clamp.
	setBet(bet: number): void {
		if (!Number.isFinite(bet)) throw this.buildError('INVALID_BET', 'Bet must be a finite number');
		if (bet < MIN_BET) throw this.buildError('BET_BELOW_MIN', `Minimum bet is ${MIN_BET}`);
		if (bet > MAX_BET) throw this.buildError('BET_ABOVE_MAX', `Maximum bet is ${MAX_BET}`);
		this.state.bet = Math.floor(bet);
	}
	getPicks(): number[] {
		return [...this.state.picks];
	}
	// Per-pick invariants only; accepts a 0–10 draft (count enforced at draw).
	togglePick(n: number): void {
		const v = validatePicks([n]);
		if (!v.ok) throw this.buildError(v.code, `Invalid pick: ${n}`);
		const set = new Set(this.state.picks);
		if (set.has(n)) throw this.buildError('INVALID_SELECTION', `Pick already selected: ${n}`);
		this.state.picks = [...this.state.picks, n].sort((a, b) => a - b);
		this.events.onSelectionChange?.(this.getPicks());
	}
	clearSelection(): void {
		this.state.picks = [];
		this.events.onSelectionChange?.(this.getPicks());
	}
	quickPick(count: number): void {
		this.state.picks = quickPick(count);
		this.events.onSelectionChange?.(this.getPicks());
	}
	getHistory(): DrawResult[] {
		return this.state.history.map((h) => ({
			...h,
			picks: [...h.picks],
			drawn: [...h.drawn],
			hits: [...h.hits],
		}));
	}
	canDraw(): boolean {
		return (
			this.state.picks.length >= 1 &&
			this.state.picks.length <= MAX_SPOTS &&
			this.state.balance >= this.state.bet &&
			this.state.bet >= MIN_BET
		);
	}
	getSettings(): KenoSettings {
		return { ...this.state.settings };
	}

	// draw() throws via fail (toast + throw). drawnOverride is for tests/deterministic draws.
	draw(syncId: string, drawnOverride?: number[]): DrawResult {
		if (!syncId || typeof syncId !== 'string') this.fail('INVALID_SYNC_ID', 'syncId is required');

		const cached = this.state.history.find((h) => h.syncId === syncId);
		if (cached) {
			return {
				...cached,
				picks: [...cached.picks],
				drawn: [...cached.drawn],
				hits: [...cached.hits],
			};
		}

		const picks = this.state.picks;
		if (picks.length < 1 || picks.length > MAX_SPOTS) {
			this.fail('INVALID_DRAW_SELECTION', `Select between 1 and ${MAX_SPOTS} numbers`);
		}
		const bet = this.state.bet;
		if (bet > this.state.balance) this.fail('INSUFFICIENT_BALANCE', 'Not enough chips to draw');

		this.state.balance -= bet;
		this.emitBalance();

		const drawn = drawnOverride ?? this.drawManager.draw();
		const evald = evaluateDraw(picks, drawn, bet);
		const payout = evald.payout;
		const netDelta = payout - bet;
		const outcome: KenoOutcome =
			netDelta > 0 ? OUTCOME_WIN : netDelta < 0 ? OUTCOME_LOSS : OUTCOME_PUSH;

		this.state.balance += payout;

		const result: DrawResult = {
			syncId,
			picks: [...picks],
			drawn: [...drawn],
			hits: [...evald.hits],
			hitCount: evald.hitCount,
			spots: picks.length,
			bet,
			multiplier: evald.multiplier,
			payout,
			netDelta,
			outcome,
			paytableVersion: PAYTABLE_VERSION,
			timestamp: Date.now(),
		};

		this.state.lastDraw = result;
		this.state.history.unshift(result);
		if (this.state.history.length > MAX_HISTORY) this.state.history.length = MAX_HISTORY;
		this.events.onRoundComplete?.({
			...result,
			picks: [...result.picks],
			drawn: [...result.drawn],
			hits: [...result.hits],
		});
		this.emitBalance();
		return {
			...result,
			picks: [...result.picks],
			drawn: [...result.drawn],
			hits: [...result.hits],
		};
	}

	private emitBalance(): void {
		this.events.onBalanceUpdate?.(this.state.balance);
	}
	private buildError(code: KenoErrorCode, message: string): Error {
		const e = new Error(`[${code}] ${message}`);
		(e as Error & { code: KenoErrorCode }).code = code;
		return e;
	}
	// Emits onError (toast) THEN throws. Distinct from buildError so the side effect is explicit.
	private fail(code: KenoErrorCode, message: string): never {
		this.events.onError?.({ code, message });
		throw this.buildError(code, message);
	}
}
