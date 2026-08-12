import type { GameType } from '../game-stats/types';

export interface RoundStats {
	rounds: number;
	wins: number;
	losses: number;
	biggestWin: number;
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
