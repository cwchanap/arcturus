import type { APIRoute } from 'astro';
import { isValidRoomCode } from '../../../../lib/mp-poker/roomCode';

export const GET: APIRoute = async ({ params, locals }) => {
	const code = params.code;
	if (!code || !isValidRoomCode(code)) {
		return new Response(JSON.stringify({ error: 'INVALID_CODE' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const env = locals.runtime.env;
	const id = env.arcturus.idFromName(code);
	const stub = env.arcturus.get(id);
	return stub.fetch('http://do/metadata');
};
