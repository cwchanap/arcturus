import type { APIRoute } from 'astro';
import { createDb } from '../../../../../lib/db';
import { mpMembership } from '../../../../../db/schema';
import { and, eq } from 'drizzle-orm';
import { isValidRoomCode } from '../../../../../lib/mp-poker/roomCode';
import { roomExists } from '../../../../../lib/mp-poker/roomExists';

export const GET: APIRoute = async ({ params, request, locals, url }) => {
	const code = params.code;
	if (!code || !isValidRoomCode(code)) return new Response('Bad code', { status: 400 });
	const user = locals.user;
	if (!user) return new Response('Unauthorized', { status: 401 });

	// Reject cross-origin WebSocket upgrades to prevent CSRF-style attacks
	const origin = request.headers.get('Origin');
	if (origin) {
		try {
			const originHost = new URL(origin).host;
			const requestHost = url.host || request.headers.get('Host');
			if (requestHost && originHost !== requestHost) {
				return new Response('Forbidden', { status: 403 });
			}
		} catch {
			// Malformed Origin header — reject
			return new Response('Forbidden', { status: 403 });
		}
	}

	if (request.headers.get('Upgrade') !== 'websocket') {
		return new Response('Expected websocket', { status: 426 });
	}

	// Enforce single-room lock: user must not be in another room
	const db = createDb(locals.runtime.env.DB);
	let existing = await db.select().from(mpMembership).where(eq(mpMembership.userId, user.id)).get();
	if (existing && existing.roomCode !== code) {
		// Existing lock references a different room. Check whether that room
		// actually still exists — if the DO was evicted/never created, the
		// lock is stale and should be cleaned up so the user isn't
		// permanently blocked from joining other rooms via URL.
		const env = locals.runtime.env;
		if (env.arcturus) {
			// Grace period: if the lock was acquired recently, the other room's
			// DO may still be initialising. Don't treat it as stale.
			const IN_PROGRESS_GRACE_MS = 30_000;
			const lockAge = Date.now() - existing.joinedAt.getTime();
			if (lockAge >= IN_PROGRESS_GRACE_MS) {
				const status = await roomExists(env.arcturus, existing.roomCode);
				if (status === 'gone') {
					// Scope delete to the specific stale roomCode so a concurrent
					// request that already replaced the row doesn't get clobbered.
					await db
						.delete(mpMembership)
						.where(
							and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, existing.roomCode)),
						)
						.run();
					// Mark as cleared so the next block re-acquires for the target room.
					existing = undefined;
				} else {
					return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), {
						status: 409,
						headers: { 'Content-Type': 'application/json' },
					});
				}
			} else {
				return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), {
					status: 409,
					headers: { 'Content-Type': 'application/json' },
				});
			}
		} else {
			return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), {
				status: 409,
				headers: { 'Content-Type': 'application/json' },
			});
		}
	}

	// Acquire the membership lock BEFORE upgrading to prevent TOCTOU races
	// where two concurrent joins both pass the `existing` check.
	let lockAcquired = false;
	if (!existing) {
		try {
			await db
				.insert(mpMembership)
				.values({ userId: user.id, roomCode: code, joinedAt: new Date() })
				.run();
			lockAcquired = true;
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes('UNIQUE constraint failed') || msg.includes('unique')) {
				// Unique constraint violation — two concurrent inserts for the same user.
				// Re-read to distinguish same-room (valid reconnect/tab) from another-room.
				const collision = await db
					.select()
					.from(mpMembership)
					.where(eq(mpMembership.userId, user.id))
					.get();
				if (collision && collision.roomCode === code) {
					// Same room — allow the reconnect
					lockAcquired = false; // lock was acquired by the first request
				} else {
					return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), {
						status: 409,
						headers: { 'Content-Type': 'application/json' },
					});
				}
			} else {
				// Unexpected DB error — log and surface
				console.error(`[ws] DB insert failed for user=${user.id} code=${code}:`, err);
				return new Response(JSON.stringify({ error: 'DB_ERROR' }), { status: 500 });
			}
		}
	}

	const env = locals.runtime.env;
	if (!env.arcturus) {
		// Clean up the membership lock we just acquired to avoid leaving a stale row
		if (lockAcquired) {
			try {
				await db
					.delete(mpMembership)
					.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
					.run();
			} catch (err) {
				console.error(
					`[ws] Failed to clean up membership for user=${user.id} code=${code} (DO unavailable):`,
					err,
				);
			}
		}
		return new Response(JSON.stringify({ error: 'DO_UNAVAILABLE' }), { status: 503 });
	}
	const id = env.arcturus.idFromName(code);
	const stub = env.arcturus.get(id);
	const headers = new Headers();
	for (const [key, value] of request.headers.entries()) {
		if (!key.toLowerCase().startsWith('x-arcturus-')) {
			headers.set(key, value);
		}
	}
	headers.set('x-arcturus-user-id', user.id);
	headers.set('x-arcturus-display-name', encodeURIComponent(user.name));

	let doRes: Response;
	try {
		doRes = await stub.fetch('http://do/ws', { headers });
	} catch (err) {
		// DO threw (e.g. internal error during upgrade) — clean up membership lock
		if (lockAcquired) {
			try {
				await db
					.delete(mpMembership)
					.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
					.run();
			} catch (cleanupErr) {
				console.error(
					`[ws] Failed to clean up membership for user=${user.id} code=${code} (DO threw):`,
					cleanupErr,
				);
			}
		}
		console.error(`[ws] DO fetch threw for user=${user.id} code=${code}:`, err);
		return new Response(JSON.stringify({ error: 'DO_ERROR' }), { status: 502 });
	}

	// If the DO rejected the upgrade, only clean up the membership row when
	// the DO confirmed the room is definitively gone (404). On transient failures
	// (5xx, timeouts) the room may still hold escrowed chips or an accepted
	// WebSocket; deleting the lock would let the user join another room and
	// double-spend via the new room's snapshot.
	if (doRes.status !== 101) {
		const isRoomDefinitivelyGone = doRes.status === 404;
		const shouldCleanup =
			isRoomDefinitivelyGone &&
			(lockAcquired || (existing !== undefined && existing.roomCode === code));
		if (shouldCleanup) {
			try {
				// Release any escrowed chips before deleting the membership lock.
				// The /api/mp/release-escrow endpoint scopes releases by roomCode
				// via mp_membership; deleting the row first would leave heldChips
				// permanently stuck. Scope the UPDATE to the expected roomCode so
				// a concurrent request that already moved the user to a different
				// room doesn't have its new escrow released.
				const nowSeconds = Math.trunc(Date.now() / 1000);
				await locals.runtime.env.DB.prepare(
					'UPDATE user SET chipBalance = chipBalance + heldChips, heldChips = 0, updatedAt = ? ' +
						'WHERE id = ? AND heldChips > 0 ' +
						'AND EXISTS (SELECT 1 FROM mp_membership WHERE userId = ? AND roomCode = ?)',
				)
					.bind(nowSeconds, user.id, user.id, code)
					.run();
				// Scope delete to the expected roomCode so a concurrent request
				// that already replaced the membership to a different room doesn't
				// lose its valid lock.
				await db
					.delete(mpMembership)
					.where(and(eq(mpMembership.userId, user.id), eq(mpMembership.roomCode, code)))
					.run();
			} catch (err) {
				console.error(
					`[ws] Failed to clean up membership for user=${user.id} code=${code} doStatus=${doRes.status}:`,
					err,
				);
			}
		}
	}

	return doRes;
};
