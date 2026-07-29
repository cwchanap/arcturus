import type { APIRoute } from 'astro';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { claimLogin, seedStreakFromOldMission } from '../../../lib/missions';

export const POST: APIRoute = async ({ locals }) => {
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	// Lazy deploy-day streak seed: if the user already claimed the legacy
	// `daily-login` mission today (pre-migration system that awarded 1,000
	// chips) but has no `login_streak` row yet, seed one so claimLogin()'s
	// `lastClaimPeriodKey === today` fast-path fires and we don't pay the new
	// 1,000-chip day-one reward on top of the legacy one.
	//
	// This is a self-healing one-shot migration: the first statement is a PK
	// lookup on `login_streak` that returns immediately once any streak row
	// exists for the user, so the per-request cost collapses to one indexed
	// SELECT after the user's first claim. It is kept here (not run as a
	// separate bulk backfill) so users who never call claim-login again are
	// not double-paid when they eventually do.
	try {
		await seedStreakFromOldMission(d1, locals.session.user.id);

		const db = createDb(d1);
		const [userRow] = await db
			.select({ chipBalance: user.chipBalance })
			.from(user)
			.where(eq(user.id, locals.session.user.id))
			.limit(1);

		const chipBalance = userRow?.chipBalance ?? 0;
		const result = await claimLogin(d1, locals.session.user.id, chipBalance);
		return Response.json(result);
	} catch (error) {
		console.error('[MISSIONS_CLAIM_LOGIN] Failed to claim login:', error);
		return Response.json({ error: 'INTERNAL_ERROR' }, { status: 500 });
	}
};
