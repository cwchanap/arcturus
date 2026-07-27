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

	// One-time deploy-day seeding (idempotent — checks if streak row exists)
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
};
