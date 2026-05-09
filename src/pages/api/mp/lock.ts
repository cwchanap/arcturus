import type { APIRoute } from 'astro';
import { eq } from 'drizzle-orm';
import { createDb } from '../../../lib/db';
import { mpMembership } from '../../../db/schema';

export const POST: APIRoute = async ({ locals, request }) => {
	const db = createDb(locals.runtime.env.DB);

	// Determine userId: either from session auth (client) or DO service auth
	let userId: string | undefined;
	const mpSecret = locals.runtime.env.MP_AUTH_SECRET;
	const serviceAuth = request.headers.get('x-arcturus-auth');
	const serviceUserId = request.headers.get('x-arcturus-user-id');
	if (mpSecret && serviceAuth === mpSecret && serviceUserId) {
		// Service-to-service call from DO
		userId = serviceUserId;
	} else {
		// Client session auth
		const user = locals.user;
		if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
		userId = user.id;
	}

	let body: { action: 'acquire' | 'release'; roomCode?: string };
	try {
		body = (await request.json()) as { action: 'acquire' | 'release'; roomCode?: string };
	} catch {
		return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
	}
	if (!body || typeof body !== 'object' || !('action' in body)) {
		return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
	}
	if (body.action !== 'acquire' && body.action !== 'release') {
		return new Response(JSON.stringify({ error: 'BAD_ACTION' }), { status: 400 });
	}

	if (body.action === 'release') {
		await db.delete(mpMembership).where(eq(mpMembership.userId, userId)).run();
		return new Response(JSON.stringify({ ok: true }));
	}

	if (body.action === 'acquire') {
		if (!body.roomCode) {
			return new Response(JSON.stringify({ error: 'MISSING_ROOM' }), { status: 400 });
		}
		const existing = await db
			.select()
			.from(mpMembership)
			.where(eq(mpMembership.userId, userId))
			.get();
		if (existing && existing.roomCode !== body.roomCode) {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
		}
		if (!existing) {
			await db
				.insert(mpMembership)
				.values({ userId: userId, roomCode: body.roomCode, joinedAt: new Date() })
				.run();
		}
		return new Response(JSON.stringify({ ok: true }));
	}
	return new Response(JSON.stringify({ error: 'BAD_ACTION' }), { status: 400 });
};
