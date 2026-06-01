import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { roomExists } from '../../../lib/mp-poker/roomExists';
import { createDb } from '../../../lib/db';
import { mpMembership } from '../../../db/schema';

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
		// Atomic upsert: avoid TOCTOU race where two concurrent requests both see no row
		// and the second insert fails with a primary-key constraint violation (500).
		await db
			.insert(mpMembership)
			.values({ userId: userId, roomCode: parsed.roomCode, joinedAt: new Date() })
			.onConflictDoNothing()
			.run();
		// Re-read to check actual state after upsert
		let actual = await db.select().from(mpMembership).where(eq(mpMembership.userId, userId)).get();
		if (actual && actual.roomCode !== parsed.roomCode) {
			// Existing lock references a different room.  Check whether that
			// room still exists — if the DO was never created or has been
			// evicted, the lock is stale and should be cleaned up so the user
			// isn't permanently blocked from joining a new room.
			// Only treat a definitive 404 as stale. Transient errors (5xx,
			// timeout) return 'unknown' and the lock is preserved to avoid
			// breaking the one-room escrow invariant.
			const arcturusNs = locals.runtime.env.arcturus;
			if (arcturusNs) {
				// Grace period: if the lock was acquired recently, the other room's
				// DO may still be initialising. Don't treat it as stale.
				const IN_PROGRESS_GRACE_MS = 30_000;
				const lockAge = Date.now() - actual.joinedAt.getTime();
				if (lockAge >= IN_PROGRESS_GRACE_MS) {
					const status = await roomExists(arcturusNs, actual.roomCode);
					if (status === 'gone') {
						await db
							.delete(mpMembership)
							.where(
								and(eq(mpMembership.userId, userId!), eq(mpMembership.roomCode, actual.roomCode)),
							)
							.run();
						// Re-acquire for the requested room
						await db
							.insert(mpMembership)
							.values({ userId: userId, roomCode: parsed.roomCode, joinedAt: new Date() })
							.onConflictDoNothing()
							.run();
						actual = await db
							.select()
							.from(mpMembership)
							.where(eq(mpMembership.userId, userId))
							.get();
					}
				}
			}
		}
		if (actual && actual.roomCode !== parsed.roomCode) {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
		}
		return new Response(JSON.stringify({ ok: true }));
	}
	const _exhaustive: never = parsed.action;
	return new Response(JSON.stringify({ error: 'BAD_ACTION', action: _exhaustive }), {
		status: 400,
	});
};
