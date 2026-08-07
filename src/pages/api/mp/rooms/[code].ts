import type { APIRoute } from 'astro';
import { isValidRoomCode } from '../../../../lib/mp-poker/roomCode';

export const GET: APIRoute = async ({ params, locals }) => {
	const user = locals.user;
	if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });
	const code = params.code;
	if (!code || !isValidRoomCode(code)) {
		return Response.json({ error: 'INVALID_CODE' }, { status: 400 });
	}
	const namespace = locals.runtime.env.arcturus;
	if (!namespace) return Response.json({ error: 'DO_UNAVAILABLE' }, { status: 503 });
	const id = namespace.idFromName(code);
	const stub = namespace.get(id);
	return stub.fetch('http://do/metadata');
};
