import type { GameType } from '../game-stats/types';

export const SETTLEMENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function newSettlementId(game: GameType): string {
	return `${game}-${crypto.randomUUID()}`;
}
