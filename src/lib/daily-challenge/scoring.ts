export interface DailyChallengeScore {
	readonly endingBankroll: number;
	readonly roundsCompleted: number;
}

export function compareDailyChallengeScores(
	left: DailyChallengeScore,
	right: DailyChallengeScore,
): number {
	if (left.endingBankroll !== right.endingBankroll) {
		return right.endingBankroll - left.endingBankroll;
	}
	return right.roundsCompleted - left.roundsCompleted;
}

export function calculateDailyChallengePercentile(
	totalEligible: number,
	playersStrictlyAbove: number,
): number {
	if (!Number.isSafeInteger(totalEligible) || totalEligible < 1) {
		throw new RangeError('An eligible result requires at least one eligible player');
	}
	if (
		!Number.isSafeInteger(playersStrictlyAbove) ||
		playersStrictlyAbove < 0 ||
		playersStrictlyAbove >= totalEligible
	) {
		throw new RangeError('Players strictly above is outside the eligible population');
	}
	const playersAtOrBelow = totalEligible - playersStrictlyAbove;
	return Math.min(100, Math.max(1, Math.round((100 * playersAtOrBelow) / totalEligible)));
}
