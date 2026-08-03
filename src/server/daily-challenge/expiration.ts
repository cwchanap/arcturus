import type { DailyChallengeRepository } from './repository';

export const DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE = 100;
export const DAILY_CHALLENGE_EXPIRATION_MAX_PAGES = 50;
export const DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS = 90;
const SECONDS_PER_DAY = 24 * 60 * 60;

export async function runDailyChallengeExpiration(
	repository: DailyChallengeRepository,
	expire: (attemptId: string) => Promise<unknown>,
	nowSeconds: number,
): Promise<void> {
	let cursor: { expiresAt: number; id: string } | null = null;
	for (let page = 0; page < DAILY_CHALLENGE_EXPIRATION_MAX_PAGES; page += 1) {
		const rows = await repository.listExpiredAttempts(nowSeconds, cursor);
		for (const row of rows) {
			cursor = { expiresAt: row.expiresAt, id: row.id };
			try {
				await expire(row.id);
			} catch (error) {
				console.warn('[DAILY_CHALLENGE] expiration failed for attempt', redactId(row.id), error);
			}
		}
		if (rows.length < DAILY_CHALLENGE_EXPIRATION_PAGE_SIZE) return;
	}
	console.warn('[DAILY_CHALLENGE] expiration hit page budget without draining the backlog');
}

function redactId(id: string): string {
	return id.length > 8 ? `${id.slice(0, 4)}…${id.slice(-4)}` : id;
}

export async function runDailyChallengeRetention(
	repository: DailyChallengeRepository,
	nowSeconds: number,
): Promise<void> {
	const cutoff = nowSeconds - DAILY_CHALLENGE_ATTEMPT_RETENTION_DAYS * SECONDS_PER_DAY;
	await repository.deleteTerminalAttemptsBefore(cutoff);
}
