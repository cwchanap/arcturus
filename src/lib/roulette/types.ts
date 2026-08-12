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
}

export interface RouletteGameConfig {
	initialBalance: number;
}
