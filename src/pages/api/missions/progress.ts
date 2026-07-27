import type { APIRoute } from 'astro';
import type { D1PreparedStatement } from '@cloudflare/workers-types';
import { getDailyPeriodKeyForYesterday } from '../../../lib/missions';

export const DELETE: APIRoute = async ({ request, locals }) => {
	if (!import.meta.env.DEV) {
		return Response.json({ error: 'NOT_FOUND' }, { status: 404 });
	}
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	let body: {
		resetProgress?: boolean;
		resetStreak?: boolean;
		seedStreak?: { lastClaimPeriodKey: string; currentStreak: number };
	} = {};

	try {
		body = await request.json();
	} catch {
		// empty body is fine — defaults apply
	}

	const userId = locals.session.user.id;
	const statements: D1PreparedStatement[] = [];

	if (body.resetProgress !== false) {
		statements.push(
			d1.prepare(`DELETE FROM mission_progress WHERE userId = ?`).bind(userId),
			d1.prepare(`DELETE FROM mission_override WHERE userId = ?`).bind(userId),
		);
	}

	if (body.seedStreak) {
		const periodKey =
			body.seedStreak.lastClaimPeriodKey === 'yesterday'
				? getDailyPeriodKeyForYesterday()
				: body.seedStreak.lastClaimPeriodKey;
		statements.push(
			d1
				.prepare(
					`INSERT INTO login_streak (userId, currentStreak, longestStreak, lastClaimPeriodKey)
					 VALUES (?, ?, ?, ?)
					 ON CONFLICT(userId) DO UPDATE SET
					   currentStreak = excluded.currentStreak,
					   longestStreak = excluded.longestStreak,
					   lastClaimPeriodKey = excluded.lastClaimPeriodKey`,
				)
				.bind(userId, body.seedStreak.currentStreak, body.seedStreak.currentStreak, periodKey),
		);
	} else if (body.resetStreak !== false) {
		statements.push(d1.prepare(`DELETE FROM login_streak WHERE userId = ?`).bind(userId));
	}

	if (statements.length > 0) {
		await d1.batch(statements);
	}

	return Response.json({ status: 'reset' });
};
