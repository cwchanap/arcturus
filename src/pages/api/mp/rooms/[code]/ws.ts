import type { APIRoute } from 'astro';
import { createDb } from '../../../../../lib/db';
import { mpMembership } from '../../../../../db/schema';
import { and, eq } from 'drizzle-orm';
import { isValidRoomCode } from '../../../../../lib/mp-poker/roomCode';
import {
	acquireMultiplayerMembership,
	hasActiveRankedSession,
	reconcileMultiplayerMembership,
} from '../../../../../server/mp/membership';

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

	// Enforce ranked exclusion and single-room membership before upgrading.
	const db = createDb(locals.runtime.env.DB);
	const env = locals.runtime.env;
	if (await hasActiveRankedSession(env.DB, user.id)) {
		return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const membership = await reconcileMultiplayerMembership({
		db: env.DB,
		namespace: env.arcturus,
		userId: user.id,
		allowedRoomCode: code,
	});
	if (membership.kind === 'conflict' || membership.kind === 'orphaned') {
		return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const existingRoomMatch = membership.kind === 'same-room';
	let acquisition: Awaited<ReturnType<typeof acquireMultiplayerMembership>>;
	try {
		acquisition = await acquireMultiplayerMembership({
			db: env.DB,
			userId: user.id,
			roomCode: code,
		});
	} catch (err) {
		console.error(`[ws] DB insert failed for user=${user.id} code=${code}:`, err);
		return new Response(JSON.stringify({ error: 'DB_ERROR' }), { status: 500 });
	}
	if (acquisition.kind === 'blocked') {
		return new Response(JSON.stringify({ error: 'ALREADY_IN_ROOM' }), {
			status: 409,
			headers: { 'Content-Type': 'application/json' },
		});
	}
	const lockAcquired = acquisition.kind === 'acquired';

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
	headers.set('x-arcturus-display-name', encodeURIComponent(user.name || 'Player'));

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

	// If the DO rejected the upgrade, clean up the membership row when the DO
	// returned a deterministic 4xx response (room gone, bad auth, etc.) — the DO
	// definitively rejected the request, so no escrow was set up and no socket
	// was accepted. On transient failures (5xx, timeouts) the room may still
	// hold escrowed chips or an accepted WebSocket; deleting the lock would let
	// the user join another room and double-spend via the new room's snapshot.
	if (doRes.status !== 101) {
		const is4xx = doRes.status >= 400 && doRes.status < 500;
		const shouldCleanup = is4xx && (lockAcquired || existingRoomMatch);
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
