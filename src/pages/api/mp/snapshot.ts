import type { APIRoute } from 'astro';
import { inArray } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';

export const POST: APIRoute = async ({ request, locals }) => {
	const mpSecret = locals.runtime.env.MP_AUTH_SECRET;
	const auth = request.headers.get('x-arcturus-auth');
	// Reject if no shared secret is configured or header doesn't match
	if (!mpSecret || auth !== mpSecret) return new Response('Forbidden', { status: 403 });
	const body = (await request.json()) as { userIds: string[]; roomCode: string };
	if (!Array.isArray(body.userIds) || body.userIds.length === 0) {
		return new Response(JSON.stringify({ balances: {} }), {
			headers: { 'content-type': 'application/json' },
		});
	}
	const db = createDb(locals.runtime.env.DB);
	const rows = await db
		.select({ id: user.id, chipBalance: user.chipBalance })
		.from(user)
		.where(inArray(user.id, body.userIds))
		.all();
	const balances: Record<string, number> = {};
	for (const r of rows) balances[r.id] = r.chipBalance;
	return new Response(JSON.stringify({ balances }), {
		headers: { 'content-type': 'application/json' },
	});
};
