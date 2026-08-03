import type { DailyChallengeRepository } from './repository';

export const DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE = 100;
export const DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS = 90;
const SECONDS_PER_DAY = 24 * 60 * 60;

export async function runDailyChallengeExpiration(
	repository: DailyChallengeRepository,
	expire: (attemptId: string) => Promise<unknown>,
	nowSeconds: number,
): Promise<void> {
	let cursor: { expiresAt: number; id: string } | null = null;
	for (;;) {
		const rows = await repository.listExpiredAttempts(nowSeconds, cursor);
		for (const row of rows) {
			cursor = { expiresAt: row.expiresAt, id: row.id };
			try {
				await expire(row.id);
			} catch (error) {
				console.warn('[DAILY_CHALLENGE] expiration failed', error);
			}
		}
		if (rows.length < DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE) return;
	}
}

export async function runDailyChallengeRetention(
	repository: DailyChallengeRepository,
	nowSeconds: number,
): Promise<void> {
	const cutoff = nowSeconds - DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS * SECONDS_PER_DAY;
	await repository.deleteTerminalAttemptsBefore(cutoff);
}
