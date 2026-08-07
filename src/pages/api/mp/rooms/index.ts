import type { APIRoute } from 'astro';
import { generateRoomCode } from '../../../../lib/mp-poker/roomCode';

interface CreateRoomBody {
	maxSeats: number;
	smallBlind: number;
	bigBlind: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isValidRoomConfig(value: unknown): value is CreateRoomBody {
	if (!isRecord(value)) return false;

	const { maxSeats, smallBlind, bigBlind } = value;
	if (maxSeats !== 2 && maxSeats !== 4 && maxSeats !== 6) return false;
	if (typeof smallBlind !== 'number' || !Number.isSafeInteger(smallBlind) || smallBlind <= 0) {
		return false;
	}
	if (typeof bigBlind !== 'number' || !Number.isSafeInteger(bigBlind) || bigBlind <= 0) {
		return false;
	}
	if (smallBlind > Math.floor(Number.MAX_SAFE_INTEGER / 2)) return false;
	if (bigBlind < smallBlind * 2) return false;
	if (!Number.isSafeInteger(bigBlind * 100)) return false;

	return true;
}

export const POST: APIRoute = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return Response.json({ error: 'UNAUTHORIZED' }, { status: 401 });

	let rawBody: unknown;
	try {
		rawBody = await request.json();
	} catch {
		return Response.json({ error: 'INVALID_JSON' }, { status: 400 });
	}

	if (!isValidRoomConfig(rawBody)) {
		return Response.json({ error: 'INVALID_CONFIG' }, { status: 400 });
	}

	const namespace = locals.runtime.env.arcturus;
	if (!namespace) return Response.json({ error: 'DO_UNAVAILABLE' }, { status: 503 });

	for (let attempt = 0; attempt < 5; attempt++) {
		const roomCode = generateRoomCode();
		const id = namespace.idFromName(roomCode);
		const stub = namespace.get(id);
		let response: Response;
		try {
			response = await stub.fetch('http://do/init', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ ...rawBody, roomCode }),
			});
		} catch {
			return Response.json({ error: 'DO_UNAVAILABLE' }, { status: 502 });
		}

		if (response.ok) return Response.json({ code: roomCode }, { status: 201 });
		if (response.status === 409) continue;

		const errorBody = await response.text();
		return new Response(errorBody, {
			status: 502,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	return Response.json({ error: 'CODE_GENERATION_FAILED' }, { status: 500 });
};
