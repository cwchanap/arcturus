import type { APIRoute } from 'astro';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { claimLogin } from '../../../lib/missions';

export const POST: APIRoute = async ({ locals }) => {
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	// Note: deploy-day streak seeding (seedStreakFromOldMission) was previously
	// invoked here on every request. It is a one-shot migration that has now
	// run its course; keeping it per-request added a SELECT to every claim-login
	// call forever. The function remains in src/lib/missions/seed.ts for
	// reference and is still covered by its unit/integration tests.

	try {
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
