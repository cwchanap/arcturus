import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { createDb } from '../../../lib/db';
import { mpMembership } from '../../../db/schema';
import {
	acquireMultiplayerMembership,
	hasActiveRankedSession,
	reconcileMultiplayerMembership,
} from '../../../server/mp/membership';

export const lockBodySchema = z.discriminatedUnion('action', [
	z.object({
		action: z.literal('acquire'),
		roomCode: z.string().min(1),
	}),
	z.object({
		action: z.literal('release'),
		roomCode: z.string().min(1),
	}),
]);

export const POST: APIRoute = async ({ locals, request }) => {
	const db = createDb(locals.runtime.env.DB);

	// Determine userId: either from session auth (client) or DO service auth
	let userId: string | undefined;
	const mpSecret = locals.runtime.env.MP_AUTH_SECRET;
	const serviceAuth = request.headers.get('x-arcturus-auth');
	const serviceUserId = request.headers.get('x-arcturus-user-id');
	const trimmedServiceUserId = serviceUserId?.trim();
	if (
		mpSecret &&
		serviceAuth === mpSecret &&
		trimmedServiceUserId &&
		trimmedServiceUserId.length > 0
	) {
		// Service-to-service call from DO
		userId = trimmedServiceUserId;
	} else {
		// Client session auth
		const user = locals.user;
		if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });
		userId = user.id;
	}

	let parsed: z.infer<typeof lockBodySchema>;
	try {
		parsed = lockBodySchema.parse(await request.json());
	} catch {
		return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
	}

	if (parsed.action === 'release') {
		// Only the DO service may release a membership lock.
		// Session-authenticated users must leave via the DO (leave_seat / disconnect alarm)
		// which calls releaseMembership() with service auth. Allowing clients to release
		// directly would let them delete their lock while still seated, bypassing the
		// one-room-per-user constraint.
		if (!serviceAuth || serviceAuth !== mpSecret) {
			return new Response(JSON.stringify({ error: 'FORBIDDEN' }), { status: 403 });
		}
		// Scope the delete to the specific roomCode to prevent a DO for room A
		// from accidentally wiping a membership lock that user X acquired for room B
		// after leaving A.
		await db
			.delete(mpMembership)
			.where(and(eq(mpMembership.userId, userId!), eq(mpMembership.roomCode, parsed.roomCode)))
			.run();
		return new Response(JSON.stringify({ ok: true }));
	}

	if (parsed.action === 'acquire') {
		if (!parsed.roomCode) {
			return new Response(JSON.stringify({ error: 'MISSING_ROOM' }), { status: 400 });
		}
		if (await hasActiveRankedSession(locals.runtime.env.DB, userId)) {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
		}
		const membership = await reconcileMultiplayerMembership({
			db: locals.runtime.env.DB,
			namespace: locals.runtime.env.arcturus,
			userId,
			allowedRoomCode: parsed.roomCode,
		});
		if (membership.kind === 'conflict' || membership.kind === 'orphaned') {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
		}

		const acquisition = await acquireMultiplayerMembership({
			db: locals.runtime.env.DB,
			userId,
			roomCode: parsed.roomCode,
		});
		if (acquisition.kind === 'blocked') {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
		}
		// Confirm ownership again at the route boundary before reporting success.
		const actual = await db
			.select()
			.from(mpMembership)
			.where(eq(mpMembership.userId, userId))
			.get();
		if (!actual || actual.roomCode !== parsed.roomCode) {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
		}
		return new Response(JSON.stringify({ ok: true }));
	}
	const _exhaustive: never = parsed.action;
	return new Response(JSON.stringify({ error: 'BAD_ACTION', action: _exhaustive }), {
		status: 400,
	});
};
