/**
 * Game Statistics Constants
 */

/**
 * Valid game type identifiers (must match database values and chip update validation)
 * Note: poker is excluded until round-stat payloads are wired for poker rounds
 */
export const GAME_TYPES = ['blackjack', 'baccarat'] as const;

/**
 * Valid ranking metrics for game leaderboards
 */
export const RANKING_METRICS = ['wins', 'win_rate', 'biggest_win', 'net_profit'] as const;

/**
 * Display names for ranking metrics
 */
export const RANKING_METRIC_LABELS: Record<(typeof RANKING_METRICS)[number], string> = {
	wins: 'Total Wins',
	win_rate: 'Win Rate',
	biggest_win: 'Biggest Win',
	net_profit: 'Net Profit',
};

/**
 * Display names for game types (mirrors GAME_TYPES)
 * Note: poker is excluded until round-stat payloads are wired for poker rounds
 */
export const GAME_TYPE_LABELS: Record<(typeof GAME_TYPES)[number], string> = {
	blackjack: 'Blackjack',
	baccarat: 'Baccarat',
};

/**
 * Emoji icons for game types (mirrors GAME_TYPES)
 * Note: poker is excluded until round-stat payloads are wired for poker rounds
 */
export const GAME_TYPE_ICONS: Record<(typeof GAME_TYPES)[number], string> = {
	blackjack: '🃏',
	baccarat: '🎴',
};

/**
 * Default limit for game leaderboards
 */
export const DEFAULT_GAME_LEADERBOARD_LIMIT = 50;

/**
 * Minimum decided games (wins + losses) to appear on win rate leaderboard
 * (prevents 1/1 = 100% win rate from dominating; pushes are excluded)
 */
export const MIN_HANDS_FOR_WIN_RATE = 10;

/**
 * Type guard to check if a string is a valid game type
 */
export function isValidGameType(value: string): value is (typeof GAME_TYPES)[number] {
	return GAME_TYPES.includes(value as (typeof GAME_TYPES)[number]);
}

/**
 * Type guard to check if a string is a valid ranking metric
 */
export function isValidRankingMetric(value: string): value is (typeof RANKING_METRICS)[number] {
	return RANKING_METRICS.includes(value as (typeof RANKING_METRICS)[number]);
}
