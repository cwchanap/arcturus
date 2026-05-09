import type { APIRoute } from 'astro';
import { generateRoomCode } from '../../../../lib/mp-poker/roomCode';

export const POST: APIRoute = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
	const body = (await request.json()) as {
		maxSeats: number;
		smallBlind: number;
		bigBlind: number;
	};
	if (
		body.maxSeats < 2 ||
		body.maxSeats > 6 ||
		body.smallBlind < 1 ||
		body.bigBlind < body.smallBlind * 2
	) {
		return new Response(JSON.stringify({ error: 'INVALID_CONFIG' }), { status: 400 });
	}
	const env = locals.runtime.env;
	if (!env.arcturus) {
		return new Response(JSON.stringify({ error: 'DO_UNAVAILABLE' }), { status: 503 });
	}

	for (let attempt = 0; attempt < 5; attempt++) {
		const code = generateRoomCode();
		const id = env.arcturus.idFromName(code);
		const stub = env.arcturus.get(id);
		const res = await stub.fetch('http://do/init', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				maxSeats: body.maxSeats,
				smallBlind: body.smallBlind,
				bigBlind: body.bigBlind,
				hostUserId: user.id,
				roomCode: code,
			}),
		});
		if (res.ok) return new Response(JSON.stringify({ code }), { status: 201 });
		if (res.status !== 409) {
			const err = await res.text();
			return new Response(err, { status: 502 });
		}
	}
	return new Response(JSON.stringify({ error: 'CODE_GENERATION_FAILED' }), { status: 500 });
};
