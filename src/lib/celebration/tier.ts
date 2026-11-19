/**
 * The one threshold source for big-win tiers: net win versus round stake
 * (ordinary games) or versus the hand's big blind (Poker). Thresholds are
 * inclusive — a win at exactly the multiple qualifies.
 */
export const WIN_TIER_MULTIPLES = {
	stake: { big: 5, huge: 20 },
	bigBlind: { big: 20, huge: 50 },
} as const;

export type WinTier = 'big' | 'huge';

/**
 * Classify a net win against its measure unit (stake or big blind) using the
 * given threshold multiples. Huge is checked first. Losses, pushes, and any
 * nonfinite/zero/negative input win or unit yield no tier.
 */
export function winTier(
	measure: number,
	unit: number,
	multiples: { big: number; huge: number } = WIN_TIER_MULTIPLES.stake,
): WinTier | null {
	if (!Number.isFinite(measure) || !Number.isFinite(unit) || measure <= 0 || unit <= 0) {
		return null;
	}
	if (measure >= unit * multiples.huge) return 'huge';
	if (measure >= unit * multiples.big) return 'big';
	return null;
}
