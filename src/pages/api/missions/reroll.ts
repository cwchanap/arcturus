import type { APIRoute } from 'astro';
import { performReroll } from '../../../lib/missions';

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

	const result = await performReroll(d1, locals.session.user.id, body.missionDefId);

	if (result.status === 'reroll-used') {
		return Response.json({ error: 'REROLL_USED' }, { status: 409 });
	}
	if (result.status === 'already-completed') {
		return Response.json({ error: 'ALREADY_COMPLETED' }, { status: 409 });
	}
	if (result.status === 'no-replacement') {
		return Response.json({ error: 'NO_REPLACEMENT_AVAILABLE' }, { status: 409 });
	}
	if (result.status === 'not-daily') {
		return Response.json({ error: 'NOT_DAILY' }, { status: 400 });
	}

	return Response.json(result);
};
