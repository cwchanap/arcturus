import type { APIRoute } from 'astro';
import { isValidRoomCode } from '../../../../../lib/mp-poker/roomCode';

export const GET: APIRoute = async ({ params, request, locals, url }) => {
	const code = params.code;
	if (!code || !isValidRoomCode(code)) return new Response('Bad code', { status: 400 });

	const user = locals.user;
	if (!user) return new Response('Unauthorized', { status: 401 });

	// Reject cross-origin WebSocket upgrades to prevent CSRF-style attacks.
	const origin = request.headers.get('Origin');
	if (origin) {
		try {
			const originHost = new URL(origin).host;
			const requestHost = url.host || request.headers.get('Host');
			if (requestHost && originHost !== requestHost) {
				return new Response('Forbidden', { status: 403 });
			}
		} catch {
			return new Response('Forbidden', { status: 403 });
		}
	}

	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('Expected websocket', { status: 426 });
	}

	const namespace = locals.runtime.env.MULTIPLAYER_POKER_ROOMS;
	if (!namespace) return Response.json({ error: 'DO_UNAVAILABLE' }, { status: 503 });

	const id = namespace.idFromName(code);
	const stub = namespace.get(id);
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		if (!key.toLowerCase().startsWith('x-arcturus-')) headers.set(key, value);
	}
	headers.set('x-arcturus-user-id', user.id);
	headers.set('x-arcturus-display-name', encodeURIComponent(user.name || 'Player'));

	try {
		return await stub.fetch('http://do/ws', { headers });
	} catch {
		return Response.json({ error: 'DO_ERROR' }, { status: 502 });
	}
};
