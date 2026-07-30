import type { Database } from './db';
import { getPlayerStatisticsSummary } from './game-stats/player-statistics';
import type { PlayerStatisticsSummary } from './game-stats/player-statistics-types';

export type ProfileStatisticsState =
	| { status: 'ready'; summary: PlayerStatisticsSummary }
	| { status: 'error' };

export async function loadProfileStatisticsState(
	db: Database,
	userId: string,
	load: typeof getPlayerStatisticsSummary = getPlayerStatisticsSummary,
): Promise<ProfileStatisticsState> {
	try {
		return { status: 'ready', summary: await load(db, userId) };
	} catch (error) {
		console.error('[PLAYER_STATISTICS] Failed to load profile summary', error);
		return { status: 'error' };
	}
}
