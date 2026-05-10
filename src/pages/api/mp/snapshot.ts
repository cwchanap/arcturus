import type { APIRoute } from 'astro';

export const POST: APIRoute = async ({ request, locals }) => {
	const mpSecret = locals.runtime.env.MP_AUTH_SECRET;
	const auth = request.headers.get('x-arcturus-auth');
	// Reject if no shared secret is configured or header doesn't match
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
	if (userIds.length === 0) {
		return new Response(JSON.stringify({ balances: {} }), {
			headers: { 'content-type': 'application/json' },
		});
	}
	const d1 = locals.runtime.env.DB;
	const nowSeconds = Math.trunc(Date.now() / 1000);

	// Escrow each player's full bankroll: move chipBalance + any existing
	// heldChips → heldChips, then zero chipBalance.  This is idempotent (a
	// second call with chipBalance=0 is a no-op) AND self-healing: if a
	// previous room crashed leaving stale heldChips > 0, those stranded chips
	// are recovered into the new buy-in rather than silently reused while
	// chipBalance remains unescrowed.
	const escrowBatch = userIds.map((id) =>
		d1
			.prepare(
				`UPDATE user SET heldChips = chipBalance + heldChips, chipBalance = 0, updatedAt = ? WHERE id = ?`,
			)
			.bind(nowSeconds, id),
	);
	await d1.batch(escrowBatch);

	// Fetch the escrowed amounts (heldChips) to return as balances for the DO.
	const placeholders = userIds.map(() => '?').join(',');
	const rows = await d1
		.prepare(`SELECT id, heldChips FROM user WHERE id IN (${placeholders})`)
		.bind(...userIds)
		.all();
	const balances: Record<string, number> = {};
	for (const r of rows.results as { id: string; heldChips: number }[]) {
		balances[r.id] = r.heldChips;
	}
	return new Response(JSON.stringify({ balances }), {
		headers: { 'content-type': 'application/json' },
	});
};
