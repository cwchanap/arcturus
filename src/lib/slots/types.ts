export type SymbolId = 'seven' | 'bell' | 'bar' | 'melon' | 'grapes' | 'lemon' | 'cherry';

export interface SymbolDef {
	id: SymbolId;
	label: string;
	glyph: string;
	weight: number;
}

/** Grid indexed as [reel][row]; 5 reels × 3 rows. */
export type ReelGrid = SymbolId[][];

export interface LineWin {
	paylineIndex: number;
	symbol: SymbolId;
	count: 3 | 4 | 5;
	multiplier: number;
	payout: number;
}

export interface SpinEvaluation {
	grid: ReelGrid;
	lineWins: LineWin[];
	totalPayout: number;
}

export interface SpinResult {
	bet: number;
	grid: ReelGrid;
	payout: number;
	netDelta: number;
	timestamp: number;
	syncId: string;
	lineWins: LineWin[];
}

export type SpinSpeed = 'slow' | 'normal' | 'fast';

export interface SlotSettings {
	spinSpeed: SpinSpeed;
	soundEnabled: boolean;
	quickSpin: boolean;
}

export interface SlotsGameState {
	balance: number;
	bet: number;
	grid: ReelGrid;
	lastEvaluation: SpinEvaluation | null;
	history: SpinResult[];
	settings: SlotSettings;
}

export type SlotsErrorCode =
	| 'BET_BELOW_MIN'
	| 'BET_ABOVE_MAX'
	| 'INSUFFICIENT_BALANCE'
	| 'INVALID_BET'
	| 'SPIN_IN_PROGRESS';

export interface SlotsError {
	code: SlotsErrorCode;
	message: string;
}

export interface SlotsGameEvents {
	onSpinStart: (bet: number) => void;
	onReelsReady: (grid: ReelGrid) => void;
	onRoundComplete: (result: SpinResult) => void | Promise<void>;
	onBalanceUpdate: (balance: number) => void;
	onError: (error: SlotsError) => void;
}
