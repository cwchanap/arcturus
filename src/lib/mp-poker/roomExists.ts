/**
 * Result of checking whether a Durable Object room exists.
 *
 * - `'exists'` — DO responded with 200 (room is live).
 * - `'gone'`   — DO responded with 404 (room was evicted / never created).
 * - `'unknown'` — transient error (5xx, timeout, network). Caller must
 *                 preserve the lock and NOT treat this as stale.
 */
export type RoomExistsResult = 'exists' | 'gone' | 'unknown';

/**
 * Check whether a Durable Object room actually exists by pinging its
 * `/metadata` endpoint.
 *
 * Only a definitive 404 is treated as "room gone".  5xx responses,
 * timeouts, and network errors return `'unknown'` so callers preserve
 * the membership lock rather than breaking the one-room escrow invariant.
 */
export async function roomExists(
	arcturusNamespace: DurableObjectNamespace,
	roomCode: string,
): Promise<RoomExistsResult> {
	try {
		const id = arcturusNamespace.idFromName(roomCode);
		const stub = arcturusNamespace.get(id);
		const res = await stub.fetch('http://do/metadata', {
			signal: AbortSignal.timeout(3_000),
		});
		if (res.ok) return 'exists';
		if (res.status === 404) return 'gone';
		// 5xx or other non-200 status — treat as inconclusive.
		return 'unknown';
	} catch {
		// Timeout or network error — treat as inconclusive.
		return 'unknown';
	}
}
