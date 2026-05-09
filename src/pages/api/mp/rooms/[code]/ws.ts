import type { APIRoute } from 'astro';
import { createDb } from '../../../../../lib/db';
import { mpMembership } from '../../../../../db/schema';
import { eq } from 'drizzle-orm';
import { isValidRoomCode } from '../../../../../lib/mp-poker/roomCode';

export const GET: APIRoute = async ({ params, request, locals }) => {
	const code = params.code;
	if (!code || !isValidRoomCode(code)) return new Response('Bad code', { status: 400 });
	const user = locals.user;
	if (!user) return new Response('Unauthorized', { status: 401 });
	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('Expected websocket', { status: 426 });
	}

	// Enforce single-room lock: user must not be in another room
	const db = createDb(locals.runtime.env.DB);
	const existing = await db
		.select()
		.from(mpMembership)
		.where(eq(mpMembership.userId, user.id))
		.get();
	if (existing && existing.roomCode !== code) {
		return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const env = locals.runtime.env;
	const id = env.arcturus.idFromName(code);
	const stub = env.arcturus.get(id);
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		if (!key.toLowerCase().startsWith('x-arcturus-')) {
			headers.set(key, value);
		}
	}
	headers.set('x-arcturus-user-id', user.id);
	headers.set('x-arcturus-display-name', encodeURIComponent(user.name));
	const doRes = await stub.fetch('http://do/ws', { headers });

	// Only acquire the membership lock after the DO confirms the room exists
	// and accepts the WebSocket upgrade. This prevents stale/uninitialized rooms
	// from leaving a permanent membership row that blocks future joins.
	if (doRes.status === 101 && !existing) {
		await db
			.insert(mpMembership)
			.values({ userId: user.id, roomCode: code, joinedAt: new Date() })
			.run();
	}

	return doRes;
};
