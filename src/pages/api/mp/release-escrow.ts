import type { APIRoute } from 'astro';

/**
 * Release escrowed chips back to a player's chipBalance.
 * Called by the DO when a player leaves a room without settling (e.g. disconnect
 * timeout, room eviction, or hand that never started after snapshot).
 *
 * When `roomCode` is provided, only releases escrow for users whose current
 * `mp_membership` row still references that room. This prevents a stale DO
 * (e.g. Room A after eviction) from releasing escrow that Room B is actively
 * using.
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const mpSecret = locals.runtime.env.MP_AUTH_SECRET;
	const auth = request.headers.get('x-arcturus-auth');
	if (!mpSecret || auth !== mpSecret) return new Response('Forbidden', { status: 403 });
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response(JSON.stringify({ error: 'Malformed JSON' }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		});
	}
	if (
		!body ||
		typeof body !== 'object' ||
		!Array.isArray((body as Record<string, unknown>).userIds) ||
		!(body as Record<string, unknown>).userIds.every(
			(id: unknown) => typeof id === 'string' && id.trim().length > 0,
		)
	) {
		return new Response(JSON.stringify({ error: 'Invalid userIds' }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		});
	}
	const userIds = (body as { userIds: string[] }).userIds;
	const roomCode = (body as Record<string, unknown>).roomCode;
	if (roomCode !== undefined && typeof roomCode !== 'string') {
		return new Response(JSON.stringify({ error: 'Invalid roomCode' }), {
			status: 400,
			headers: { 'content-type': 'application/json' },
		});
	}
	if (userIds.length === 0) {
		return new Response(JSON.stringify({ ok: true }), {
			headers: { 'content-type': 'application/json' },
		});
	}
	const d1 = locals.runtime.env.DB;
	const nowSeconds = Math.trunc(Date.now() / 1000);

	if (typeof roomCode === 'string' && roomCode.length > 0) {
		// Scope the release: only release escrow for users whose mp_membership
		// still points at this room. This prevents a stale DO (e.g. Room A
		// after eviction) from releasing escrow that Room B is actively using.
		// We run membership check + escrow release in a single batch to avoid
		// a TOCTOU race between the SELECT and UPDATE.
		const batch = userIds.flatMap((id) => [
			d1
				.prepare(
					`UPDATE user SET chipBalance = chipBalance + heldChips, heldChips = 0, updatedAt = ? ` +
						`WHERE id = ? AND heldChips > 0 ` +
						`AND EXISTS (SELECT 1 FROM mp_membership WHERE userId = ? AND roomCode = ?)`,
				)
				.bind(nowSeconds, id, id, roomCode),
		]);
		await d1.batch(batch);
	} else {
		// No roomCode provided — unconditional release (legacy / internal use).
		const releaseBatch = userIds.map((id) =>
			d1
				.prepare(
					`UPDATE user SET chipBalance = chipBalance + heldChips, heldChips = 0, updatedAt = ? WHERE id = ? AND heldChips > 0`,
				)
				.bind(nowSeconds, id),
		);
		await d1.batch(releaseBatch);
	}

	return new Response(JSON.stringify({ ok: true }), {
		headers: { 'content-type': 'application/json' },
	});
};
