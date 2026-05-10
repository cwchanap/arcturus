import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';
import { generateRoomCode } from '../../../../lib/mp-poker/roomCode';
import { roomExists } from '../../../../lib/mp-poker/roomExists';
import { createDb } from '../../../../lib/db';
import { mpMembership } from '../../../../db/schema';

export const POST: APIRoute = async ({ locals, request }) => {
	const user = locals.user;
	if (!user) return new Response(JSON.stringify({ error: 'UNAUTHORIZED' }), { status: 401 });

	const db = createDb(locals.runtime.env.DB);
	const env = locals.runtime.env;

	// Atomically acquire a membership lock before creating the DO.
	// Using INSERT … ON CONFLICT DO NOTHING prevents the TOCTOU race where
	// concurrent POST /mp/rooms requests all pass a SELECT check and each
	// creates an orphaned DO. The userId primary key ensures at most one row.
	const code = generateRoomCode();
	try {
		await db
			.insert(mpMembership)
			.values({ userId: user.id, roomCode: code, joinedAt: new Date() })
			.onConflictDoNothing()
			.run();
	} catch {
		return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
	}
	// Re-read to confirm we own the lock (vs a conflicting row for another room)
	let lockRow = await db.select().from(mpMembership).where(eq(mpMembership.userId, user.id)).get();
	if (lockRow && lockRow.roomCode !== code) {
		// Existing lock references a different room.  Check whether that room
		// actually still exists — if the DO was never created or has been
		// evicted, the lock is stale and should be cleaned up so the user
		// isn't permanently blocked from multiplayer.
		// Only treat a definitive 404 as stale. Transient errors (5xx,
		// timeout) return 'unknown' and the lock is preserved to avoid
		// breaking the one-room escrow invariant.
		if (env.arcturus) {
			// Guard: if the lock was acquired very recently, the DO may
			// simply not have been initialised yet (e.g. a concurrent
			// double-submit from the same user).  Treat it as in-progress
			// rather than stale so we don't delete a valid lock.
			const IN_PROGRESS_GRACE_MS = 30_000; // 30 seconds
			const lockAge = Date.now() - lockRow.joinedAt.getTime();
			if (lockAge < IN_PROGRESS_GRACE_MS) {
				// Lock is too recent — assume the other request is still
				// initialising the DO.  Refuse this request.
				return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
			}

			const status = await roomExists(env.arcturus, lockRow.roomCode);
			if (status === 'gone') {
				// Scope delete to the specific stale roomCode so a concurrent
				// request that already replaced the row doesn't get clobbered.
				await db
					.delete(mpMembership)
					.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, lockRow.roomCode)))
					.run();
				// Re-acquire the lock with our new room code; use
				// onConflictDoNothing to avoid clobbering a lock another
				// concurrent request already inserted, then re-read.
				await db
					.insert(mpMembership)
					.values({ userId: user.id, roomCode: code, joinedAt: new Date() })
					.onConflictDoNothing()
					.run();
				lockRow = await db
					.select()
					.from(mpMembership)
					.where(eq(mpMembership.userId, user.id))
					.get();
			}
		}
	}
	if (!lockRow || lockRow.roomCode !== code) {
		return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), { status: 409 });
	}

	let body: { maxSeats: number; smallBlind: number; bigBlind: number };
	try {
		body = (await request.json()) as { maxSeats: number; smallBlind: number; bigBlind: number };
	} catch {
		// Clean up membership lock on validation failure
		await db
			.delete(mpMembership)
			.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
			.run();
		return new Response(JSON.stringify({ error: 'INVALID_JSON' }), { status: 400 });
	}
	if (
		!body ||
		typeof body !== 'object' ||
		typeof body.maxSeats !== 'number' ||
		typeof body.smallBlind !== 'number' ||
		typeof body.bigBlind !== 'number' ||
		!Number.isInteger(body.maxSeats) ||
		!Number.isInteger(body.smallBlind) ||
		!Number.isInteger(body.bigBlind) ||
		body.maxSeats < 2 ||
		body.maxSeats > 6 ||
		body.smallBlind < 1 ||
		body.bigBlind < body.smallBlind * 2
	) {
		// Clean up membership lock on validation failure
		await db
			.delete(mpMembership)
			.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
			.run();
		return new Response(JSON.stringify({ error: 'INVALID_CONFIG' }), { status: 400 });
	}
	if (!env.arcturus) {
		// Clean up membership lock — DO unavailable
		await db
			.delete(mpMembership)
			.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
			.run();
		return new Response(JSON.stringify({ error: 'DO_UNAVAILABLE' }), { status: 503 });
	}

	// We already have a room code from the membership lock above.
	// Try the DO init with that code; if it collides, retry with new codes
	// (updating the membership row to match).
	for (let attempt = 0; attempt < 5; attempt++) {
		const attemptCode = attempt === 0 ? code : generateRoomCode();
		const id = env.arcturus.idFromName(attemptCode);
		const stub = env.arcturus.get(id);
		let res: Response;
		try {
			res = await stub.fetch('http://do/init', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					maxSeats: body.maxSeats,
					smallBlind: body.smallBlind,
					bigBlind: body.bigBlind,
					hostUserId: user.id,
					roomCode: attemptCode,
				}),
			});
		} catch {
			// Clean up membership lock — DO fetch threw
			await db
				.delete(mpMembership)
				.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
				.run();
			return new Response(JSON.stringify({ error: 'DO_UNAVAILABLE' }), { status: 502 });
		}
		if (res.ok) {
			// Update membership row to the final code if it changed
			if (attemptCode !== code) {
				await db
					.update(mpMembership)
					.set({ roomCode: attemptCode })
					.where(eq(mpMembership.userId, user.id))
					.run();
			}
			return new Response(JSON.stringify({ code: attemptCode }), { status: 201 });
		}
		if (res.status !== 409) {
			const err = await res.text();
			// Clean up membership lock — DO rejected init
			await db
				.delete(mpMembership)
				.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
				.run();
			return new Response(err, {
				status: 502,
				headers: { 'Content-Type': 'application/json' },
			});
		}
		// 409 = code collision, retry with new code
	}
	// Exhausted retries — clean up membership lock
	await db
		.delete(mpMembership)
		.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
		.run();
	return new Response(JSON.stringify({ error: 'CODE_GENERATION_FAILED' }), { status: 500 });
};
