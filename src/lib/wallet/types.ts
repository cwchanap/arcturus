import type { GameType } from '../game-stats/types';

export interface RoundStats {
	rounds: number;
	wins: number;
	losses: number;
	biggestWin: number;
	/**
	 * True game net profit for the settled round(s). When omitted, callers
	 * keep the legacy semantics and `delta` is used as net profit instead
	 * (e.g. non-ranked games where the wallet delta is the full net result).
	 * Ranked runs debit stakes during the run, so they credit the gross
	 * payout via `delta` and record the true net result here.
	 */
	netProfit?: number;
}

export interface SettleRoundCommand {
	settlementId: string;
	game: GameType;
	delta: number;
	stats: RoundStats;
}

export interface SettleRoundResult {
	balance: number;
	duplicate: boolean;
	newAchievements?: Array<{ id: string; name: string; icon: string }>;
}

export interface WalletSettlementGate {
	settlementId: string;
	attemptId: string;
}
