export type BetType =
	| 'straight'
	| 'red'
	| 'black'
	| 'odd'
	| 'even'
	| 'low'
	| 'high'
	| 'dozen'
	| 'column';

export interface RouletteBet {
	id: string;
	type: BetType;
	amount: number;
	target?: number;
}

export interface BetResult {
	bet: RouletteBet;
	won: boolean;
	payout: number;
}

export interface SpinResult {
	winningNumber: number;
	bets: RouletteBet[];
	totalBet: number;
	totalPayout: number;
	netDelta: number;
	results: BetResult[];
	timestamp: number;
	syncId: string;
	newBalance?: number;
}

export type GamePhase = 'betting' | 'spinning' | 'settled';

export interface RouletteGameState {
	phase: GamePhase;
	activeBets: RouletteBet[];
	chipBalance: number;
	selectedChipAmount: number;
	lastSpin: SpinResult | null;
	roundHistory: SpinResult[];
	// Set when phase === 'spinning' and a server spin request is in
	// flight. Persisted so that a page reload during the spin can
	// re-submit the same syncId to leverage the server's idempotency
	// replay, recovering the committed result instead of discarding it.
	pendingSyncId?: string;
	// Epoch ms when pendingSyncId was set. Used to expire stale in-flight
	// snapshots before the server's roulette_round idempotency row is
	// deleted by retention cleanup (see src/server/cleanup.ts). Without
	// this, a snapshot whose round row was cleaned up would be re-submitted
	// as a fresh spin, double-deducting the bet.
	pendingSyncCreatedAt?: number;
}

export interface RouletteGameConfig {
	initialBalance: number;
}
