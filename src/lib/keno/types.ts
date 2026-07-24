// src/lib/keno/types.ts

export type KenoErrorCode =
	| 'BET_BELOW_MIN'
	| 'BET_ABOVE_MAX'
	| 'INVALID_BET'
	| 'INVALID_SELECTION'
	| 'INVALID_DRAW_SELECTION'
	| 'INSUFFICIENT_BALANCE'
	| 'INVALID_SYNC_ID';

export type KenoOutcome = 'win' | 'loss' | 'push';

export interface KenoTicket {
	picks: number[]; // sorted ascending, length 0–10 as a DRAFT; 1–10 at draw time
	bet: number;
}

export interface DrawEvaluation {
	hits: number[]; // subset of picks present in drawn
	hitCount: number;
	multiplier: number; // 0 if no paying tier
	payout: number; // multiplier × bet
}

export interface DrawResult {
	syncId: string;
	picks: number[];
	drawn: number[]; // 20 sorted, the authoritative draw
	hits: number[];
	hitCount: number;
	spots: number; // picks.length (1–10)
	bet: number;
	multiplier: number;
	payout: number;
	netDelta: number; // payout - bet
	outcome: KenoOutcome; // from netDelta
	paytableVersion: string;
	timestamp: number;
}

export type AnimationSpeed = 'slow' | 'normal' | 'fast';

export interface KenoSettings {
	animationSpeed: AnimationSpeed;
	soundEnabled: boolean;
}

export interface KenoGameState {
	balance: number;
	bet: number;
	picks: number[];
	history: DrawResult[];
	settings: KenoSettings;
}

export interface KenoError {
	code: KenoErrorCode;
	message: string;
}

export interface KenoGameEvents {
	onRoundComplete: (result: DrawResult) => void;
	onBalanceUpdate: (balance: number) => void;
	onSelectionChange: (picks: number[]) => void;
	onError: (error: KenoError) => void;
}
