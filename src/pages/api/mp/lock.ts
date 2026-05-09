import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { mpMembership } from '../../../db/schema';

export const POST: APIRoute = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
	const body = (await request.json()) as { action: 'acquire' | 'release'; roomCode?: string };
	const db = createDb(locals.runtime.env.DB);

	if (body.action === 'release') {
		await db.delete(mpMembership).where(eq(mpMembership.userId, user.id)).run();
		return new Response(JSON.stringify({ ok: true }));
	}

	if (body.action === 'acquire') {
		if (!body.roomCode) {
			return new Response(JSON.stringify({ error: 'MISSING_ROOM' }), { status: 400 });
		}
		const existing = await db
			.select()
			.from(mpMembership)
			.where(eq(mpMembership.userId, user.id))
			.get();
		if (existing && existing.roomCode !== body.roomCode) {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
		}
		if (!existing) {
			await db
				.insert(mpMembership)
				.values({ userId: user.id, roomCode: body.roomCode, joinedAt: new Date() })
				.run();
		}
		return new Response(JSON.stringify({ ok: true }));
	}
	return new Response(JSON.stringify({ error: 'BAD_ACTION' }), { status: 400 });
};
