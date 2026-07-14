import type { APIRoute } from 'astro';
import { createDb } from '../../../lib/db';
import { user } from '../../../db/schema';
import { eq } from 'drizzle-orm';

export const GET: APIRoute = async ({ locals }) => {
	if (!locals.user) {
		return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), {
			status: 401,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const dbBinding = locals.runtime?.env?.DB;
	if (!dbBinding) {
		return new Response(JSON.stringify({ error: 'DATABASE_UNAVAILABLE' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	const db = createDb(dbBinding);
	const [userRow] = await db
		.select({ chipBalance: user.chipBalance })
		.from(user)
		.where(eq(user.id, locals.user.id))
		.limit(1);

	if (!userRow) {
		return new Response(JSON.stringify({ error: 'USER_NOT_FOUND' }), {
			status: 500,
			headers: { 'Content-Type': 'application/json' },
		});
	}

	return new Response(JSON.stringify({ balance: userRow.chipBalance }), {
		headers: { 'Content-Type': 'application/json' },
	});
};
