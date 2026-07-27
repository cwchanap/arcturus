import type { APIRoute } from 'astro';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { claimMission } from '../../../lib/missions';

export const POST: APIRoute = async ({ request, locals }) => {
	if (!locals.session) {
		return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	}
	const d1 = locals.runtime?.env?.DB;
	if (!d1) {
		return Response.json({ error: 'DATABASE_UNAVAILABLE' }, { status: 500 });
	}

	let body: { missionDefId?: unknown };
	try {
		body = await request.json();
	} catch {
		return Response.json({ error: 'INVALID_REQUEST_BODY' }, { status: 400 });
	}

	if (typeof body.missionDefId !== 'string' || body.missionDefId.length === 0) {
		return Response.json({ error: 'INVALID_REQUEST_BODY' }, { status: 400 });
	}

	const db = createDb(d1);
	const [userRow] = await db
		.select({ chipBalance: user.chipBalance })
		.from(user)
		.where(eq(user.id, locals.session.user.id))
		.limit(1);

	const chipBalance = userRow?.chipBalance ?? 0;
	const result = await claimMission(d1, locals.session.user.id, body.missionDefId, chipBalance);
	return Response.json(result);
};
