import type { D1Database } from '@cloudflare/workers-types';
import { getDailyPeriodKey } from './periods';

export async function seedStreakFromOldMission(d1: D1Database, userId: string): Promise<void> {
	// Check if streak row already exists — if so, seeding already happened
	const existing = await d1
		.prepare(`SELECT userId FROM login_streak WHERE userId = ?`)
		.bind(userId)
		.first();

	if (existing) return;

	// Check old mission table for today's daily-login claim
	const oldMission = await d1
		.prepare(
			`SELECT completedDate FROM mission WHERE userId = ? AND missionId = 'daily-login'`,
		)
		.bind(userId)
		.first<{ completedDate: number | null }>();

	if (oldMission?.completedDate) {
		const completedDate = new Date(oldMission.completedDate * 1000);
		const completedDay = completedDate.toISOString().slice(0, 10);
		const today = getDailyPeriodKey();

		if (completedDay === today) {
			// Seed streak as if they already claimed today
			await d1
				.prepare(
					`INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey)
					 VALUES (?, 1, 1, ?)
					 ON CONFLICT DO NOTHING`,
				)
				.bind(userId, today)
				.run();
		}
	}
}
