import type { APIRoute } from 'astro';
import { isValidRoomCode } from '../../../../../lib/mp-poker/roomCode';

export const GET: APIRoute = async ({ params, request, locals }) => {
	const code = params.code;
	if (!code || !isValidRoomCode(code)) return new Response('Bad code', { status: 400 });
	const user = locals.user;
	if (!user) return new Response('Unauthorized', { status: 401 });
	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('Expected websocket', { status: 426 });
	}
	const env = locals.runtime.env;
	const id = env.arcturus.idFromName(code);
	const stub = env.arcturus.get(id);
	const headers = new Headers(request.headers);
	headers.set('x-arcturus-user-id', user.id);
	headers.set('x-arcturus-display-name', user.name);
	return stub.fetch('http://do/ws', { headers });
};
